"""Stats instrumentation must preserve routing and reject unsafe exposure."""

import copy
import unittest

from lib.server_kit_xray_stats import (
    STATS_API, STATS_API_TAG, STATS_INBOUND, STATS_INBOUND_TAG,
    STATS_RULE, STATS_SOCKET_PATH, XrayStatsError, render_xray_stats, stats_enabled,
)


class XrayStatsTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "dns": {"hosts": {"git.example.com": "10.20.0.103"}, "servers": ["localhost"]},
            "inbounds": [{"tag": "vless-public", "protocol": "vless", "port": 443,
                          "settings": {"clients": [
                              {"id": "id-unchanged", "email": "server-kit-vless:phone", "level": 2},
                              {"id": "relay-unchanged", "email": "server-kit-relay-vless:phone:111111111111"},
                              {"id": "other-unchanged", "email": "external", "level": 5},
                          ]}}],
            "outbounds": [{"tag": "direct", "protocol": "freedom"}],
            "routing": {"domainStrategy": "IPIfNonMatch", "rules": [
                {"type": "field", "ip": ["10.20.0.0/24"], "outboundTag": "direct"},
            ]},
            "policy": {"levels": {"0": {"connIdle": 300}, "2": {"handshake": 8}, "5": {"statsUserUplink": False}},
                       "system": {"statsInboundUplink": False}},
        }

    def test_minimal_unix_stats_preserves_every_existing_identity_dns_and_policy(self):
        original = copy.deepcopy(self.config)
        result = render_xray_stats(self.config)
        self.assertEqual(self.config, original)
        self.assertEqual(result["api"], STATS_API)
        self.assertEqual(result["stats"], {})
        self.assertEqual(result["dns"], original["dns"])
        self.assertEqual(result["inbounds"], [*original["inbounds"], STATS_INBOUND])
        self.assertEqual(result["routing"]["rules"], [STATS_RULE, *original["routing"]["rules"]])
        self.assertNotIn("ip", STATS_RULE)
        self.assertNotIn("domain", STATS_RULE)
        self.assertEqual(result["routing"]["domainStrategy"], "IPIfNonMatch")
        self.assertEqual(result["outbounds"], original["outbounds"])
        self.assertNotIn("port", STATS_INBOUND)
        self.assertNotIn("listen", STATS_API)
        self.assertEqual(STATS_INBOUND["listen"], f"{STATS_SOCKET_PATH},0600")
        self.assertEqual(STATS_INBOUND["settings"]["network"], "unix")
        for level in ("0", "2"):
            self.assertIs(result["policy"]["levels"][level]["statsUserUplink"], True)
            self.assertIs(result["policy"]["levels"][level]["statsUserDownlink"], True)
        self.assertEqual(result["policy"]["levels"]["0"]["connIdle"], 300)
        self.assertEqual(result["policy"]["levels"]["2"]["handshake"], 8)
        self.assertEqual(result["policy"]["levels"]["5"], original["policy"]["levels"]["5"])
        self.assertEqual(result["policy"]["system"], original["policy"]["system"])
        self.assertTrue(stats_enabled(result))
        self.assertEqual(render_xray_stats(result), result)

    def test_api_writes_or_public_or_different_listener_are_never_silently_replaced(self):
        for api in (None, {}, {**STATS_API, "listen": "0.0.0.0:10085"},
                    {**STATS_API, "listen": "127.0.0.1:10086"},
                    {**STATS_API, "services": ["StatsService", "HandlerService"]}):
            config = {**self.config, "api": api}
            with self.subTest(api=api), self.assertRaises(XrayStatsError):
                render_xray_stats(config)
            self.assertFalse(stats_enabled(config))

    def test_own_api_and_inbound_tags_must_not_shadow_existing_handlers(self):
        cases = [
            ("inbounds", {"tag": STATS_API_TAG}),
            ("inbounds", {"tag": STATS_INBOUND_TAG}),
            ("outbounds", {"tag": STATS_API_TAG, "protocol": "freedom"}),
            ("outbounds", {"tag": STATS_INBOUND_TAG, "protocol": "freedom"}),
        ]
        for field, value in cases:
            config = copy.deepcopy(self.config)
            config[field].append(value)
            with self.subTest(field=field, value=value), self.assertRaises(XrayStatsError):
                render_xray_stats(config)

    def test_stats_never_reserves_or_blocks_a_network_port(self):
        for port in (10085, "10085", "80,10080-10090", "1-65535"):
            config = copy.deepcopy(self.config)
            config["inbounds"].append({"port": port})
            with self.subTest(port=port):
                result = render_xray_stats(config)
                self.assertEqual(result["inbounds"][:-1], config["inbounds"])
                self.assertEqual(result["routing"]["rules"][0], STATS_RULE)
                self.assertEqual(STATS_RULE["inboundTag"], [STATS_INBOUND_TAG])
            self.assertNotIn("api", config)

    def test_unsafe_socket_permissions_or_another_listener_on_socket_path_fail(self):
        for listen in (STATS_SOCKET_PATH, STATS_SOCKET_PATH + ",0666", "/run/xray/../xray/server-kit-stats.sock,0600"):
            config = copy.deepcopy(self.config)
            config["inbounds"].append({"tag": "other", "protocol": "dokodemo-door", "listen": listen})
            with self.subTest(listen=listen), self.assertRaises(XrayStatsError):
                render_xray_stats(config)

    def test_invalid_policy_and_lists_fail_closed(self):
        for key, value in (("policy", []), ("policy", {"levels": []}), ("policy", {"levels": {"0": None}}),
                           ("stats", None), ("routing", []), ("routing", {"rules": "bad"}), ("outbounds", {})):
            with self.subTest(key=key, value=value), self.assertRaises(XrayStatsError):
                render_xray_stats({**self.config, key: value})

    def test_invalid_managed_user_level_is_rejected(self):
        for level in (True, "0", -1, 1 << 32):
            config = copy.deepcopy(self.config)
            config["inbounds"][0]["settings"]["clients"][0]["level"] = level
            with self.subTest(level=level), self.assertRaises(XrayStatsError):
                render_xray_stats(config)

    def test_removing_or_reordering_api_protection_disables_collection(self):
        result = render_xray_stats(self.config)
        result["routing"]["rules"].reverse()
        self.assertFalse(stats_enabled(result))
        for invalid in (None, 1, {}, "x"):
            result["routing"]["rules"] = invalid
            self.assertFalse(stats_enabled(result))

    def test_duplicate_or_foreign_use_of_api_route_is_rejected(self):
        result = render_xray_stats(self.config)
        result["inbounds"].append(copy.deepcopy(STATS_INBOUND))
        with self.assertRaises(XrayStatsError):
            render_xray_stats(result)
        result = render_xray_stats(self.config)
        result["routing"]["rules"].append({"type": "field", "port": "80", "outboundTag": STATS_API_TAG})
        with self.assertRaises(XrayStatsError):
            render_xray_stats(result)
        result = render_xray_stats(self.config)
        result["routing"]["rules"].append({"type": "field", "inboundTag": [STATS_INBOUND_TAG], "outboundTag": "direct"})
        with self.assertRaises(XrayStatsError):
            render_xray_stats(result)


if __name__ == "__main__":
    unittest.main()
