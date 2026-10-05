#!/usr/bin/env python3
"""验证 AWG 普通节点和 VLESS 单向节点的订阅差异。"""

from __future__ import annotations

import json
import copy
import hashlib
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from ruamel.yaml import YAML
except ModuleNotFoundError:
    YAML = None

if YAML is not None:
    from lib.clash_bundle import (
        apply_exit_dns_projection, apply_exit_projection, configure_vps_resource_downloads,
    )


REPO_DIR = Path(__file__).resolve().parent.parent
HELPER = REPO_DIR / "lib" / "clash_bundle.py"


@unittest.skipUnless(YAML is not None, "本机没有 ruamel.yaml，跳过往返 YAML 测试")
class ClashBundleTests(unittest.TestCase):
    def resource_config(self) -> dict:
        return {
            "proxies": [{
                "name": f"ENDPOINT.MID.{port}", "type": "vless", "port": port,
                "server": "vps.example.net", "uuid": "unchanged-mid-identity",
            } for port in (443, 2053)],
            "proxy-groups": [
                {"name": "PROXY", "type": "select", "proxies": ["MID"]},
                {"name": "MID", "type": "fallback", "proxies": ["ENDPOINT.MID.443", "ENDPOINT.MID.2053"]},
            ],
            "proxy-providers": {"airport-test": {"type": "http", "url": "https://subscription.example.net/token"}},
            "rule-providers": {"rules": {"type": "http", "url": "https://cdn.example.net/rules"}},
            "dns": {
                "respect-rules": True, "follow-rule": True,
                "nameserver": ["https://1.1.1.1/dns-query#PROXY", "https://8.8.8.8/dns-query#PROXY", "https://1.0.0.1/dns-query#PROXY"],
                "direct-nameserver": ["https://223.5.5.5/dns-query"],
                "nameserver-policy": {"domestic.example.cn": ["https://223.5.5.5/dns-query"]},
            },
            "rules": ["DOMAIN,domestic.example.cn,DIRECT", "IP-CIDR,10.20.0.0/24,DIRECT,no-resolve", "MATCH,PROXY"],
        }

    def test_resource_downloads_use_independent_mid_and_preserve_business_policy(self) -> None:
        config = self.resource_config()
        before = copy.deepcopy(config)
        config["dns"]["nameserver"].append("https://9.9.9.9/dns-query#PROXY")
        configure_vps_resource_downloads(config)
        self.assertEqual(config["proxies"], before["proxies"])
        self.assertEqual(config["proxy-groups"], before["proxy-groups"])
        self.assertEqual(config["dns"]["direct-nameserver"], before["dns"]["direct-nameserver"])
        self.assertEqual(config["dns"]["nameserver"], before["dns"]["nameserver"][1:] + ["https://9.9.9.9/dns-query#PROXY"])
        self.assertEqual(config["dns"]["nameserver-policy"]["domestic.example.cn"], before["dns"]["nameserver-policy"]["domestic.example.cn"])
        self.assertEqual(config["rules"][-3:], before["rules"])
        for section, host in (("proxy-providers", "subscription.example.net"), ("rule-providers", "cdn.example.net")):
            self.assertEqual(next(iter(config[section].values()))["proxy"], "MID")
            self.assertEqual(config["dns"]["nameserver-policy"][host], ["https://1.1.1.1/dns-query#MID"])
            self.assertIn(f"DOMAIN,{host},MID", config["rules"])
        self.assertIn("IP-CIDR,1.1.1.1/32,MID,no-resolve", config["rules"])
        self.assertEqual(config["dns"]["nameserver-policy"]["vps.example.net"], [
            "https://223.5.5.5/dns-query#DIRECT", "https://1.12.12.12/dns-query#DIRECT",
        ])
        projected = copy.deepcopy(config)
        configure_vps_resource_downloads(config)
        self.assertEqual(config, projected)

    def test_resource_bootstrap_rejects_user_policy_conflicts_without_changes(self) -> None:
        for conflict in ("dns-direct", "dns-other", "dns-old-relay", "route-direct", "suffix-direct", "resolver-direct", "provider-direct", "entry-policy"):
            with self.subTest(conflict=conflict):
                config = self.resource_config()
                if conflict.startswith("dns-"):
                    config["dns"]["nameserver-policy"]["cdn.example.net"] = {
                        "dns-direct": ["https://223.5.5.5/dns-query"],
                        "dns-other": ["https://9.9.9.9/dns-query#PROXY"],
                        "dns-old-relay": ["https://1.1.1.1/dns-query#SERVER.RELAY.VLESS.Primary"],
                    }[conflict]
                elif conflict == "route-direct":
                    config["rules"].insert(0, "DOMAIN,cdn.example.net,DIRECT")
                elif conflict == "suffix-direct":
                    config["rules"].insert(0, "DOMAIN-SUFFIX,example.net,DIRECT")
                elif conflict == "resolver-direct":
                    config["rules"].insert(0, "IP-CIDR,1.1.1.1/32,DIRECT,no-resolve")
                elif conflict == "provider-direct":
                    config["rule-providers"]["rules"]["proxy"] = "DIRECT"
                else:
                    config["dns"]["nameserver-policy"]["vps.example.net"] = ["https://8.8.8.8/dns-query#PROXY"]
                before = copy.deepcopy(config)
                with self.assertRaisesRegex(SystemExit, "拒绝覆盖用户配置"):
                    configure_vps_resource_downloads(config)
                self.assertEqual(config, before)

    def test_resource_bootstrap_rejects_recursive_or_ambiguous_mid(self) -> None:
        for invalid in ("chain", "use", "select", "wrong-port", "different-id", "duplicate", "same-host", "same-host-dot", "relay-id", "entry-proxy", "entry-hostname"):
            with self.subTest(invalid=invalid):
                config = self.resource_config()
                if invalid == "chain":
                    config["proxies"][0]["dialer-proxy"] = "PROXY"
                elif invalid == "use":
                    config["proxy-groups"][1]["use"] = ["airport-test"]
                elif invalid == "select":
                    config["proxy-groups"][1]["type"] = "select"
                elif invalid == "wrong-port":
                    config["proxies"][1]["port"] = 443
                elif invalid == "different-id":
                    config["proxies"][1]["uuid"] = "other-id"
                elif invalid == "duplicate":
                    config["proxies"].append(copy.deepcopy(config["proxies"][0]))
                elif invalid == "same-host":
                    config["rule-providers"]["rules"]["url"] = "https://vps.example.net/rules"
                elif invalid == "same-host-dot":
                    config["rule-providers"]["rules"]["url"] = "https://VPS.example.net./rules"
                elif invalid == "relay-id":
                    config["proxies"].append({"name": "SERVER.RELAY.VLESS.Exit.443", "uuid": config["proxies"][0]["uuid"]})
                else:
                    config["dns"]["proxy-server-nameserver"] = [
                        "https://223.5.5.5/dns-query#MID" if invalid == "entry-proxy" else "https://dns.alidns.com/dns-query",
                    ]
                before = copy.deepcopy(config)
                with self.assertRaises(SystemExit):
                    configure_vps_resource_downloads(config)
                self.assertEqual(config, before)

    def test_resource_dns_reservation_preserves_other_direct_and_custom_upstreams(self) -> None:
        config = self.resource_config()
        config["dns"]["direct-nameserver"] = ["https://1.1.1.1/dns-query#PROXY", "https://223.5.5.5/dns-query", "https://9.9.9.9/dns-query#PROXY"]
        configure_vps_resource_downloads(config)
        self.assertEqual(config["dns"]["direct-nameserver"], ["https://223.5.5.5/dns-query", "https://9.9.9.9/dns-query#PROXY"])
        for key in ("nameserver", "direct-nameserver", "fallback", "default-nameserver", "nameserver-policy", "proxy-server-nameserver-policy"):
            with self.subTest(key=key):
                config = self.resource_config()
                config["dns"][key] = {"custom.example.org": ["https://1.1.1.1/dns-query#PROXY"]} if key.endswith("policy") else ["1.1.1.1", "https://9.9.9.9/dns-query#PROXY"]
                before = copy.deepcopy(config)
                with self.assertRaisesRegex(SystemExit, "拒绝覆盖"):
                    configure_vps_resource_downloads(config)
                self.assertEqual(config, before)

    def test_consistent_dns_projection_requires_complete_relay_identity_set(self) -> None:
        records = [{"id": "111111111111", "proxy": {"name": "EXIT.Primary"}}]
        with self.assertRaisesRegex(SystemExit, "缺少匹配的 VLESS 服务端转发身份"):
            apply_exit_dns_projection({"proxies": []}, records, [], {"111111111111"})

    def test_clean_projection_still_rejects_missing_protected_relay_endpoint(self) -> None:
        with self.assertRaisesRegex(SystemExit, "缺少独立的 443 服务端入口"):
            apply_exit_dns_projection(
                {"proxies": []},
                [{"id": "111111111111", "proxy": {"name": "EXIT.Primary"}}],
                [{"name": "SERVER.RELAY.VLESS.Primary", "uuid": "relay-id"}],
                {"111111111111"},
            )

    def test_consistent_dns_projection_rejects_chained_relay_endpoint(self) -> None:
        records = [{"id": "111111111111", "proxy": {"name": "EXIT.Primary"}}]
        relay_nodes = [{"name": "SERVER.RELAY.VLESS.Primary", "uuid": "relay-id"}]
        for endpoint in (
            None,
            {"type": "vless", "port": 443, "uuid": "relay-id", "dialer-proxy": "PROXY"},
            {"type": "vless", "port": 443, "uuid": "wrong-exit-id"},
        ):
            with self.subTest(endpoint=endpoint):
                proxies = [{"name": "EXIT.Primary", "type": "socks5"}]
                if endpoint is not None:
                    proxies.append({"name": "SERVER.RELAY.VLESS.Primary.443", **endpoint})
                with self.assertRaisesRegex(SystemExit, "缺少独立的 443 服务端入口"):
                    apply_exit_dns_projection(
                        {"proxies": proxies}, records, relay_nodes, {"111111111111"}
                    )

    def test_empty_exit_selection_keeps_vps_mid_without_proxy_exit(self) -> None:
        config = {
            "proxies": [
                {"name": "ENDPOINT.MID.443"},
                {"name": "ENDPOINT.MID.2053"},
                {"name": "chain.mid.proxy"},
                {"name": "EXIT.Primary"},
            ],
            "proxy-groups": [
                {"name": "MID", "proxies": ["ENDPOINT.MID.443", "ENDPOINT.MID.2053"]},
                {"name": "PROXY", "proxies": ["EXIT.Primary", "chain.mid.proxy", "MID"]},
            ],
        }
        catalog = {
            "default_exit_id": "111111111111",
            "awg_exit_selections": {"home-direct": []},
            "exits": [{
                "id": "111111111111", "name": "Primary",
                "proxy": {"name": "EXIT.Primary"},
            }],
        }
        self.assertEqual(
            apply_exit_projection(config, catalog, "home-direct", "awg"),
            [],
        )
        self.assertEqual(
            [item["name"] for item in config["proxies"]],
            ["ENDPOINT.MID.443", "ENDPOINT.MID.2053"],
        )
        self.assertEqual(config["proxy-groups"][1]["proxies"], ["MID"])

    def test_awg_and_vless_subscriptions_are_separated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / "base.yaml"
            base.write_text(
                "find-process-mode: always\ntun:\n  enable: true\n  route-exclude-address:\nproxies:\n  - name: ENDPOINT.MID.443\n"
                "    type: vless\n    server: 203.0.113.10\n    port: 443\n"
                "    uuid: generic\n  - name: ENDPOINT.MID.2053\n    type: vless\n"
                "    server: 203.0.113.10\n    port: 2053\n    uuid: generic\n"
                "  - name: EXIT.Primary\n    type: socks5\n    server: exit-one.test\n    port: 1080\n    dialer-proxy: MID\n"
                "  - name: EXIT.Backup\n    type: socks5\n    server: exit-two.test\n    port: 1080\n    dialer-proxy: MID\n"
                "proxy-providers:\n  airport-111111111111:\n    type: http\n"
                "    url: https://example.com/subscription.yaml\n    health-check:\n"
                "      enable: true\n      interval: 300\nproxy-groups:\n  - name: MID\n"
                "    type: fallback\n    proxies: [ENDPOINT.MID.443, ENDPOINT.MID.2053]\n"
                "  - name: PROXY\n    type: select\n    proxies: [EXIT.Primary, EXIT.Backup, MID, 机场 · 主用 · 香港]\n"
                "  - name: 机场 · 主用 · 香港\n    type: url-test\n    use: [airport-111111111111]\n    filter: 香港|HK\n"
                "    url: https://www.gstatic.com/generate_204\nrule-providers:\n"
                "  reject:\n    type: http\n    behavior: domain\n    url: https://example.com/reject.yaml\n"
                "  direct:\n    type: http\n    behavior: domain\n    url: https://example.com/direct.yaml\n"
                "  applications:\n    type: http\n    behavior: classical\n    url: https://example.com/applications.yaml\n"
                "  private:\n    type: http\n    behavior: domain\n    url: https://example.com/private.yaml\n"
                "dns:\n  enhanced-mode: fake-ip\n  respect-rules: true\n  follow-rule: true\n"
                "  proxy-server-nameserver: ['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query']\n"
                "  direct-nameserver: ['https://1.1.1.1/dns-query#PROXY', 'https://8.8.8.8/dns-query#PROXY', 'https://1.0.0.1/dns-query#PROXY']\n"
                "  direct-nameserver-follow-policy: true\n"
                "  nameserver: ['https://1.1.1.1/dns-query#PROXY', 'https://8.8.8.8/dns-query#PROXY', 'https://1.0.0.1/dns-query#PROXY']\n"
                "  nameserver-policy:\n    'geosite:cn': ['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query']\n"
                "    '+.example.com': ['https://9.9.9.9/dns-query#PROXY']\n"
                "rules:\n  - RULE-SET,reject,REJECT\n  - RULE-SET,applications,DIRECT\n"
                "  - RULE-SET,direct,DIRECT\n  - RULE-SET,private,DIRECT\n  - MATCH,PROXY\n",
                encoding="utf-8",
            )
            (root / "awg.tsv").write_text("home-desk\t10.20.0.101\n", encoding="utf-8")
            (root / "awg.conf").write_text(
                "AWG_SUBNET_CIDR=10.20.0.0/24\nAWG_PUBLIC_IP=203.0.113.20\n",
                encoding="utf-8",
            )
            (root / "policy.json").write_text(json.dumps({
                "version": 1,
                "clients": {
                    "home-iphone": {
                        "uuid": "22222222-2222-4222-8222-222222222222",
                        "email": "server-kit-vless:home-iphone",
                        "enabled": True,
                        "allow": [],
                    },
                    "home-iphone6": {
                        "uuid": "33333333-3333-4333-8333-333333333333",
                        "email": "server-kit-vless:home-iphone6",
                        "enabled": True,
                        "legacy_stash": True,
                        "allow": [],
                    },
                },
            }), encoding="utf-8")
            (root / "summary.json").write_text(json.dumps({
                "vless_template": {
                    "name": "ENDPOINT.MID.443",
                    "type": "vless",
                    "server": "203.0.113.10",
                    "port": 443,
                    "uuid": "generic",
                    "tls": True,
                }
            }), encoding="utf-8")
            staging = root / "staging"
            output = root / "service.json"
            (root / "publications.json").write_text(
                '{"version":1,"disabled":[],"clean_mode":["home-desk"]}\n',
                encoding="utf-8",
            )
            (root / "node-domains.json").write_text(json.dumps({
                "version": 1,
                "nodes": {"home-desk": ["*.internal.example", "git.example.com"]},
                "addresses": {"192.168.0.103": ["nas.example.com"]},
            }), encoding="utf-8")
            (root / "public-endpoint.json").write_text('{"schema_version":1,"fqdn":"vpn.example.com"}\n', encoding="utf-8")
            (root / "server-relay.json").write_text(json.dumps({
                "schema_version": 1,
                "enabled": True,
                "shadowsocks_enabled": False,
                "listen": "0.0.0.0",
                "port": 2083,
                "method": "chacha20-poly1305",
                "client_cipher": "chacha20-ietf-poly1305",
                "password": "relay-password-with-enough-entropy",
                "node_name": "SERVER.RELAY",
                "vless_enabled": True,
                "identity_secret": "vless-relay-identity-secret-with-enough-entropy",
                "vless_node_name": "SERVER.RELAY.VLESS",
            }), encoding="utf-8")
            (root / "clash-inputs.json").write_text(json.dumps({
                "version": 4, "airports": [{
                    "id": "111111111111", "name": "主用", "enabled": True,
                    "url": "https://example.com/subscription.yaml", "countries": ["hk"],
                    "bootstrap_dns": {
                        "url_sha256": hashlib.sha256(b"https://example.com/subscription.yaml").hexdigest(),
                        "domains": ["entry.example.net"],
                    },
                }], "default_exit_id": "111111111111",
                "awg_exit_selections": {
                    "home-desk": ["111111111111", "222222222222"],
                    "home-iphone": ["111111111111", "222222222222"],
                },
                "exits": [
                    {"id": "111111111111", "name": "Primary", "proxy": {"name": "EXIT.Primary", "type": "socks5", "server": "exit-one.test", "port": 1080, "dialer-proxy": "MID"}},
                    {"id": "222222222222", "name": "Backup", "proxy": {"name": "EXIT.Backup", "type": "socks5", "server": "exit-two.test", "port": 1080, "dialer-proxy": "MID"}},
                ],
            }), encoding="utf-8")
            command = [
                sys.executable, str(HELPER),
                "--base", str(base),
                "--awg-peer-db", str(root / "awg.tsv"),
                "--awg-state", str(root / "awg.conf"),
                "--public-endpoint", str(root / "public-endpoint.json"),
                "--vless-policy", str(root / "policy.json"),
                "--vless-summary", str(root / "summary.json"),
                "--staging-dir", str(staging),
                "--final-dir", "/srv/subscriptions",
                "--existing-config", str(root / "missing-service.json"),
                "--publication-state", str(root / "publications.json"),
                "--proxy-inputs", str(root / "clash-inputs.json"),
                "--node-domains", str(root / "node-domains.json"),
                "--server-relay", str(root / "server-relay.json"),
                "--output-config", str(output),
                "--port", "8444",
                "--server-address", "vpn.example.com",
                "--relay-address", "vpn.example.com",
                "--cert", "/tmp/cert",
                "--key", "/tmp/key",
            ]
            subprocess.run(command, check=True)

            yaml = YAML(typ="safe")
            awg = yaml.load((staging / "clash-home-desk.yaml").read_text(encoding="utf-8"))
            awg_text = (staging / "clash-home-desk.yaml").read_text(encoding="utf-8")
            self.assertNotIn("PRIVATE-home-desk", [item["name"] for item in awg["proxies"]])
            self.assertNotIn("SERVER.RELAY", [item["name"] for item in awg["proxies"]])
            self.assertNotIn("SERVER.RELAY.VLESS", [item["name"] for item in awg["proxies"]])
            self.assertEqual(
                next(item for item in awg["proxy-groups"] if item["name"] == "PROXY")["proxies"][:2],
                ["SERVER.RELAY.VLESS.Primary", "SERVER.RELAY.VLESS.Backup"],
            )
            self.assertEqual(awg["proxy-groups"][0]["name"], "PROXY")
            self.assertEqual(awg["proxy-groups"][0]["proxies"][0], "SERVER.RELAY.VLESS.Primary")
            dns_relay_nodes = {item["name"]: item for item in awg["proxies"] if item["name"].startswith("SERVER.RELAY.VLESS.")}
            self.assertEqual(len(dns_relay_nodes), 4)
            self.assertEqual(set(dns_relay_nodes), {
                "SERVER.RELAY.VLESS.Primary.443",
                "SERVER.RELAY.VLESS.Primary.2053",
                "SERVER.RELAY.VLESS.Backup.443",
                "SERVER.RELAY.VLESS.Backup.2053",
            })
            self.assertEqual({item["port"] for item in dns_relay_nodes.values()}, {443, 2053})
            self.assertEqual(
                {item["server"] for item in dns_relay_nodes.values()},
                {"vpn.example.com"},
            )
            self.assertEqual(len({item["uuid"] for item in dns_relay_nodes.values()}), 2)
            self.assertTrue(all(item["name"].isascii() for item in dns_relay_nodes.values()))
            self.assertTrue(all(re.fullmatch(r"[0-9a-f-]{36}", item["uuid"]) for item in dns_relay_nodes.values()))
            self.assertNotIn("DNS.RELAY", [item["name"] for item in awg["proxy-groups"]])
            self.assertEqual(
                next(item for item in awg["proxy-groups"] if item["name"] == "SERVER.RELAY.VLESS.Primary")["proxies"],
                ["SERVER.RELAY.VLESS.Primary.443", "SERVER.RELAY.VLESS.Primary.2053"],
            )
            self.assertEqual(
                next(item for item in awg["proxy-groups"] if item["name"] == "SERVER.RELAY.VLESS.Backup")["proxies"],
                ["SERVER.RELAY.VLESS.Backup.443", "SERVER.RELAY.VLESS.Backup.2053"],
            )
            self.assertNotIn(
                next(iter(dns_relay_nodes)),
                next(item for item in awg["proxy-groups"] if item["name"] == "PROXY")["proxies"],
            )
            self.assertEqual(
                {
                    item["name"]: item["server"] for item in awg["proxies"]
                    if item["name"] in {"ENDPOINT.MID.443", "ENDPOINT.MID.2053"}
                },
                {"ENDPOINT.MID.443": "vpn.example.com", "ENDPOINT.MID.2053": "vpn.example.com"},
            )
            self.assertIn("10.20.0.0/24", awg["tun"]["route-exclude-address"])
            self.assertEqual(awg["rules"][1], "IP-CIDR,10.20.0.0/24,DIRECT,no-resolve")
            self.assertIn("DOMAIN,vpn.example.com,DIRECT", awg["rules"])
            self.assertIn("reject", awg["rule-providers"])
            self.assertNotIn("airport-111111111111", awg["proxy-providers"])
            self.assertEqual(awg["rule-providers"]["reject"]["proxy"], "MID")
            awg_group_names = [item["name"] for item in awg["proxy-groups"]]
            self.assertNotIn("机场 · 主用 · 香港", awg_group_names)
            self.assertIn("MID", awg_group_names)
            self.assertNotIn(
                "MID",
                next(item for item in awg["proxy-groups"] if item["name"] == "PROXY")["proxies"],
            )
            self.assertNotIn(
                "chain.mid.proxy",
                next(item for item in awg["proxy-groups"] if item["name"] == "PROXY")["proxies"],
            )
            self.assertEqual(
                next(item for item in awg["proxy-groups"] if item["name"] == "PROXY")["proxies"],
                ["SERVER.RELAY.VLESS.Primary", "SERVER.RELAY.VLESS.Backup"],
            )
            self.assertEqual(len(awg["dns"]["nameserver"]), 2)
            self.assertEqual(awg["dns"]["fake-ip-filter"][0], "vpn.example.com")
            self.assertTrue(awg["dns"]["use-hosts"])
            self.assertEqual(awg["hosts"]["*.internal.example"], "10.20.0.101")
            self.assertEqual(awg["hosts"]["git.example.com"], "10.20.0.101")
            self.assertEqual(awg["hosts"]["nas.example.com"], "192.168.0.103")
            self.assertNotIn("proxy-hosts", awg)
            self.assertRegex(awg_text, r"(?m)^\s*['\"]\*\.internal\.example['\"]:\s+10\.20\.0\.101$")

            vless_text = (staging / "clash-home-iphone.yaml").read_text(encoding="utf-8")
            vless = yaml.load(vless_text)
            self.assertTrue(all(item["name"].isascii() for item in vless["proxies"]))
            private = next(item for item in vless["proxies"] if item["name"] == "PRIVATE-home-iphone")
            self.assertEqual(private["server"], "vpn.example.com")
            self.assertEqual(private["uuid"], "22222222-2222-4222-8222-222222222222")
            self.assertTrue(all(
                item["benchmark-url"] == "http://cp.cloudflare.com/generate_204"
                and item["benchmark-timeout"] == 5
                for item in vless["proxies"]
            ))
            self.assertNotIn("WireGuard-home-iphone", [item["name"] for item in vless["proxies"]])
            self.assertIn(
                "IP-CIDR,10.20.0.0/24,PRIVATE-home-iphone,no-resolve",
                vless["rules"][:2],
            )
            self.assertEqual(set(vless["rule-providers"]), {"applications", "private"})
            self.assertIn("  # reject:\n", vless_text)
            self.assertIn("    # url: https://example.com/reject.yaml\n", vless_text)
            self.assertIn("  # direct:\n", vless_text)
            self.assertIn("  applications:\n", vless_text)
            self.assertIn("  # - RULE-SET,reject,REJECT\n", vless_text)
            self.assertIn("  - RULE-SET,applications,DIRECT\n", vless_text)
            self.assertIn("  # - RULE-SET,direct,DIRECT\n", vless_text)
            self.assertTrue(vless["proxy-providers"]["airport-111111111111"]["health-check"]["enable"])
            self.assertEqual(vless["proxy-providers"]["airport-111111111111"]["benchmark-url"],
                             "http://cp.cloudflare.com/generate_204")
            self.assertEqual(vless["proxy-providers"]["airport-111111111111"]["benchmark-timeout"], 5)
            vless_proxy_members = next(
                item for item in vless["proxy-groups"] if item["name"] == "PROXY"
            )["proxies"]
            self.assertEqual(vless_proxy_members[:2], [
                "SERVER.RELAY.VLESS.Primary", "SERVER.RELAY.VLESS.Backup",
            ])
            self.assertIn("机场 · 主用 · 香港", vless_proxy_members)
            vless_group_names = [item["name"] for item in vless["proxy-groups"]]
            self.assertNotIn("SERVER.RELAY.VLESS", vless_group_names)
            self.assertLess(vless_group_names.index("MID"), vless_group_names.index("机场 · 主用 · 香港"))
            airport_group = next(item for item in vless["proxy-groups"] if item["name"] == "机场 · 主用 · 香港")
            self.assertEqual(
                airport_group["empty-fallback"],
                "REJECT",
            )
            self.assertEqual(airport_group["proxies"], ["REJECT"])
            self.assertIsNotNone(re.search(airport_group["filter"], "REJECT"))
            self.assertIsNone(re.search(airport_group["filter"], "DIRECT"))
            self.assertEqual(vless["dns"]["nameserver-policy"]["entry.example.net"], [
                "https://223.5.5.5/dns-query", "https://1.12.12.12/dns-query",
            ])
            self.assertNotIn("entry.example.net", awg["dns"]["nameserver-policy"])
            self.assertEqual(vless["dns"]["nameserver-policy"]["geosite:cn"], [
                "https://223.5.5.5/dns-query", "https://1.12.12.12/dns-query",
            ])
            self.assertEqual(vless["find-process-mode"], "always")
            self.assertTrue(vless["dns"]["respect-rules"])
            self.assertTrue(vless["dns"]["follow-rule"])
            self.assertEqual(vless["dns"]["fake-ip-filter"][0], "vpn.example.com")
            self.assertTrue(vless["dns"]["use-hosts"])
            self.assertEqual(vless["hosts"]["*.internal.example"], "10.20.0.101")
            self.assertEqual(vless["proxy-hosts"]["*.internal.example"], "10.20.0.101")
            self.assertEqual(vless["proxy-hosts"]["git.example.com"], "10.20.0.101")
            self.assertEqual(vless["hosts"]["nas.example.com"], "192.168.0.103")
            self.assertEqual(vless["proxy-hosts"]["nas.example.com"], "192.168.0.103")
            self.assertEqual(vless["dns"]["proxy-server-nameserver"], [
                "https://223.5.5.5/dns-query#DIRECT",
                "https://1.12.12.12/dns-query#DIRECT",
            ])
            self.assertEqual(vless["dns"]["direct-nameserver"], [
                "https://223.5.5.5/dns-query",
                "https://1.12.12.12/dns-query",
            ])
            self.assertTrue(vless["dns"]["direct-nameserver-follow-policy"])
            self.assertEqual(vless["dns"]["nameserver"], [
                "https://8.8.8.8/dns-query#PROXY",
                "https://1.0.0.1/dns-query#PROXY",
            ])
            self.assertEqual(
                vless["dns"]["nameserver-policy"]["+.example.com"],
                ["https://9.9.9.9/dns-query#PROXY"],
            )
            self.assertEqual(
                vless["dns"]["nameserver-policy"]["example.com"],
                ["https://1.1.1.1/dns-query#MID"],
            )
            self.assertEqual(
                vless["dns"]["nameserver-policy"]["vpn.example.com"],
                [
                    "https://223.5.5.5/dns-query#DIRECT",
                    "https://1.12.12.12/dns-query#DIRECT",
                ],
            )
            self.assertIn("IP-CIDR,1.1.1.1/32,MID,no-resolve", vless["rules"])
            self.assertIn("DOMAIN,example.com,MID", vless["rules"])
            self.assertEqual(vless["proxy-providers"]["airport-111111111111"]["proxy"], "MID")
            self.assertFalse(any(
                rule in vless["rules"]
                for rule in (
                    "IP-CIDR,8.8.8.8/32,SERVER.RELAY.VLESS.Primary,no-resolve",
                    "IP-CIDR,1.0.0.1/32,SERVER.RELAY.VLESS.Primary,no-resolve",
                )
            ))
            for address in ("223.5.5.5", "1.12.12.12"):
                self.assertIn(
                    f"IP-CIDR,{address}/32,DIRECT,no-resolve",
                    vless["rules"],
                )
            self.assertEqual(vless["rules"][-1], "MATCH,PROXY")

            legacy_text = (staging / "clash-home-iphone6.yaml").read_text(encoding="utf-8")
            legacy = yaml.load(legacy_text)
            self.assertNotIn("tun", legacy)
            self.assertTrue(legacy["dns"]["follow-rule"])
            self.assertEqual(legacy["dns"]["enhanced-mode"], "fake-ip")
            self.assertEqual(legacy["dns"]["fake-ip-filter"][0], "vpn.example.com")
            self.assertNotIn("respect-rules", legacy["dns"])
            self.assertNotIn("direct-nameserver", legacy["dns"])
            self.assertNotIn("direct-nameserver-follow-policy", legacy["dns"])
            self.assertEqual(
                legacy["dns"]["proxy-server-nameserver"],
                "https://223.5.5.5/dns-query",
            )
            self.assertEqual(
                legacy["dns"]["nameserver-policy"]["vpn.example.com"],
                "https://223.5.5.5/dns-query",
            )
            self.assertEqual(
                legacy["dns"]["nameserver-policy"]["geosite:cn"],
                "https://223.5.5.5/dns-query",
            )
            self.assertEqual(
                legacy["dns"]["nameserver-policy"]["+.example.com"],
                "https://9.9.9.9/dns-query",
            )
            self.assertEqual(legacy["dns"]["nameserver"], [
                "https://8.8.8.8/dns-query",
                "https://1.0.0.1/dns-query",
            ])
            self.assertEqual({item.get("type") for item in legacy["proxies"]}, {"vless"})
            self.assertTrue(all(
                item["benchmark-url"] == "http://cp.cloudflare.com/generate_204"
                and item["benchmark-timeout"] == 5
                for item in legacy["proxies"]
            ))
            legacy_proxy_names = {item.get("name") for item in legacy["proxies"]}
            self.assertNotIn("chain.mid.proxy", legacy_proxy_names)
            self.assertIn("ENDPOINT.MID.443", legacy_proxy_names)
            self.assertIn("ENDPOINT.MID.2053", legacy_proxy_names)
            legacy_relay_names = {name for name in legacy_proxy_names if isinstance(name, str) and name.startswith("SERVER.RELAY.VLESS.")}
            self.assertEqual(legacy_relay_names, {
                "SERVER.RELAY.VLESS.Primary.443",
                "SERVER.RELAY.VLESS.Primary.2053",
            })
            self.assertEqual(
                {
                    item["server"] for item in legacy["proxies"]
                    if item.get("name") in legacy_relay_names | {"ENDPOINT.MID.443", "ENDPOINT.MID.2053"}
                },
                {"vpn.example.com"},
            )
            self.assertTrue(all(name.isascii() for name in legacy_relay_names))
            self.assertNotIn("SERVER.RELAY.VLESS", legacy_proxy_names)
            legacy_mid = next(item for item in legacy["proxy-groups"] if item["name"] == "MID")
            self.assertEqual(
                legacy_mid["proxies"],
                ["ENDPOINT.MID.443", "ENDPOINT.MID.2053"],
            )
            self.assertNotIn("DNS.RELAY", [item["name"] for item in legacy["proxy-groups"]])
            legacy_relay_members = next(
                item for item in legacy["proxy-groups"] if item["name"] == "SERVER.RELAY.VLESS.Primary"
            )["proxies"]
            self.assertEqual(set(legacy_relay_members), legacy_relay_names)
            self.assertEqual(legacy["proxy-groups"][0]["name"], "PROXY")
            legacy_airport = next(item for item in legacy["proxy-groups"] if item["name"] == "机场 · 主用 · 香港")
            self.assertNotIn("empty-fallback", legacy_airport)
            self.assertEqual(
                legacy_airport["proxies"],
                [next(item for item in legacy["proxy-groups"] if item["name"] == "SERVER.RELAY.VLESS.Primary")["proxies"][0]],
            )
            self.assertNotIn("proxy", legacy["proxy-providers"]["airport-111111111111"])
            self.assertEqual(legacy["proxy-providers"]["airport-111111111111"]["benchmark-url"],
                             "http://cp.cloudflare.com/generate_204")
            self.assertEqual(legacy["proxy-providers"]["airport-111111111111"]["benchmark-timeout"], 5)
            self.assertNotIn("proxy", legacy["rule-providers"]["applications"])
            self.assertEqual(legacy["dns"]["nameserver-policy"]["example.com"], "https://1.1.1.1/dns-query")
            self.assertIn("IP-CIDR,1.1.1.1/32,MID,no-resolve", legacy["rules"])
            self.assertIn("DOMAIN,example.com,MID", legacy["rules"])
            self.assertEqual(
                next(item for item in legacy["proxy-groups"] if item["name"] == "PROXY")["proxies"][:2],
                ["SERVER.RELAY.VLESS.Primary", "MID"],
            )
            self.assertFalse(any("PRIVATE-home-iphone6" in rule for rule in legacy["rules"]))
            self.assertNotIn("route-exclude-address", legacy_text)
            self.assertNotIn("198.51.100.10", awg_text + vless_text + legacy_text)
            service = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(service["server_address"], "vpn.example.com")
            self.assertEqual(
                {item["node_kind"] for item in service["downloads"]},
                {"amneziawg", "vless"},
            )
            self.assertEqual(
                [item["node_kind"] for item in service["downloads"] if item["peer_name"] == "home-iphone"],
                ["vless"],
            )

            # No per-exit opt-in: every managed EXIT uses its corresponding
            # server-side identity, including ordinary non-clean AWG profiles.
            publications = json.loads((root / "publications.json").read_text(encoding="utf-8"))
            publications["clean_mode"] = []
            (root / "publications.json").write_text(json.dumps(publications), encoding="utf-8")
            subprocess.run(command, check=True)
            unfiltered_awg = yaml.load((staging / "clash-home-desk.yaml").read_text(encoding="utf-8"))
            for config in (unfiltered_awg, vless):
                for exit_name in ("Primary", "Backup"):
                    nodes = {item["name"]: item for item in config["proxies"]}
                    endpoint = dict(nodes[f"SERVER.RELAY.VLESS.{exit_name}.443"])
                    endpoint["name"] = f"EXIT.{exit_name}"
                    self.assertEqual(nodes[f"EXIT.{exit_name}"], endpoint)
                    self.assertEqual(endpoint["type"], "vless")
                    self.assertEqual(endpoint["server"], "vpn.example.com")
                    self.assertNotIn("dialer-proxy", endpoint)
                self.assertNotIn("exit-one.test", json.dumps(config))
                self.assertNotIn("exit-two.test", json.dumps(config))
            relay_config = json.loads((root / "server-relay.json").read_text(encoding="utf-8"))
            # Legacy subset/empty/stale IDs cannot opt an exit out. The whole
            # emitted profile is stable: DNS policy, bootstrap and LAN included.
            for legacy_ids in ([], ["111111111111"], ["eeeeeeeeeeee"]):
                relay_config["dns_consistent_exit_ids"] = legacy_ids
                (root / "server-relay.json").write_text(json.dumps(relay_config), encoding="utf-8")
                subprocess.run(command, check=True)
                for name, previous in (("home-desk", unfiltered_awg), ("home-iphone", vless), ("home-iphone6", legacy)):
                    with self.subTest(subscription=name, legacy_ids=legacy_ids):
                        protected = yaml.load((staging / f"clash-{name}.yaml").read_text(encoding="utf-8"))
                        self.assertEqual(protected, previous)
                        self.assertFalse(any(node.get("type") == "socks5" for node in protected["proxies"]))

            publications["clean_mode"] = ["home-desk"]
            (root / "publications.json").write_text(json.dumps(publications), encoding="utf-8")
            subprocess.run(command, check=True)
            protected_clean = yaml.load((staging / "clash-home-desk.yaml").read_text(encoding="utf-8"))
            self.assertEqual(protected_clean, awg)

            # Add a catalog exit and publish all profiles without touching the
            # old opt-in list. A later deletion must remove its aliases even
            # when the base YAML and old DNS ID list still contain that exit.
            catalog = json.loads((root / "clash-inputs.json").read_text(encoding="utf-8"))
            added = {"id": "333333333333", "name": "Added", "proxy": {
                "name": "EXIT.Added", "type": "socks5", "server": "exit-added.test",
                "port": 1080, "username": "private-user", "password": "private-password",
                "dialer-proxy": "MID",
            }}
            catalog["exits"].append(added)
            for name in ("home-desk", "home-iphone", "home-iphone6"):
                catalog["awg_exit_selections"][name] = [item["id"] for item in catalog["exits"]]
            (root / "clash-inputs.json").write_text(json.dumps(catalog), encoding="utf-8")
            base_yaml = YAML(typ="rt")
            base_yaml.indent(mapping=2, sequence=4, offset=2)
            base_yaml.preserve_quotes = True
            base_yaml.width = 4096
            updated_base = base_yaml.load(base.read_text(encoding="utf-8"))
            updated_base["proxies"].append(added["proxy"])
            next(item for item in updated_base["proxy-groups"] if item["name"] == "PROXY")["proxies"].append("EXIT.Added")
            with base.open("w", encoding="utf-8") as handle:
                base_yaml.dump(updated_base, handle)
            subprocess.run(command, check=True)
            baselines = {"home-desk": awg, "home-iphone": vless, "home-iphone6": legacy}
            for name in ("home-desk", "home-iphone", "home-iphone6"):
                protected = yaml.load((staging / f"clash-{name}.yaml").read_text(encoding="utf-8"))
                nodes = {item["name"]: item for item in protected["proxies"]}
                self.assertEqual(nodes["SERVER.RELAY.VLESS.Added.443"]["type"], "vless")
                self.assertFalse(any(item.get("type") == "socks5" for item in nodes.values()))
                self.assertNotIn("exit-added.test", json.dumps(protected))
                self.assertNotIn("private-password", json.dumps(protected))
                self.assertEqual(protected["dns"], baselines[name]["dns"])
                self.assertEqual(protected["rules"], baselines[name]["rules"])
                if name == "home-iphone":
                    self.assertEqual(nodes["EXIT.Added"]["uuid"], nodes["SERVER.RELAY.VLESS.Added.443"]["uuid"])
            catalog["exits"].pop()
            for selection in catalog["awg_exit_selections"].values():
                selection.remove(added["id"])
            (root / "clash-inputs.json").write_text(json.dumps(catalog), encoding="utf-8")
            relay_config["dns_consistent_exit_ids"] = [added["id"]]
            (root / "server-relay.json").write_text(json.dumps(relay_config), encoding="utf-8")
            subprocess.run(command, check=True)
            for name in ("home-desk", "home-iphone", "home-iphone6"):
                text = (staging / f"clash-{name}.yaml").read_text(encoding="utf-8")
                self.assertNotIn("Added", text)
                self.assertNotIn("exit-added.test", text)
                self.assertNotIn("private-password", text)

            # Resource startup is independent of selected exits, including
            # modern/legacy and clean profiles. Do not introduce a new exit or
            # change the existing empty-PROXY behavior of a clean MID-only profile.
            old_selections = copy.deepcopy(catalog["awg_exit_selections"])
            for name in ("home-desk", "home-iphone", "home-iphone6"):
                catalog["awg_exit_selections"][name] = []
            (root / "clash-inputs.json").write_text(json.dumps(catalog), encoding="utf-8")
            for clean_nodes in ([], ["home-desk", "home-iphone", "home-iphone6"]):
                publications["clean_mode"] = clean_nodes
                (root / "publications.json").write_text(json.dumps(publications), encoding="utf-8")
                subprocess.run(command, check=True)
                for name in ("home-desk", "home-iphone", "home-iphone6"):
                    with self.subTest(mid_only=name, clean=bool(clean_nodes)):
                        profile = yaml.load((staging / f"clash-{name}.yaml").read_text(encoding="utf-8"))
                        self.assertFalse(any(node["name"].startswith(("EXIT.", "SERVER.RELAY.VLESS.")) for node in profile["proxies"]))
                        self.assertIn("DOMAIN,example.com,MID", profile["rules"])
                        self.assertIn("IP-CIDR,1.1.1.1/32,MID,no-resolve", profile["rules"])
                        self.assertEqual(
                            profile["dns"]["nameserver-policy"]["example.com"],
                            "https://1.1.1.1/dns-query" if name == "home-iphone6" else ["https://1.1.1.1/dns-query#MID"],
                        )
                        self.assertEqual(
                            next(item for item in profile["proxy-groups"] if item["name"] == "MID")["proxies"],
                            ["ENDPOINT.MID.443", "ENDPOINT.MID.2053"],
                        )
                        if name == "home-desk":
                            self.assertIn("IP-CIDR,10.20.0.0/24,DIRECT,no-resolve", profile["rules"])
                        if name != "home-iphone6":
                            self.assertEqual(profile["dns"]["direct-nameserver"], [
                                "https://8.8.8.8/dns-query#PROXY", "https://1.0.0.1/dns-query#PROXY",
                            ])
                        for provider in profile["rule-providers"].values():
                            self.assertEqual(provider.get("proxy"), None if name == "home-iphone6" else "MID")
            catalog["awg_exit_selections"] = old_selections
            (root / "clash-inputs.json").write_text(json.dumps(catalog), encoding="utf-8")

            published = {path.name: path.read_bytes() for path in staging.glob("*.yaml")}
            original_proxy = dict(catalog["exits"][0]["proxy"])
            for invalid in ({"type": "http"}, {"server": "127.0.0.1"}):
                catalog["exits"][0]["proxy"] = {**original_proxy, **invalid}
                (root / "clash-inputs.json").write_text(json.dumps(catalog), encoding="utf-8")
                rejected = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("SOCKS5", rejected.stderr)
                self.assertEqual({path.name: path.read_bytes() for path in staging.glob("*.yaml")}, published)
            catalog["exits"][0]["proxy"] = original_proxy
            (root / "clash-inputs.json").write_text(json.dumps(catalog), encoding="utf-8")

            relay_config["vless_enabled"] = False
            (root / "server-relay.json").write_text(json.dumps(relay_config), encoding="utf-8")
            rejected = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("出口一致 DNS", rejected.stderr)

    def test_corrupt_stable_endpoint_stops_publication_instead_of_using_stale_ip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            endpoint = root / "public-endpoint.json"
            endpoint.write_text("{broken\n", encoding="utf-8")
            base = root / "base.yaml"
            base.write_text("proxies: []\nrules: []\n", encoding="utf-8")
            for name, content in {
                "awg.tsv": "", "awg.conf": "AWG_PUBLIC_IP=203.0.113.10\n",
                "policy.json": '{"version":1,"clients":{}}',
                "summary.json": '{"vless_template":{"server":"203.0.113.10"}}',
                "publications.json": '{"version":1,"disabled":[]}',
                "node-domains.json": '{"version":1,"nodes":{}}',
                "clash-inputs.json": '{"version":4,"airports":[],"exits":[],"default_exit_id":"","awg_exit_selections":{}}',
            }.items():
                (root / name).write_text(content, encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable, str(HELPER), "--base", str(base),
                    "--awg-peer-db", str(root / "awg.tsv"), "--awg-state", str(root / "awg.conf"),
                    "--public-endpoint", str(endpoint), "--vless-policy", str(root / "policy.json"),
                    "--vless-summary", str(root / "summary.json"), "--staging-dir", str(root / "staging"),
                    "--final-dir", str(root / "final"), "--existing-config", str(root / "missing.json"),
                    "--publication-state", str(root / "publications.json"),
                    "--proxy-inputs", str(root / "clash-inputs.json"),
                    "--node-domains", str(root / "node-domains.json"),
                    "--server-relay", str(root / "missing-relay.json"),
                    "--output-config", str(root / "output.json"),
                    "--port", "8444", "--server-address", "198.51.100.10", "--cert", "/tmp/cert", "--key", "/tmp/key",
                ], cwd=REPO_DIR,
                capture_output=True, text=True,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("稳定公网入口事实文件无效", completed.stderr)


if __name__ == "__main__":
    unittest.main()
