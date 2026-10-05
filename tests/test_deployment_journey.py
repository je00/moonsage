#!/usr/bin/env python3
"""验证跨平台部署旅程的不变量与平台差异。"""

from __future__ import annotations

import unittest

from web.dashboard.deployment_guide import build_deployment_journey


class DeploymentJourneyTests(unittest.TestCase):
    def test_every_platform_follows_the_same_core_journey(self) -> None:
        guides = build_deployment_journey()
        self.assertEqual([guide.platform for guide in guides], ["windows", "linux", "macos", "iphone", "android"])
        for guide in guides:
            roles = [step["role"] for step in guide.steps]
            self.assertEqual(roles[:4], ["node", "subscription", "tunnel", "verify"])
            self.assertNotIn("software", roles)
            self.assertTrue(guide.steps[1]["apps"])

    def test_desktop_and_mobile_adapters_express_only_real_differences(self) -> None:
        guides = {guide.platform: guide for guide in build_deployment_journey()}
        for platform in ("windows", "linux", "macos"):
            self.assertEqual(guides[platform].badge, "AWG")
            self.assertEqual(guides[platform].steps[-1]["role"], "ssh")
            self.assertIn("AmneziaWG", str(guides[platform].steps[0]["apps"]))
            self.assertIn("Clash Verge", str(guides[platform].steps[1]["apps"]))
        self.assertEqual(guides["iphone"].steps[2]["type"], "stash_route")
        self.assertFalse(guides["iphone"].steps[0]["apps"])
        self.assertIn("Stash", str(guides["iphone"].steps[1]["apps"]))
        self.assertIn("FlClash", str(guides["android"].steps[1]["apps"]))

    def test_termux_is_an_optional_android_step_not_an_iphone_or_vless_capability(self) -> None:
        guides = {guide.platform: guide for guide in build_deployment_journey()}
        android = guides["android"]
        self.assertEqual(android.badge, "VLESS")
        self.assertEqual([step["role"] for step in android.steps], ["node", "subscription", "tunnel", "verify", "ssh"])
        ssh = android.steps[-1]
        self.assertEqual(ssh["platform"], "android")
        self.assertEqual(ssh["kind"], "可选")
        self.assertIn("Termux", ssh["title"])
        self.assertIn("AWG 内网地址", str(ssh))
        self.assertIn("VLESS 不提供入站 SSH", str(ssh))
        for desktop_claim in ("允许来源网段", "5 分钟自动回滚", "安全启用仅公钥认证"):
            self.assertNotIn(desktop_claim, str(ssh))
        self.assertNotIn("ssh", [step["role"] for step in guides["iphone"].steps])


if __name__ == "__main__":
    unittest.main()
