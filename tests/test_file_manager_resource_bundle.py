"""Exercise the production shell publication guard without system services."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from lib.clash_bundle import (
    add_server_relay_group, apply_legacy_stash_compat, configure_vps_resource_downloads,
)


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "debian_file_manager.sh").read_text(encoding="utf-8")
VERIFY_FUNCTION = SCRIPT[SCRIPT.index("verify_clash_vless_relay_bundle() {"):SCRIPT.index("\nwrite_config() {")]


class ResourceBundleGuardTests(unittest.TestCase):
    def profile(self, *, relay: bool = True, legacy: bool = False, clean: bool = False) -> dict:
        config = {
            "proxies": [{
                "name": f"ENDPOINT.MID.{port}", "type": "vless", "port": port,
                "server": "vps.example.net", "uuid": "original-mid-uuid",
            } for port in (443, 2053)],
            "proxy-groups": [
                {"name": "PROXY", "type": "select", "proxies": [] if clean else ["MID"]},
                {"name": "MID", "type": "fallback", "proxies": ["ENDPOINT.MID.443", "ENDPOINT.MID.2053"]},
            ],
            "rule-providers": {"rules": {"type": "http", "url": "https://cdn.example.net/rules"}},
            "dns": {
                "respect-rules": True, "follow-rule": True,
                "nameserver": ["https://8.8.8.8/dns-query#PROXY", "https://1.0.0.1/dns-query#PROXY"],
            },
            "rules": ["IP-CIDR,10.20.0.0/24,DIRECT,no-resolve", "MATCH,PROXY"],
        }
        group_names, node_names = [], set()
        if relay:
            group_names, node_names = add_server_relay_group(
                config, [{"name": "SERVER.RELAY.VLESS.Primary", "uuid": "exit-relay-uuid"}], "vps.example.net",
            )
        configure_vps_resource_downloads(config)
        if legacy:
            apply_legacy_stash_compat(config, "vps.example.net", preserved_vless_names=node_names,
                                     vless_relay_group_names=group_names)
        return config

    def verify(self, config: dict, *, relay: bool = True, empty_selection: bool = False,
               catalog: bool = True, relay_file: bool = True) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "bundle"
            bundle.mkdir()
            (bundle / "clash-test.yaml").write_text(json.dumps(config), encoding="utf-8")
            if relay_file:
                (root / "relay.json").write_text(json.dumps({"enabled": relay, "vless_enabled": relay}), encoding="utf-8")
            if catalog:
                (root / "catalog.json").write_text(json.dumps({
                    "version": 4, "airports": [], "default_exit_id": "111111111111",
                    "awg_exit_selections": {"test": []} if empty_selection else {},
                    "exits": [{"id": "111111111111", "name": "Primary", "proxy": {
                        "type": "socks5", "server": "gateway.example.net", "port": 1080,
                    }}],
                }), encoding="utf-8")
            env = dict(os.environ)
            env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
            return subprocess.run([
                "bash", "-c", VERIFY_FUNCTION + '\nSCRIPT_DIR="$1"\nverify_clash_vless_relay_bundle "$2" "$3" "$4"',
                "resource-guard-test", str(ROOT), str(bundle), str(root / "relay.json"), str(root / "catalog.json"),
            ], capture_output=True, text=True, env=env)

    def test_modern_and_legacy_resource_paths_pass(self) -> None:
        for legacy in (False, True):
            for clean in (False, True):
                with self.subTest(legacy=legacy, clean=clean):
                    result = self.verify(self.profile(legacy=legacy, clean=clean))
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_mid_only_requires_catalog_empty_selection(self) -> None:
        for legacy in (False, True):
            for clean in (False, True):
                with self.subTest(legacy=legacy, clean=clean):
                    config = self.profile(relay=False, legacy=legacy, clean=clean)
                    result = self.verify(config, empty_selection=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertNotEqual(self.verify(config).returncode, 0)
                    self.assertNotEqual(self.verify(config, catalog=False).returncode, 0)

    def test_global_relay_disabled_or_missing_still_checks_resource_path(self) -> None:
        for relay_file in (False, True):
            with self.subTest(relay_file=relay_file):
                config = self.profile(relay=False)
                config["proxies"].append({"name": "EXIT.Raw", "type": "socks5", "server": "gateway.example.net", "port": 1080, "dialer-proxy": "MID"})
                config["proxy-groups"][0]["proxies"].append("EXIT.Raw")
                result = self.verify(config, relay=False, relay_file=relay_file)
                self.assertEqual(result.returncode, 0, result.stderr)
                config["rule-providers"]["rules"]["proxy"] = "DIRECT"
                self.assertNotEqual(self.verify(config, relay=False, relay_file=relay_file).returncode, 0)

    def test_wrong_resource_dns_proxy_or_domain_is_rejected(self) -> None:
        for field in ("policy", "proxy", "domain", "doh-route", "unlisted-host", "shadow-route", "direct-dns", "entry-policy"):
            with self.subTest(field=field):
                config = self.profile()
                if field == "policy":
                    config["dns"]["nameserver-policy"]["cdn.example.net"] = ["https://1.1.1.1/dns-query#PROXY"]
                elif field == "proxy":
                    config["rule-providers"]["rules"]["proxy"] = "SERVER.RELAY.VLESS.Primary"
                elif field == "unlisted-host":
                    config["rule-providers"]["rules"]["url"] = "https://new.example.net/rules"
                elif field == "shadow-route":
                    config["rules"].insert(0, "DOMAIN,cdn.example.net,DIRECT")
                elif field == "direct-dns":
                    config["dns"]["direct-nameserver"] = ["https://1.1.1.1/dns-query#PROXY"]
                elif field == "entry-policy":
                    config["dns"]["proxy-server-nameserver-policy"] = {"vps.example.net": ["https://223.5.5.5/dns-query#MID"]}
                else:
                    config["rules"].remove("DOMAIN,cdn.example.net,MID" if field == "domain" else "IP-CIDR,1.1.1.1/32,MID,no-resolve")
                self.assertNotEqual(self.verify(config).returncode, 0)

    def test_recursive_or_missing_mid_is_rejected(self) -> None:
        for field in ("missing", "chained", "relay-id", "group", "upstream"):
            with self.subTest(field=field):
                config = self.profile(relay=field != "upstream")
                if field == "missing":
                    config["proxies"].pop(0)
                elif field == "chained":
                    config["proxies"][0]["dialer-proxy"] = "PROXY"
                elif field == "relay-id":
                    config["proxies"][0]["uuid"] = config["proxies"][1]["uuid"] = "exit-relay-uuid"
                elif field == "upstream":
                    config["dns"]["proxy-server-nameserver"] = ["https://223.5.5.5/dns-query#MID"]
                else:
                    next(item for item in config["proxy-groups"] if item["name"] == "MID")["proxies"] = ["PROXY"]
                self.assertNotEqual(self.verify(config, empty_selection=field == "upstream").returncode, 0)


if __name__ == "__main__":
    unittest.main()
