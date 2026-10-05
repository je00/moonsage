"""Generated fields must not cross the next section's round-trip comments."""
import copy
import io
from pathlib import Path
import re
import unittest
from unittest.mock import patch

from ruamel.yaml import YAML

from lib.clash_bundle import (
    add_server_relay_group, apply_stash_benchmark, apply_stash_bootstrap_with_layout,
    configure_provider_empty_fallback, configure_resource_download_proxy,
    configure_vps_resource_downloads, set_generated_yaml_field,
)
from lib.stash_bootstrap import apply_stash_bootstrap


ROOT = Path(__file__).resolve().parents[1]


class ClashYamlLayoutTests(unittest.TestCase):
    def setUp(self):
        self.yaml = YAML()
        self.yaml.preserve_quotes = True
        self.yaml.indent(mapping=2, sequence=4, offset=2)

    def dump(self, value):
        output = io.StringIO()
        self.yaml.dump(value, output)
        return output.getvalue()

    def semantic(self, value):
        return YAML(typ="safe").load(self.dump(value))

    def test_actual_rule_provider_sections_keep_headings_with_next_provider(self):
        config = self.yaml.load((ROOT / "clash_skeleton.yaml").read_text())
        expected = copy.deepcopy(config)
        with patch("lib.clash_bundle.set_generated_yaml_field",
                   side_effect=lambda mapping, key, value, **_: mapping.__setitem__(key, value)):
            configure_resource_download_proxy(expected, "MID")
        configure_resource_download_proxy(config, "MID")
        text = self.dump(config)
        for title, name in (("IP 地址规则集", "telegramcidr"),
                            ("程序规则集", "applications"),
                            ("专用服务域名规则集", "openai")):
            self.assertRegex(text, rf"# ---------- {title} ----------\n  {name}:")
        for provider in config["rule-providers"].values():
            keys = list(provider)
            self.assertEqual(keys.index("proxy") + 1, keys.index("url"))
        self.assertEqual(len(re.findall(r"^  applications:", text, re.M)), 1)
        self.assertEqual(self.semantic(config), self.semantic(expected))
        configure_resource_download_proxy(config, "MID")
        self.assertEqual(text, self.dump(config))

    def test_url_or_type_last_with_inline_comments_and_custom_keys(self):
        for fields in (
            "    type: http\n    custom: true\n    url: 'https://rules.example.net/a' # source\n",
            "    url: 'https://rules.example.net/a' # source\n    type: http\n",
        ):
            with self.subTest(fields=fields):
                raw = "rule-providers:\n  first:\n" + fields + "\n  # next provider\n  second:\n    type: file\n    path: local.yaml\n"
                config = self.yaml.load(raw)
                before = self.semantic(config)
                configure_resource_download_proxy(config, "MID")
                text = self.dump(config)
                self.assertIn("# next provider\n  second:", text)
                self.assertIn("'https://rules.example.net/a' # source", text)
                before["rule-providers"]["first"]["proxy"] = "MID"
                self.assertEqual(self.semantic(config), before)
                configure_resource_download_proxy(config, "MID")
                self.assertEqual(text, self.dump(config))

    def test_existing_field_comments_and_scalar_format_stay_in_place(self):
        config = self.yaml.load("rule-providers:\n  first:\n    type: http\n    url: https://rules.example.net/a\n    proxy: 'MID' # keep\n\n  # next provider\n  second:\n    type: file\n")
        before = self.dump(config)
        configure_resource_download_proxy(config, "MID")
        self.assertEqual(self.dump(config), before)
        configure_resource_download_proxy(config, "OTHER")
        self.assertIn("# keep\n\n  # next provider\n  second:", self.dump(config))

    def test_yaml_merge_aliases_remain_valid(self):
        config = self.yaml.load("defaults: &defaults\n  type: http\n  interval: 3600\nrule-providers:\n  first:\n    <<: *defaults\n    url: https://rules.example.net/a\n\n  # next provider\n  second:\n    type: file\n")
        before = self.semantic(config)
        configure_resource_download_proxy(config, "MID")
        text = self.dump(config)
        self.assertIn("<<: *defaults", text)
        self.assertIn("# next provider\n  second:", text)
        before["rule-providers"]["first"]["proxy"] = "MID"
        self.assertEqual(self.semantic(config), before)

    def test_inherited_benchmark_override_is_inserted_before_trailing_heading(self):
        config = self.yaml.load("defaults: &defaults\n  type: http\n  benchmark-timeout: 1\nproxies: []\nproxy-providers:\n  first:\n    <<: *defaults\n    url: https://provider.example.net/a\n\n# rules\nrules: []\n")
        expected = self.semantic(config)
        expected["proxy-providers"]["first"].update({
            "benchmark-url": "http://cp.cloudflare.com/generate_204", "benchmark-timeout": 5,
        })
        apply_stash_benchmark(config)
        text = self.dump(config)
        self.assertIn("<<: *defaults", text)
        self.assertIn("# rules\nrules:", text)
        self.assertEqual(self.semantic(config), expected)
        apply_stash_benchmark(config)
        self.assertEqual(self.dump(config), text)

    def test_dns_entry_and_resource_policies_stay_before_direct_section(self):
        config = self.yaml.load((ROOT / "clash_skeleton.yaml").read_text())
        for node in config["proxies"]:
            if str(node.get("name", "")).startswith("ENDPOINT.MID."):
                node.update(server="vps.example.net", uuid="independent-mid-uuid")
        expected = copy.deepcopy(config)

        def project(value):
            add_server_relay_group(value, [{"name": "SERVER.RELAY.VLESS.Example", "uuid": "exit-relay-uuid"}], "vps.example.net")
            configure_vps_resource_downloads(value)

        with patch("lib.clash_bundle.set_generated_yaml_field",
                   side_effect=lambda mapping, key, value, **_: mapping.__setitem__(key, value)):
            project(expected)
        project(config)
        text = self.dump(config)
        boundary = text[text.index("  # ---------- DNS 上游：DIRECT 目标") : text.index("  direct-nameserver:")]
        self.assertTrue(all(not line.strip() or line.lstrip().startswith("#") for line in boundary.splitlines()))
        self.assertEqual(self.semantic(config), self.semantic(expected))
        configure_vps_resource_downloads(config)
        self.assertEqual(text, self.dump(config))

    def test_modern_stash_added_entry_keeps_dns_heading_and_semantics(self):
        config = self.yaml.load("dns:\n  nameserver-policy:\n    domestic.example.cn: ['https://223.5.5.5/dns-query']\n\n  # direct targets\n  direct-nameserver: ['https://223.5.5.5/dns-query']\nproxies:\n  - name: entry\n    type: vless\n    server: entry.example.net\nproxy-providers: {}\nproxy-groups: []\nrules: ['MATCH,PROXY']\n")
        expected = copy.deepcopy(config)
        apply_stash_bootstrap(expected, {"airports": []})
        apply_stash_bootstrap_with_layout(config, {"airports": []})
        text = self.dump(config)
        self.assertIn("# direct targets\n  direct-nameserver:", text)
        self.assertEqual(self.semantic(config), self.semantic(expected))
        apply_stash_bootstrap_with_layout(config, {"airports": []})
        self.assertEqual(text, self.dump(config))

    def test_benchmark_and_fallback_fields_stay_inside_custom_sections(self):
        config = self.yaml.load("proxies:\n  - name: test\n    type: vless\n    server: vps.example.net\n\n# providers\nproxy-providers:\n  first:\n    type: http\n    url: https://provider.example.net/a\n\n# groups\nproxy-groups:\n  - name: airport\n    type: url-test\n    use: [first]\n\n# rules\nrules: []\n")
        expected = copy.deepcopy(config)
        with patch("lib.clash_bundle.set_generated_yaml_field",
                   side_effect=lambda mapping, key, value, **_: mapping.__setitem__(key, value)):
            apply_stash_benchmark(expected)
            configure_provider_empty_fallback(expected, "RELAY")
        apply_stash_benchmark(config)
        configure_provider_empty_fallback(config, "RELAY")
        text = self.dump(config)
        for title, section in (("providers", "proxy-providers"), ("groups", "proxy-groups"), ("rules", "rules")):
            self.assertIn(f"# {title}\n{section}:", text)
        self.assertEqual(self.semantic(config), self.semantic(expected))
        apply_stash_benchmark(config)
        configure_provider_empty_fallback(config, "RELAY")
        self.assertEqual(text, self.dump(config))

    def test_plain_dict_values_and_existing_key_order_are_preserved(self):
        value = {"type": "http", "url": "https://example.net", "proxy": "MID"}
        before = list(value)
        set_generated_yaml_field(value, "proxy", "OTHER", before="url")
        self.assertEqual(list(value), before)
        self.assertEqual(value["proxy"], "OTHER")

    def test_equal_numeric_values_keep_generated_integer_type(self):
        value = self.yaml.load("timeout: 5.0 # seconds\nflag: true\nformatted: 0x05 # hex\n")
        set_generated_yaml_field(value, "timeout", 5)
        set_generated_yaml_field(value, "flag", 1)
        set_generated_yaml_field(value, "formatted", 5)
        text = self.dump(value)
        parsed = YAML(typ="safe").load(text)
        self.assertIs(type(parsed["timeout"]), int)
        self.assertIs(type(parsed["flag"]), int)
        self.assertIn("timeout: 5   # seconds", text)
        self.assertIn("formatted: 0x05 # hex", text)


if __name__ == "__main__":
    unittest.main()
