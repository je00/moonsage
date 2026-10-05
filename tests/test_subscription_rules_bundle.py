#!/usr/bin/env python3
"""Private exceptions must preserve infrastructure and DNS egress invariants."""

import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from ruamel.yaml import YAML
except ImportError:
    YAML = None

if YAML is not None:
    from lib.clash_bundle import (
        apply_legacy_stash_compat, apply_subscription_rules,
        configure_vps_resource_downloads, prepend_rules,
    )
from lib.server_kit_subscription_rules import SubscriptionRulesError, default_config, normalize_config


@unittest.skipUnless(YAML is not None, "ruamel.yaml unavailable")
class SubscriptionRulesBundleTests(unittest.TestCase):
    def profile(self):
        return {
            "proxies": [{
                "name": f"ENDPOINT.MID.{port}", "type": "vless", "port": port,
                "server": "entry.example.net", "uuid": "test-mid-identity",
            } for port in (443, 2053)],
            "proxy-groups": [
                {"name": "PROXY", "type": "select", "proxies": ["MID"]},
                {"name": "MID", "type": "fallback", "proxies": ["ENDPOINT.MID.443", "ENDPOINT.MID.2053"]},
            ],
            "rule-providers": {"rules": {"type": "http", "url": "https://cdn.example.net/rules"}},
            "dns": {
                "respect-rules": True, "follow-rule": True,
                "nameserver": ["https://8.8.8.8/dns-query#PROXY", "https://1.0.0.1/dns-query#PROXY"],
                "direct-nameserver": ["https://223.5.5.5/dns-query"],
                "nameserver-policy": {"geosite:cn": ["https://223.5.5.5/dns-query"]},
            },
            "rules": ["DOMAIN,entry.example.net,DIRECT", "DOMAIN,existing.example.cn,DIRECT", "MATCH,PROXY"],
        }

    def state(self, route="DIRECT", server="https://223.5.5.5/dns-query"):
        return {"version": 1, "direct_rules": [{"match": "suffix", "value": "business.example"}], "dns_rules": [{
            "match": "suffix", "value": "business.example", "servers": [server], "route": route,
        }]}

    def apply(self, config, state, **kwargs):
        apply_subscription_rules(config, state, protected_networks=["10.20.0.0/24"], **kwargs)

    def test_custom_rules_preserve_normal_dns_and_protected_priority(self):
        config = self.profile()
        before = copy.deepcopy(config)
        self.apply(config, self.state())
        configure_vps_resource_downloads(config)
        prepend_rules(config, ["IP-CIDR,10.20.0.0/24,PRIVATE-phone,no-resolve"])
        self.assertEqual(config["dns"]["nameserver"], before["dns"]["nameserver"])
        self.assertEqual(config["dns"]["nameserver-policy"]["geosite:cn"], before["dns"]["nameserver-policy"]["geosite:cn"])
        self.assertEqual(config["dns"]["nameserver-policy"]["+.business.example"], ["https://223.5.5.5/dns-query#DIRECT"])
        self.assertTrue(config["dns"]["direct-nameserver-follow-policy"])
        self.assertIn("DOMAIN,existing.example.cn,DIRECT", config["rules"])
        custom_index = config["rules"].index("DOMAIN-SUFFIX,business.example,DIRECT")
        for rule in ("IP-CIDR,10.20.0.0/24,PRIVATE-phone,no-resolve", "DOMAIN,entry.example.net,DIRECT", "DOMAIN,cdn.example.net,MID", "IP-CIDR,1.1.1.1/32,MID,no-resolve"):
            self.assertLess(config["rules"].index(rule), custom_index)

    def test_proxy_dns_remains_selected_exit_in_legacy_stash(self):
        config = self.profile()
        self.apply(config, self.state("PROXY", "https://9.9.9.9/dns-query"))
        configure_vps_resource_downloads(config)
        apply_legacy_stash_compat(config, "entry.example.net")
        self.assertEqual(config["dns"]["nameserver-policy"]["+.business.example"], "https://9.9.9.9/dns-query")
        self.assertIn("IP-CIDR,9.9.9.9/32,PROXY,no-resolve", config["rules"])
        self.assertNotIn("direct-nameserver-follow-policy", config["dns"])
        self.assertEqual(config["dns"]["nameserver"], ["https://8.8.8.8/dns-query", "https://1.0.0.1/dns-query"])
        self.assertTrue(config["dns"]["follow-rule"])

    def test_explicit_mid_dns_shares_resource_resolver_without_changing_general_egress(self):
        for legacy in (False, True):
            for server in ("https://1.1.1.1/dns-query", "https://9.9.9.9/dns-query", "https://[2620:fe::fe]/dns-query"):
                with self.subTest(legacy=legacy, server=server):
                    config = self.profile()
                    state = self.state("MID", server)
                    before_dns = copy.deepcopy(config["dns"]["nameserver"])
                    before_proxies = copy.deepcopy(config["proxies"])
                    self.apply(config, state)
                    configure_vps_resource_downloads(config, subscription_rules=state)
                    once = copy.deepcopy(config)
                    self.apply(config, state)
                    configure_vps_resource_downloads(config, subscription_rules=state)
                    self.assertEqual(config, once)
                    self.assertEqual(config["dns"]["nameserver"], before_dns)
                    self.assertEqual(config["proxies"], before_proxies)
                    self.assertEqual(config["dns"]["nameserver-policy"]["cdn.example.net"], ["https://1.1.1.1/dns-query#MID"])
                    if legacy:
                        apply_legacy_stash_compat(config, "entry.example.net")
                    expected = server if legacy else [server + "#MID"]
                    self.assertEqual(config["dns"]["nameserver-policy"]["+.business.example"], expected)
                    self.assertIn("IP-CIDR,1.1.1.1/32,MID,no-resolve", config["rules"])
                    address = "2620:fe::fe" if "[" in server else server.split("/")[2]
                    family, mask = ("IP-CIDR6", 128) if ":" in address else ("IP-CIDR", 32)
                    self.assertIn(f"{family},{address}/{mask},MID,no-resolve", config["rules"])
                    self.assertIn("DOMAIN,entry.example.net,DIRECT", config["rules"])

    def test_mid_requires_independent_entry_even_without_resource_providers(self):
        for invalid in ("missing-group", "missing-node", "chain", "use", "shared-id", "entry-dns", "bootstrap-dns", "entry-ip"):
            with self.subTest(invalid=invalid):
                config = self.profile()
                del config["rule-providers"]
                if invalid == "missing-group":
                    config["proxy-groups"] = config["proxy-groups"][:1]
                elif invalid == "missing-node":
                    config["proxies"].pop()
                elif invalid == "chain":
                    config["proxies"][0]["dialer-proxy"] = "PROXY"
                elif invalid == "use":
                    config["proxy-groups"][1]["use"] = ["airport"]
                elif invalid == "shared-id":
                    config["proxies"].append({"name": "EXIT.Primary", "uuid": "test-mid-identity"})
                elif invalid == "entry-dns":
                    config["dns"]["nameserver-policy"]["entry.example.net"] = ["https://9.9.9.9/dns-query#MID"]
                elif invalid == "bootstrap-dns":
                    config["dns"]["proxy-server-nameserver"] = ["https://9.9.9.9/dns-query#MID"]
                else:
                    for node in config["proxies"]:
                        node["server"] = "9.9.9.9"
                before = copy.deepcopy(config)
                with self.assertRaises(SubscriptionRulesError):
                    self.apply(config, self.state("MID", "https://9.9.9.9/dns-query"))
                self.assertEqual(config, before)
        config = self.profile()
        del config["rule-providers"]
        state = self.state("MID", "https://9.9.9.9/dns-query")
        self.apply(config, state)
        configure_vps_resource_downloads(config, subscription_rules=state)
        self.assertEqual(config["dns"]["nameserver-policy"]["entry.example.net"], [
            "https://223.5.5.5/dns-query#DIRECT", "https://1.12.12.12/dns-query#DIRECT",
        ])
        self.assertIn("IP-CIDR,9.9.9.9/32,MID,no-resolve", config["rules"])

    def test_explicit_mid_does_not_authorize_other_resource_resolver_uses(self):
        state = self.state("MID", "https://1.1.1.1/dns-query")
        for invalid in ("missing-approval", "other-domain", "other-path", "other-route", "global", "fallback", "default", "entry"):
            with self.subTest(invalid=invalid):
                config = self.profile()
                self.apply(config, state)
                if invalid == "other-domain":
                    config["dns"]["nameserver-policy"]["other.example"] = ["https://1.1.1.1/dns-query#MID"]
                elif invalid == "other-path":
                    config["dns"]["nameserver-policy"]["+.business.example"] = ["https://1.1.1.1/other#MID"]
                elif invalid == "other-route":
                    config["dns"]["nameserver-policy"]["+.business.example"] = ["https://1.1.1.1/dns-query#PROXY"]
                elif invalid in ("global", "fallback", "default"):
                    field = {"global": "nameserver", "fallback": "fallback", "default": "default-nameserver"}[invalid]
                    config["dns"][field] = ["https://1.1.1.1/dns-query#MID"]
                elif invalid == "entry":
                    config["dns"]["proxy-server-nameserver"] = ["https://1.1.1.1/dns-query#MID"]
                before = copy.deepcopy(config)
                with self.assertRaises(SystemExit):
                    configure_vps_resource_downloads(config, subscription_rules=None if invalid == "missing-approval" else state)
                self.assertEqual(config, before)

    def test_mid_still_rejects_protected_domains_and_cross_path_ip_conflicts(self):
        for invalid in ("entry-domain", "resource-domain", "existing-proxy", "existing-direct", "direct-cidr"):
            with self.subTest(invalid=invalid):
                config = self.profile()
                state = self.state("MID", "https://9.9.9.9/dns-query")
                if invalid.endswith("domain"):
                    state["dns_rules"][0].update(match="exact", value="entry.example.net" if invalid == "entry-domain" else "cdn.example.net")
                elif invalid == "existing-proxy":
                    config["dns"]["nameserver-policy"]["other.example"] = ["https://9.9.9.9/dns-query#PROXY"]
                elif invalid == "existing-direct":
                    config["rules"].insert(0, "IP-CIDR,9.9.9.0/24,DIRECT,no-resolve")
                else:
                    state["direct_rules"].append({"match": "cidr", "value": "9.9.9.0/24"})
                before = copy.deepcopy(config)
                with self.assertRaises(SubscriptionRulesError):
                    self.apply(config, state)
                self.assertEqual(config, before)

    def test_direct_rules_follow_leading_rejects_without_reordering_template(self):
        config = self.profile()
        original = [
            "DOMAIN,entry.example.net,DIRECT",
            "RULE-SET,reject,REJECT",
            "IP-CIDR,203.0.113.64/26,REJECT,no-resolve",
            "DOMAIN,blocked.example,REJECT-DROP",
            "RULE-SET,private,DIRECT",
            "RULE-SET,lancidr,DIRECT",
            "GEOIP,LAN,DIRECT",
            "NETWORK,udp,PROXY",
            "NETWORK,udp,REJECT",
            "DOMAIN,existing.example.cn,DIRECT",
            "MATCH,PROXY",
        ]
        config["rules"] = original.copy()
        state = self.state()
        state["direct_rules"].append({"match": "cidr", "value": "192.168.50.0/24"})
        self.apply(config, state)
        required_dns = "IP-CIDR,223.5.5.5/32,DIRECT,no-resolve"
        direct = "DOMAIN-SUFFIX,business.example,DIRECT"
        direct_cidr = "IP-CIDR,192.168.50.0/24,DIRECT,no-resolve"
        generated_rules = {required_dns, direct, direct_cidr}
        self.assertEqual([rule for rule in config["rules"] if rule not in generated_rules], original)
        self.assertLess(config["rules"].index(required_dns), config["rules"].index("RULE-SET,reject,REJECT"))
        self.assertLess(config["rules"].index("DOMAIN,blocked.example,REJECT-DROP"), config["rules"].index(direct))
        self.assertLess(config["rules"].index(direct_cidr), config["rules"].index("RULE-SET,private,DIRECT"))
        self.assertLess(config["rules"].index(direct_cidr), config["rules"].index("NETWORK,udp,PROXY"))
        once = copy.deepcopy(config)
        self.apply(config, state)
        self.assertEqual(config, once)

    def test_matching_legacy_direct_duplicates_are_deduplicated_after_reject(self):
        config = self.profile()
        direct = "DOMAIN-SUFFIX,business.example,DIRECT"
        original_noncustom = [
            "DOMAIN,entry.example.net,DIRECT", "RULE-SET,reject,REJECT",
            "GEOIP,LAN,DIRECT", "NETWORK,udp,PROXY", "NETWORK,udp,REJECT", "MATCH,PROXY",
        ]
        config["rules"] = original_noncustom[:2] + [direct] + original_noncustom[2:-1] + [direct, "MATCH,PROXY"]
        state = self.state()
        state["dns_rules"] = []
        self.apply(config, state)
        self.assertEqual(config["rules"].count(direct), 1)
        self.assertEqual([rule for rule in config["rules"] if rule != direct], original_noncustom)
        self.assertLess(config["rules"].index("RULE-SET,reject,REJECT"), config["rules"].index(direct))
        self.assertLess(config["rules"].index(direct), config["rules"].index("GEOIP,LAN,DIRECT"))

    def test_private_numeric_and_ipv6_resolvers_get_explicit_routes(self):
        for server, route, expected in (
            ("192.168.50.1", "DIRECT", "IP-CIDR,192.168.50.1/32,DIRECT,no-resolve"),
            ("fd42:50::1", "DIRECT", "IP-CIDR6,fd42:50::1/128,DIRECT,no-resolve"),
            ("https://[2620:fe::fe]/dns-query", "PROXY", "IP-CIDR6,2620:fe::fe/128,PROXY,no-resolve"),
        ):
            with self.subTest(server=server):
                config = self.profile()
                self.apply(config, self.state(route, server))
                self.assertIn(expected, config["rules"])
                if server == "fd42:50::1":
                    self.assertEqual(config["dns"]["nameserver-policy"]["+.business.example"], ["udp://[fd42:50::1]:53#DIRECT"])
                    apply_legacy_stash_compat(config, "entry.example.net")
                    self.assertEqual(config["dns"]["nameserver-policy"]["+.business.example"], "udp://[fd42:50::1]:53")

    def test_protected_scopes_fail_before_any_mutation(self):
        for kind, match, value in (
            ("dns_rules", "exact", "entry.example.net"),
            ("dns_rules", "suffix", "example.net"),
            ("direct_rules", "exact", "cdn.example.net"),
            ("direct_rules", "suffix", "example.net"),
            ("direct_rules", "cidr", "10.0.0.0/8"),
            ("direct_rules", "cidr", "8.8.8.0/24"),
            ("direct_rules", "cidr", "1.1.1.0/24"),
        ):
            with self.subTest(kind=kind, value=value):
                config = self.profile()
                before = copy.deepcopy(config)
                state = self.state()
                state[kind][0].update(match=match, value=value)
                with self.assertRaises(SubscriptionRulesError):
                    self.apply(config, state)
                self.assertEqual(config, before)

    def test_hosts_wildcards_and_airport_bootstrap_are_protected(self):
        for domain in ("nas.internal.example", "airport.example.org"):
            for kind in ("direct_rules", "dns_rules"):
                with self.subTest(domain=domain, kind=kind):
                    config = self.profile()
                    before = copy.deepcopy(config)
                    state = self.state()
                    state[kind][0].update(match="exact", value=domain)
                    with self.assertRaises(SubscriptionRulesError):
                        self.apply(config, state, protected_hosts={"*.internal.example": "10.20.0.2"}, catalog={"airports": [{"enabled": True, "bootstrap_dns": {"domains": ["airport.example.org"]}}]})
                    self.assertEqual(config, before)

    def test_custom_dns_cannot_change_existing_resolver_role(self):
        for change in ("other-policy", "other-route", "entry-ip", "inner-ip", "direct-overlap"):
            with self.subTest(change=change):
                config = self.profile()
                state = self.state("DIRECT", "https://9.9.9.9/dns-query")
                if change == "other-policy":
                    config["dns"]["nameserver-policy"]["old.example"] = ["https://9.9.9.9/dns-query#PROXY"]
                elif change == "other-route":
                    config["rules"].insert(0, "IP-CIDR,9.9.9.0/24,PROXY,no-resolve")
                elif change == "entry-ip":
                    config["proxies"][0]["server"] = "9.9.9.9"
                elif change == "inner-ip":
                    state["dns_rules"][0]["servers"] = ["10.20.0.1"]
                else:
                    state = self.state("PROXY", "https://9.9.9.9/dns-query")
                    state["direct_rules"] = [{"match": "cidr", "value": "9.9.9.0/24"}]
                before = copy.deepcopy(config)
                with self.assertRaises(SubscriptionRulesError):
                    self.apply(config, state)
                self.assertEqual(config, before)

    def test_named_legacy_resolvers_cannot_be_captured_by_a_direct_exception(self):
        config = self.profile()
        config["dns"]["nameserver"].append("https://resolver.dns.example/dns-query#PROXY")
        before = copy.deepcopy(config)
        state = self.state()
        state["direct_rules"][0]["value"] = "dns.example"
        with self.assertRaises(SubscriptionRulesError):
            self.apply(config, state)
        self.assertEqual(config, before)

    def test_existing_and_overlapping_dns_policy_conflicts_fail_closed(self):
        for key in ("+.business.example", "api.business.example"):
            config = self.profile()
            config["dns"]["nameserver-policy"][key] = ["https://8.8.8.8/dns-query#PROXY"]
            before = copy.deepcopy(config)
            with self.assertRaises(SubscriptionRulesError):
                self.apply(config, self.state())
            self.assertEqual(config, before)
        state = self.state()
        state["dns_rules"].append({"match": "exact", "value": "api.business.example", "servers": ["https://9.9.9.9/dns-query"], "route": "PROXY"})
        with self.assertRaises(SubscriptionRulesError):
            self.apply(self.profile(), state)

    def test_public_default_can_be_replaced_or_deleted_but_custom_policy_is_not_adopted(self):
        for servers in (["https://223.5.5.5/dns-query", "https://1.12.12.12/dns-query"], ["https://223.5.5.5/dns-query#DIRECT", "https://1.12.12.12/dns-query#DIRECT"]):
            config = self.profile()
            config["dns"]["nameserver-policy"]["+.byd.auto"] = servers
            self.apply(config, default_config())
            self.assertEqual(config["dns"]["nameserver-policy"]["+.byd.auto"], ["https://223.5.5.5/dns-query#DIRECT", "https://1.12.12.12/dns-query#DIRECT"])
            self.apply(config, normalize_config({}))
            self.assertNotIn("+.byd.auto", config["dns"]["nameserver-policy"])
        config = self.profile()
        config["dns"]["nameserver-policy"]["+.byd.auto"] = ["https://9.9.9.9/dns-query#PROXY"]
        before = copy.deepcopy(config)
        with self.assertRaises(SubscriptionRulesError):
            self.apply(config, default_config())
        self.assertEqual(config, before)

    def test_round_trip_layout_and_repeated_projection(self):
        yaml = YAML()
        source = "dns:\n  nameserver: ['https://8.8.8.8/dns-query#PROXY']\n  nameserver-policy:\n    # Keep this user's annotation\n    'geosite:cn': ['https://223.5.5.5/dns-query']\nrules:\n  # Business routes below\n  - MATCH,PROXY\n"
        config = yaml.load(source)
        self.apply(config, self.state())
        once = copy.deepcopy(config)
        self.apply(config, self.state())
        self.assertEqual(config, once)
        stream = io.StringIO()
        yaml.dump(config, stream)
        rendered = stream.getvalue()
        self.assertIn("Keep this user's annotation", rendered)
        self.assertIn("Business routes below", rendered)
        self.assertEqual(yaml.load(rendered), config)

    def test_explicit_empty_without_public_default_is_exact_no_op(self):
        config = self.profile()
        before = copy.deepcopy(config)
        self.apply(config, normalize_config({}))
        self.assertEqual(config, before)

    def test_real_template_no_exit_cli_publishes_all_three_dns_paths_then_removes_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = YAML(typ="safe").load((Path(__file__).resolve().parents[1] / "clash_skeleton.yaml").read_text())
            # Use the production DNS/resource template, including its legacy
            # 1.1.1.1#PROXY entries; only deployment identities are synthetic.
            config["proxies"] = self.profile()["proxies"]
            config["proxy-groups"] = self.profile()["proxy-groups"]
            config["proxy-providers"] = {}
            for field in ("nameserver", "direct-nameserver"):
                self.assertIn("https://1.1.1.1/dns-query#PROXY", config["dns"][field])
            with (root / "base.yaml").open("w") as target:
                YAML().dump(config, target)
            (root / "awg.tsv").write_text("desktop\t10.20.0.2\n")
            (root / "awg.conf").write_text("AWG_SUBNET_CIDR=10.20.0.0/24\nAWG_PUBLIC_IP=203.0.113.10\n")
            (root / "policy.json").write_text(json.dumps({"version": 1, "clients": {
                "phone": {"uuid": "phone-test", "enabled": True},
                "legacy": {"uuid": "legacy-test", "enabled": True, "legacy_stash": True},
            }}))
            (root / "summary.json").write_text(json.dumps({"vless_template": {
                "name": "MID", "type": "vless", "server": "entry.example.net", "port": 443,
            }}))
            (root / "inputs.json").write_text(json.dumps({"version": 4, "airports": [], "exits": [], "default_exit_id": "", "awg_exit_selections": {}}))
            (root / "rules.json").write_text(json.dumps(self.state()))
            arguments = {
                "base": "base.yaml", "awg-peer-db": "awg.tsv", "awg-state": "awg.conf",
                "vless-policy": "policy.json", "vless-summary": "summary.json",
                "staging-dir": "staging", "final-dir": "published", "existing-config": "service.json",
                "public-endpoint": "missing-endpoint.json", "publication-state": "missing-publication.json",
                "proxy-inputs": "inputs.json", "node-domains": "missing-domains.json",
                "server-relay": "missing-relay.json", "subscription-rules": "rules.json",
                "output-config": "service.json",
            }
            command = [sys.executable, "-m", "lib.clash_bundle"]
            for key, filename in arguments.items():
                command += ["--" + key, str(root / filename)]
            command += ["--port", "8444", "--server-address", "entry.example.net", "--cert", "/tmp/test-cert", "--key", "/tmp/test-key"]
            for route, server in (("DIRECT", "https://223.5.5.5/dns-query"), ("PROXY", "https://9.9.9.9/dns-query"), ("MID", "https://1.1.1.1/dns-query")):
                (root / "rules.json").write_text(json.dumps(self.state(route, server)))
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, route + ": " + result.stderr)
                for node in ("desktop", "phone", "legacy"):
                    with self.subTest(route=route, node=node):
                        generated = YAML(typ="safe").load((root / "staging" / f"clash-{node}.yaml").read_text())
                        self.assertIn("DOMAIN-SUFFIX,business.example,DIRECT", generated["rules"])
                        self.assertIn("+.business.example", generated["dns"]["nameserver-policy"])
                        self.assertNotIn("+.byd.auto", generated["dns"]["nameserver-policy"])
                        expected = server if node == "legacy" else [server + "#" + route]
                        self.assertEqual(generated["dns"]["nameserver-policy"]["+.business.example"], expected)
                        self.assertIn(f"IP-CIDR,{server.split('/')[2]}/32,{route},no-resolve", generated["rules"])
            (root / "rules.json").write_text(json.dumps(normalize_config({})))
            subprocess.run(command, capture_output=True, text=True, check=True)
            for node in ("desktop", "phone", "legacy"):
                generated = YAML(typ="safe").load((root / "staging" / f"clash-{node}.yaml").read_text())
                self.assertNotIn("DOMAIN-SUFFIX,business.example,DIRECT", generated["rules"])
                self.assertNotIn("+.business.example", generated["dns"]["nameserver-policy"])
                self.assertNotIn("+.byd.auto", generated["dns"]["nameserver-policy"])


if __name__ == "__main__":
    unittest.main()
