#!/usr/bin/env python3
"""Private subscription-rule validation and durable storage contracts."""

import copy
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib.server_kit_subscription_rules import (
    SubscriptionRulesError, atomic_write, default_config, load,
    normalize_config, overview, revision,
)


class SubscriptionRulesTests(unittest.TestCase):
    def dns(self, server="https://9.9.9.9/dns-query", route="PROXY", **changes):
        item = {"match": "suffix", "value": "service.example", "servers": [server], "route": route}
        item.update(changes)
        return {"version": 1, "direct_rules": [], "dns_rules": [item]}

    def test_normalization_and_independent_matching(self):
        value = self.dns(value="*.EXAMPLE.COM.")
        value["direct_rules"] = [
            {"match": "exact", "value": " WWW.Example.COM. "},
            {"match": "suffix", "value": "+.bücher.example"},
            {"match": "cidr", "value": "192.168.50.0/24"},
            {"match": "cidr", "value": "2001:db8:50::/48"},
        ]
        result = normalize_config(value)
        self.assertEqual(result["dns_rules"][0]["value"], "example.com")
        self.assertEqual(result["direct_rules"][0]["value"], "www.example.com")
        self.assertEqual(result["direct_rules"][1]["value"], "xn--bcher-kva.example")
        self.assertEqual(normalize_config({}), {"version": 1, "direct_rules": [], "dns_rules": []})

    def test_rejects_ambiguous_scopes_duplicates_and_unknown_fields(self):
        values = ["*", "+", "com", "https://service.example", "example.com/path", "127.0.0.1", "a..example", "a.example,PROXY"]
        for value in values:
            with self.subTest(value=value), self.assertRaises(SubscriptionRulesError):
                normalize_config(self.dns(value=value))
        for cidr in ("0.0.0.0/0", "0.0.0.0/1", "::/0", "2000::/3", "192.168.1.1/24", "::ffff:0:0/96"):
            with self.subTest(cidr=cidr), self.assertRaises(SubscriptionRulesError):
                normalize_config({"direct_rules": [{"match": "cidr", "value": cidr}]})
        for value in ([], {"version": True}, {"unexpected": []}, {"dns_rules": {}}, {"direct_rules": ["example"]}):
            with self.subTest(value=value), self.assertRaises(SubscriptionRulesError):
                normalize_config(value)
        value = self.dns()
        value["dns_rules"] *= 2
        with self.assertRaises(SubscriptionRulesError):
            normalize_config(value)
        with self.assertRaises(SubscriptionRulesError):
            normalize_config(self.dns(match="exact", value="*.example.com"))

    def test_single_ip_is_a_canonical_host_cidr_and_keeps_durable_format(self):
        value = {"version": 1, "direct_rules": [
            {"match": "cidr", "value": " 192.168.50.12 "},
            {"match": "cidr", "value": "2001:DB8:50:0::12"},
            {"match": "cidr", "value": "192.168.51.0/24"},
        ], "dns_rules": []}
        expected = copy.deepcopy(value)
        expected["direct_rules"][0]["value"] = "192.168.50.12/32"
        expected["direct_rules"][1]["value"] = "2001:db8:50::12/128"
        self.assertEqual(normalize_config(value), expected)
        self.assertEqual(normalize_config(expected), expected)
        self.assertEqual(revision(value), revision(expected))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            atomic_write(path, value)
            self.assertEqual(load(path), expected)
            self.assertEqual(json.loads(path.read_text()), expected)
        for address in ("192.168.50.12/32", "2001:db8:50::12/128"):
            duplicated = copy.deepcopy(value)
            duplicated["direct_rules"].append({"match": "cidr", "value": address})
            with self.subTest(address=address), self.assertRaises(SubscriptionRulesError):
                normalize_config(duplicated)

    def test_single_ip_input_rejects_names_invalid_addresses_zones_and_mapped(self):
        for value in ("host.example", "192.168.50.999", "192.168.050.12", "192.168.50.12:53",
                      "192.168.50.12/24", "2001:db8::12/64", "[2001:db8::12]", "fe80::12%eth0",
                      "fe80::12%eth0/128", "::ffff:192.168.50.12", "::ffff:c0a8:320c/128", "", None):
            with self.subTest(value=value), self.assertRaises(SubscriptionRulesError):
                normalize_config({"direct_rules": [{"match": "cidr", "value": value}]})

    def test_dns_addresses_are_bounded_and_bootstrap_independent(self):
        bad = [
            "https://resolver.example/dns-query", "http://9.9.9.9/dns-query", "tls://9.9.9.9",
            "https://user:password@9.9.9.9/dns-query", "https://9.9.9.9/dns-query#DIRECT",
            "https://9.9.9.9/dns-query?token=x", "https://9.9.9.9/dns-query?",
            "https://9.9.9.9", "https://9.9.9.9:0/dns-query", "127.0.0.1", "::1", "0.0.0.0",
            "169.254.10.1", "fe80::1", "224.0.0.1", "ff02::1", "::ffff:127.0.0.1", "system",
        ]
        for value in bad:
            with self.subTest(server=value), self.assertRaises(SubscriptionRulesError):
                normalize_config(self.dns(value, "DIRECT"))
        for route in ("PROXY", "MID"):
            for value in ("192.168.50.1", "9.9.9.9", "https://192.168.50.1/dns-query"):
                with self.subTest(server=value, route=route), self.assertRaises(SubscriptionRulesError):
                    normalize_config(self.dns(value, route))
        self.assertEqual(normalize_config(self.dns("192.168.50.1", "DIRECT"))["dns_rules"][0]["servers"], ["192.168.50.1"])
        self.assertEqual(normalize_config(self.dns("https://[2620:FE::FE]/dns-query"))["dns_rules"][0]["servers"], ["https://[2620:fe::fe]/dns-query"])

    def test_reserved_resolvers_cannot_change_role(self):
        for address in ("8.8.8.8", "1.0.0.1", "1.1.1.1"):
            with self.subTest(address=address), self.assertRaises(SubscriptionRulesError):
                normalize_config(self.dns(f"https://{address}/dns-query", "DIRECT"))
        for address in ("223.5.5.5", "1.12.12.12", "1.1.1.1"):
            with self.subTest(address=address), self.assertRaises(SubscriptionRulesError):
                normalize_config(self.dns(f"https://{address}/dns-query", "PROXY"))
        for address in ("8.8.8.8", "1.0.0.1", "223.5.5.5", "1.12.12.12"):
            with self.subTest(address=address, route="MID"), self.assertRaises(SubscriptionRulesError):
                normalize_config(self.dns(f"https://{address}/dns-query", "MID"))
        self.assertEqual(normalize_config(self.dns("https://1.1.1.1/dns-query", "MID")), self.dns("https://1.1.1.1/dns-query", "MID"))
        value = self.dns()
        other = copy.deepcopy(value["dns_rules"][0])
        other.update(value="another.example", route="DIRECT")
        value["dns_rules"].append(other)
        with self.assertRaises(SubscriptionRulesError):
            normalize_config(value)

    def test_mid_persistence_roundtrip_and_path_conflict(self):
        value = self.dns("https://1.1.1.1/dns-query", "MID")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            atomic_write(path, value)
            self.assertEqual(load(path), value)
            self.assertEqual(overview(path)["revision"], revision(value))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        for route in ("DIRECT", "PROXY"):
            value = self.dns("https://9.9.9.9/dns-query", "MID")
            other = copy.deepcopy(value["dns_rules"][0])
            other.update(value="another.example", route=route)
            value["dns_rules"].append(other)
            with self.subTest(route=route), self.assertRaises(SubscriptionRulesError):
                normalize_config(value)

    def test_limits(self):
        value = self.dns()
        value["dns_rules"][0]["servers"] *= 2
        with self.assertRaises(SubscriptionRulesError):
            normalize_config(value)
        for count in (0, 5):
            with self.subTest(count=count), self.assertRaises(SubscriptionRulesError):
                normalize_config(self.dns(servers=["https://9.9.9.9/dns-query"] * count))
        with self.assertRaises(SubscriptionRulesError):
            normalize_config({"direct_rules": [{"match": "exact", "value": f"host{n}.example"} for n in range(129)]})

    def test_missing_default_explicit_empty_and_corruption_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private" / "rules.json"
            self.assertEqual(load(path), default_config())
            atomic_write(path, normalize_config({}))
            self.assertEqual(load(path), normalize_config({}))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            for broken in ("{}", "[]", "{", '{"version":1,"dns_rules":[]}', '{"version":1,"direct_rules":[],"dns_rules":null}'):
                path.write_text(broken, encoding="utf-8")
                with self.subTest(broken=broken), self.assertRaises(SubscriptionRulesError):
                    load(path)

    def test_atomic_replacement_failure_retains_old_state_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            atomic_write(path, default_config())
            with patch("lib.server_kit_subscription_rules.os.replace", side_effect=OSError("simulated")):
                with self.assertRaises(OSError):
                    atomic_write(path, normalize_config({}))
            self.assertEqual(load(path), default_config())
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_normalized_size_limit_matches_durable_format(self):
        from lib.server_kit_subscription_rules import MAX_BYTES
        values = {"version": 1, "direct_rules": [], "dns_rules": []}
        for index in range(128):
            hostname = f"n{index:03}." + ".".join(["a" * 60] * 4)
            values["direct_rules"].append({"match": "suffix", "value": hostname})
        for index in range(99):
            hostname = f"dns{index:03}." + ".".join(["a" * 60] * 4)
            values["dns_rules"].append({
                "match": "suffix", "value": hostname, "route": "PROXY",
                "servers": ["https://9.9.9.9/" + str(number) + "a" * 446 for number in range(4)],
            })
        compact_size = len((json.dumps(values, separators=(",", ":")) + "\n").encode())
        pretty_size = len(json.dumps(values, indent=2).encode())
        self.assertLess(compact_size, MAX_BYTES)
        self.assertGreater(pretty_size, MAX_BYTES)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            atomic_write(path, values)
            self.assertEqual(load(path), values)
            self.assertEqual(path.stat().st_size, compact_size)
            before = path.read_bytes()
            oversized = copy.deepcopy(values)
            for index in range(99, 110):
                item = copy.deepcopy(values["dns_rules"][0])
                item["value"] = f"extra{index}.example"
                oversized["dns_rules"].append(item)
            with self.assertRaises(SubscriptionRulesError):
                atomic_write(path, oversized)
            self.assertEqual(path.read_bytes(), before)

    def test_revision_and_cli_do_not_drop_saved_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            command = [sys.executable, "-m", "lib.server_kit_subscription_rules"]
            config = self.dns()
            written = subprocess.run(command + ["set", "--config", str(path)], input=json.dumps(config), text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(written.stdout)["operation"], "set")
            result = subprocess.run(command + ["overview", "--config", str(path)], text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(result.stdout), overview(path))
            self.assertEqual(overview(path)["revision"], revision(config))
            reordered = {"dns_rules": config["dns_rules"], "direct_rules": [], "version": 1}
            self.assertEqual(revision(reordered), revision(config))
            failed = subprocess.run(command + ["set", "--config", str(path)], input="not json", text=True, capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(load(path), config)


if __name__ == "__main__":
    unittest.main()
