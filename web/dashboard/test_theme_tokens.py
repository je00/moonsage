"""Shared theme contracts; no database or management-agent access."""

from pathlib import Path
import re
from unittest import TestCase


WEB_DIR = Path(__file__).resolve().parents[1]


class SharedThemeTokenTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.theme = (WEB_DIR / "static/moonsage/theme.css").read_text()
        source = re.sub(r"/\*.*?\*/", "", cls.theme, flags=re.S)
        cls.rules = {
            selector.strip(): dict(re.findall(r"([\w-]+)\s*:\s*([^;]+);", body))
            for selectors, body in re.findall(r"([^{}]+)\{([^}]+)\}", source)
            for selector in selectors.split(",")
        }

    def test_only_complete_light_and_dark_blue_palettes_are_available(self):
        expected = {
            ":root": ("#f0f6f8", "#1c7091", "light"),
            ':root[data-theme="light"]': ("#f0f6f8", "#1c7091", "light"),
            ':root[data-theme="dark"]': ("#101d27", "#63bde7", "dark"),
        }
        self.assertEqual(set(self.rules), set(expected))
        default_tokens = {name for name in self.rules[":root"] if name.startswith("--")}
        self.assertTrue({
            "--bg", "--panel", "--panel-strong", "--line", "--text", "--muted",
            "--accent", "--accent-soft", "--accent-text", "--accent-heading",
            "--accent-border", "--accent-border-strong", "--sidebar-bg",
            "--mobile-nav-bg", "--field-bg", "--surface-soft", "--surface-subtle",
            "--panel-soft", "--text-soft", "--text-subtle", "--body-glow",
            "--button-start", "--button-end", "--brand-start", "--brand-end",
            "--dialog-bg", "--shadow", "--code-bg", "--code-text", "--success",
            "--success-text", "--danger", "--danger-text", "--warning-text",
            "--nav-text", "--nav-active", "--on-accent", "--overlay-bg",
        }.issubset(default_tokens))
        for selector, (background, accent, scheme) in expected.items():
            with self.subTest(selector=selector):
                declarations = self.rules[selector]
                self.assertEqual({name for name in declarations if name.startswith("--")}, default_tokens)
                self.assertEqual(declarations["--bg"], background)
                self.assertEqual(declarations["--accent"], accent)
                self.assertEqual(declarations["color-scheme"], scheme)
        self.assertEqual(
            self.rules[":root"]["font-family"],
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        )

    def test_console_does_not_duplicate_shared_root_tokens(self):
        console = (WEB_DIR / "static/console.css").read_text()
        self.assertTrue(console.split("html {", 1)[0].strip().endswith("*/"))
        self.assertNotIn(":root", console.split("html {", 1)[0])
        self.assertNotIn(":root", (WEB_DIR / "static/app.css").read_text())

    def test_base_loads_shared_tokens_after_legacy_css_before_console_styles(self):
        base = (WEB_DIR / "templates/base.html").read_text()
        shared = "{% static 'moonsage/theme.css' %}"
        self.assertEqual(base.count(shared), 1)
        self.assertLess(base.index("{% static 'app.css' %}"), base.index(shared))
        self.assertLess(base.index(shared), base.index("{% static 'console.css' %}"))
        self.assertLess(base.index("{% static 'theme.js' %}"), base.index(shared))
