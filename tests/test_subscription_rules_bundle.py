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

    def test_bundle_cli_publishes_private_rules_to_awg_modern_and_legacy_then_removes_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = self.profile()
            config["dns"]["nameserver-policy"]["+.byd.auto"] = default_config()["dns_rules"][0]["servers"]
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
            subprocess.run(command, capture_output=True, text=True, check=True)
            for node in ("desktop", "phone", "legacy"):
                generated = YAML(typ="safe").load((root / "staging" / f"clash-{node}.yaml").read_text())
                self.assertIn("DOMAIN-SUFFIX,business.example,DIRECT", generated["rules"])
                self.assertIn("+.business.example", generated["dns"]["nameserver-policy"])
                self.assertNotIn("+.byd.auto", generated["dns"]["nameserver-policy"])
                expected = "https://223.5.5.5/dns-query" if node == "legacy" else ["https://223.5.5.5/dns-query#DIRECT"]
                self.assertEqual(generated["dns"]["nameserver-policy"]["+.business.example"], expected)
            (root / "rules.json").write_text(json.dumps(normalize_config({})))
            subprocess.run(command, capture_output=True, text=True, check=True)
            for node in ("desktop", "phone", "legacy"):
                generated = YAML(typ="safe").load((root / "staging" / f"clash-{node}.yaml").read_text())
                self.assertNotIn("DOMAIN-SUFFIX,business.example,DIRECT", generated["rules"])
                self.assertNotIn("+.business.example", generated["dns"]["nameserver-policy"])
                self.assertNotIn("+.byd.auto", generated["dns"]["nameserver-policy"])


if __name__ == "__main__":
    unittest.main()
