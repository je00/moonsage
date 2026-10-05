"""Exercise MID DNS authorization at the actual shell publication boundary."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from lib.clash_bundle import (
    add_server_relay_group, apply_legacy_stash_compat, apply_subscription_rules,
    configure_vps_resource_downloads,
)
from lib.server_kit_relay import (
    INBOUND_TAG, OUTBOUND_TAG, VLESS_EMAIL_PREFIX, enable_vless, initialize, render_xray,
)


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "debian_file_manager.sh").read_text(encoding="utf-8")
VERIFY_FUNCTION = SCRIPT[SCRIPT.index("verify_clash_vless_relay_bundle() {"):SCRIPT.index("\nwrite_config() {")]
RENDER_FUNCTION = SCRIPT[SCRIPT.index("render_clash_skeleton() {"):SCRIPT.index("\ninstall_dependencies() {")]
RENDER_PYTHON = RENDER_FUNCTION.split("<<'PYTHON'\n", 1)[1].split("\nPYTHON\n", 1)[0]
EMPTY = {"version": 1, "direct_rules": [], "dns_rules": []}


class MidDNSVerifierTests(unittest.TestCase):
    def state(self, *, match="suffix", servers=None):
        return {**EMPTY, "dns_rules": [{
            "match": match, "value": "private.example", "route": "MID",
            "servers": servers or ["https://1.1.1.1/dns-query"],
        }]}

    def profile(self, state, *, legacy=False):
        config = {
            "proxies": [{
                "name": f"ENDPOINT.MID.{port}", "type": "vless", "port": port,
                "server": "vps.example.net", "uuid": "original-mid-uuid",
            } for port in (443, 2053)],
            "proxy-groups": [
                {"name": "PROXY", "type": "select", "proxies": ["MID"]},
                {"name": "MID", "type": "fallback", "proxies": ["ENDPOINT.MID.443", "ENDPOINT.MID.2053"]},
            ],
            "rule-providers": {"rules": {"type": "http", "url": "https://cdn.example.net/rules"}},
            "dns": {"respect-rules": True, "follow-rule": True,
                    "nameserver": ["https://8.8.8.8/dns-query#PROXY", "https://1.0.0.1/dns-query#PROXY"]},
            "rules": ["IP-CIDR,10.20.0.0/24,DIRECT,no-resolve", "MATCH,PROXY"],
        }
        groups, nodes = add_server_relay_group(
            config, [{"name": "SERVER.RELAY.VLESS.Primary", "uuid": "exit-relay-uuid"}], "vps.example.net",
        )
        apply_subscription_rules(config, state)
        configure_vps_resource_downloads(config, subscription_rules=state)
        if legacy:
            apply_legacy_stash_compat(config, "vps.example.net", preserved_vless_names=nodes,
                                     vless_relay_group_names=groups)
        return config

    def verify(self, config, state, *, explicit=True, raw_rules=None, missing=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "bundle"
            bundle.mkdir()
            (bundle / "clash-test.yaml").write_text(json.dumps(config), encoding="utf-8")
            relay = root / "relay.json"
            relay.write_text('{"enabled":true,"vless_enabled":true}', encoding="utf-8")
            candidate = root / "candidate-rules.json"
            if not missing:
                candidate.write_text(json.dumps(state) if raw_rules is None else raw_rules, encoding="utf-8")
            old = root / "old-rules.json"
            old.write_text(json.dumps(EMPTY), encoding="utf-8")
            env = dict(os.environ, SUBSCRIPTION_RULES_PATH=str(old if explicit else candidate))
            env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
            command = '\nSCRIPT_DIR="$1"\nverify_clash_vless_relay_bundle "$2" "$3" "$4"'
            if explicit:
                command += ' "$5"'
            return subprocess.run([
                "bash", "-c", VERIFY_FUNCTION + command, "mid-dns-verifier-test",
                str(ROOT), str(bundle), str(relay), str(root / "unused-catalog.json"), str(candidate),
            ], text=True, capture_output=True, env=env)

    def test_saved_mid_policy_and_candidate_path_pass_modern_and_legacy(self):
        for legacy in (False, True):
            for match in ("exact", "suffix"):
                for explicit in (False, True):
                    for servers in (["https://1.1.1.1/dns-query"],
                                    ["https://1.1.1.1/dns-query", "https://9.9.9.9/dns-query"],
                                    ["https://[2620:fe::fe]/dns-query", "https://1.1.1.1/dns-query"]):
                        with self.subTest(legacy=legacy, match=match, explicit=explicit, servers=servers):
                            state = self.state(match=match, servers=servers)
                            result = self.verify(self.profile(state, legacy=legacy), state, explicit=explicit)
                            self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_invalid_or_unrelated_private_approval_is_rejected(self):
        state = self.state()
        config = self.profile(state)
        for options in ({"state": EMPTY}, {"state": state, "missing": True},
                        {"state": state, "raw_rules": "{"}, {"state": state, "raw_rules": "{}"},
                        {"state": self.state(match="exact")},
                        {"state": self.state(servers=["https://9.9.9.9/dns-query"])}):
            with self.subTest(options=options):
                self.assertNotEqual(self.verify(config, **options).returncode, 0)

    def test_modern_policy_key_and_complete_servers_must_match(self):
        state = self.state(servers=["https://1.1.1.1/dns-query", "https://9.9.9.9/dns-query"])
        for field in ("other-key", "wrong-match", "subset", "superset", "order", "path", "route"):
            with self.subTest(field=field):
                config = self.profile(state)
                policies = config["dns"]["nameserver-policy"]
                values = policies["+.private.example"]
                if field == "other-key":
                    policies["other.example"] = values.copy()
                elif field == "wrong-match":
                    policies["private.example"] = policies.pop("+.private.example")
                elif field == "subset":
                    values.pop()
                elif field == "superset":
                    values.append("https://149.112.112.112/dns-query#MID")
                elif field == "order":
                    values.reverse()
                elif field == "path":
                    values[0] = "https://1.1.1.1/other#MID"
                else:
                    values[0] = "https://1.1.1.1/dns-query#PROXY"
                self.assertNotEqual(self.verify(config, state).returncode, 0)

    def test_legacy_requires_first_server_projection_without_route_fragment(self):
        state = self.state(servers=["https://9.9.9.9/dns-query", "https://1.1.1.1/dns-query"])
        for value in ("https://1.1.1.1/dns-query", "https://1.1.1.1/dns-query#MID",
                      ["https://9.9.9.9/dns-query", "https://1.1.1.1/dns-query"]):
            with self.subTest(value=value):
                config = self.profile(state, legacy=True)
                config["dns"]["nameserver-policy"]["+.private.example"] = value
                self.assertNotEqual(self.verify(config, state).returncode, 0)

    def test_legacy_single_server_policy_must_be_scalar_not_one_item_list(self):
        state = self.state(servers=["https://9.9.9.9/dns-query"])
        config = self.profile(state, legacy=True)
        self.assertEqual(config["dns"]["nameserver-policy"]["+.private.example"],
                         "https://9.9.9.9/dns-query")
        self.assertEqual(self.verify(config, state).returncode, 0)
        config["dns"]["nameserver-policy"]["+.private.example"] = ["https://9.9.9.9/dns-query"]
        self.assertNotEqual(self.verify(config, state).returncode, 0)

    def test_nonreserved_mid_policy_must_exist_and_match_saved_projection(self):
        state = self.state(servers=["https://9.9.9.9/dns-query", "https://149.112.112.112/dns-query"])
        for legacy in (False, True):
            for field in ("missing", "wrong-key", "wrong-server", "wrong-route", "truncated"):
                with self.subTest(legacy=legacy, field=field):
                    config = self.profile(state, legacy=legacy)
                    policies = config["dns"]["nameserver-policy"]
                    if field == "missing":
                        del policies["+.private.example"]
                    elif field == "wrong-key":
                        policies["private.example"] = policies.pop("+.private.example")
                    elif field == "wrong-server":
                        policies["+.private.example"] = "https://149.112.112.112/dns-query" if legacy else [
                            "https://149.112.112.112/dns-query#MID", "https://9.9.9.9/dns-query#MID",
                        ]
                    elif field == "wrong-route":
                        policies["+.private.example"] = "https://9.9.9.9/dns-query#DIRECT" if legacy else [
                            "https://9.9.9.9/dns-query#DIRECT", "https://149.112.112.112/dns-query#MID",
                        ]
                    else:
                        policies["+.private.example"] = [] if legacy else ["https://9.9.9.9/dns-query#MID"]
                    self.assertNotEqual(self.verify(config, state).returncode, 0)

    def test_effective_mid_resolver_ip_routes_and_follow_flags_are_required(self):
        for server, route, wide in (
            ("https://9.9.9.9/dns-query", "IP-CIDR,9.9.9.9/32,MID,no-resolve", "IP-CIDR,9.9.0.0/16,DIRECT,no-resolve"),
            ("https://[2620:fe::fe]/dns-query", "IP-CIDR6,2620:fe::fe/128,MID,no-resolve", "IP-CIDR6,2620:fe::/32,DIRECT,no-resolve"),
        ):
            for legacy in (False, True):
                for field in ("missing", "redirect", "wider-before", "exact-before", "catch-all-before", "disabled-follow", "missing-follow"):
                    with self.subTest(server=server, legacy=legacy, field=field):
                        state = self.state(servers=[server])
                        config = self.profile(state, legacy=legacy)
                        if field == "missing":
                            config["rules"].remove(route)
                        elif field == "redirect":
                            config["rules"][config["rules"].index(route)] = route.replace(",MID,", ",DIRECT,")
                        elif field == "wider-before":
                            config["rules"].insert(0, wide)
                        elif field == "exact-before":
                            config["rules"].insert(0, route.replace(",MID,", ",DIRECT,"))
                        elif field == "catch-all-before":
                            config["rules"].insert(0, "MATCH,DIRECT")
                        else:
                            flag = "follow-rule" if legacy else "respect-rules"
                            if field == "disabled-follow":
                                config["dns"][flag] = False
                            else:
                                del config["dns"][flag]
                        self.assertNotEqual(self.verify(config, state).returncode, 0)

    def test_mid_first_ip_route_ignores_unrelated_and_later_cidr_rules(self):
        state = self.state(servers=["https://9.9.9.9/dns-query"])
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                config = self.profile(state, legacy=legacy)
                config["rules"].insert(0, "IP-CIDR,10.20.0.0/24,DIRECT,no-resolve")
                config["rules"].append("IP-CIDR,9.9.0.0/16,DIRECT,no-resolve")
                result = self.verify(config, state)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_modern_stash_requires_follow_rule_with_respect_rules_enabled(self):
        state = self.state(servers=["https://9.9.9.9/dns-query"])
        for value in (None, False, "true", 1):
            with self.subTest(value=value):
                config = self.profile(state)
                self.assertIs(config["dns"]["respect-rules"], True)
                if value is None:
                    del config["dns"]["follow-rule"]
                else:
                    config["dns"]["follow-rule"] = value
                self.assertNotEqual(self.verify(config, state).returncode, 0)

    def test_without_saved_mid_new_projection_checks_do_not_change_baseline(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                config = self.profile(EMPTY, legacy=legacy)
                config["dns"]["follow-rule"] = False
                if not legacy:
                    config["dns"]["respect-rules"] = False
                result = self.verify(config, EMPTY)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_approval_does_not_allow_global_or_entry_resource_resolver(self):
        state = self.state()
        for field in ("nameserver", "direct-nameserver", "fallback", "default-nameserver",
                      "proxy-server-nameserver", "proxy-server-nameserver-policy"):
            with self.subTest(field=field):
                config = self.profile(state)
                value = ["https://1.1.1.1/dns-query#MID"]
                config["dns"][field] = {"vps.example.net": value} if field.endswith("policy") else value
                self.assertNotEqual(self.verify(config, state).returncode, 0)

    def test_approval_does_not_allow_missing_or_recursive_mid(self):
        state = self.state()
        for field in ("node", "group", "chain", "identity", "entry-dns", "resolver-route"):
            with self.subTest(field=field):
                config = self.profile(state)
                if field == "node":
                    config["proxies"].pop(0)
                elif field == "group":
                    next(group for group in config["proxy-groups"] if group["name"] == "MID")["proxies"] = ["PROXY"]
                elif field == "chain":
                    config["proxies"][0]["dialer-proxy"] = "PROXY"
                elif field == "identity":
                    config["proxies"][0]["uuid"] = config["proxies"][1]["uuid"] = "exit-relay-uuid"
                elif field == "entry-dns":
                    config["dns"]["nameserver-policy"]["vps.example.net"] = ["https://1.1.1.1/dns-query#MID"]
                else:
                    config["rules"].remove("IP-CIDR,1.1.1.1/32,MID,no-resolve")
                self.assertNotEqual(self.verify(config, state).returncode, 0)

    def test_xray_mid_identity_keeps_vps_freedom_when_business_relay_is_enabled(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            relay, inputs, xray, policy = [root / name for name in ("relay.json", "inputs.json", "xray.json", "policy.json")]
            mid_id = "11111111-1111-4111-8111-111111111111"
            base = {
                "inbounds": [{"tag": tag, "port": port, "protocol": "vless", "settings": {
                    "clients": [{"id": mid_id}],
                }} for tag, port in (("vless-public", 443), ("vless-public-rescue", 2053))],
                "outbounds": [{"tag": "direct", "protocol": "freedom"}],
                "routing": {"rules": []},
            }
            xray.write_text(json.dumps(base), encoding="utf-8")
            inputs.write_text(json.dumps({"version": 4, "airports": [], "default_exit_id": "111111111111",
                "exits": [{"id": "111111111111", "name": "Primary", "proxy": {
                    "type": "socks5", "server": "exit.example.net", "port": 1080,
                }}]}), encoding="utf-8")
            policy.write_text(json.dumps({"version": 1, "clients": {"phone": {
                "uuid": "22222222-2222-4222-8222-222222222222", "enabled": True,
            }}}), encoding="utf-8")
            initialize(relay, 2083)
            enable_vless(relay)
            result = render_xray(relay, inputs, xray, root / "no-peers.tsv", policy)
            self.assertEqual(result["outbounds"][0], base["outbounds"][0])
            self.assertNotIn("proxySettings", result["outbounds"][0])
            for inbound in result["inbounds"]:
                if inbound.get("protocol") != "vless":
                    continue
                clients = inbound["settings"]["clients"]
                self.assertIn({"id": mid_id}, clients)
                business = [client for client in clients if client.get("email", "").startswith(VLESS_EMAIL_PREFIX)]
                self.assertTrue(business)
                self.assertTrue(all(client["id"] != mid_id for client in business))
            business_rules = [rule for rule in result["routing"]["rules"]
                              if rule.get("outboundTag", "").startswith(OUTBOUND_TAG)]
            self.assertTrue(business_rules)
            for rule in business_rules:
                self.assertTrue(rule.get("inboundTag") == [INBOUND_TAG]
                                or (rule.get("user") and all(user.startswith(VLESS_EMAIL_PREFIX) for user in rule["user"])))

    def test_mid_source_never_selects_business_relay_identity(self):
        mid_id = "11111111-1111-4111-8111-111111111111"
        business_id = "22222222-2222-4222-8222-222222222222"
        business = {"id": business_id, "email": VLESS_EMAIL_PREFIX + "other-node:111111111111"}
        managed = {"id": "33333333-3333-4333-8333-333333333333", "email": "server-kit-vless:phone"}
        for has_mid in (True, False):
            with self.subTest(has_mid=has_mid), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                inputs, xray, state, output, summary = [root / name for name in (
                    "inputs.json", "xray.json", "public-state", "output.yaml", "summary.json",
                )]
                inputs.write_text(json.dumps({"version": 4, "airports": [], "default_exit_id": "111111111111",
                    "exits": [{"id": "111111111111", "name": "Primary", "proxy": {
                        "type": "socks5", "server": "exit.example.net", "port": 1080,
                    }}]}), encoding="utf-8")
                xray.write_text(json.dumps({"inbounds": [{
                    "tag": "vless-public", "protocol": "vless", "port": 443, "listen": "vps.example.net",
                    "settings": {"clients": [business, managed] + ([{"id": mid_id}] if has_mid else [])},
                    "streamSettings": {"security": "reality", "realitySettings": {
                        "serverNames": ["sni.example.net"], "shortIds": ["1234abcd"],
                    }},
                }]}), encoding="utf-8")
                state.write_text('VLESS_PUBLIC_REALITY_KEY="synthetic-public-key"\n', encoding="utf-8")
                result = subprocess.run([
                    sys.executable, "-", str(ROOT / "clash_skeleton.yaml"), str(output), str(summary),
                    str(inputs), str(xray), str(root / "no-state"), str(state), str(root / "no-awg"),
                    str(root / "no-xray-binary"), str(ROOT),
                ], input=RENDER_PYTHON, text=True, capture_output=True)
                if has_mid:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(summary.read_text())["vless_template"]["uuid"], mid_id)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("缺少不受管的通用客户端", result.stderr)
                    self.assertFalse(output.exists())
                    self.assertFalse(summary.exists())


if __name__ == "__main__":
    unittest.main()
