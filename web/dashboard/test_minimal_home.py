"""The minimal home uses the console theme and a scalable native illustration."""

from django.test import SimpleTestCase
from django.urls import reverse

from .test_template_ux import ElementCollector


class MinimalHomeTests(SimpleTestCase):
    def test_home_has_no_raster_media_or_runtime_beyond_theme_selection(self):
        response = self.client.get(reverse("home"))
        elements = ElementCollector(response.content.decode())
        for tag in ("img", "picture", "canvas", "image", "iframe"):
            with self.subTest(tag=tag):
                self.assertEqual(elements.matching(tag), [])
        scripts = elements.matching("script")
        self.assertEqual(len(scripts), 1)
        self.assertEqual(scripts[0].get("src"), "/static/theme.js")
        scenes = [scene for scene in elements.matching("svg") if "data-moon-scene" in scene]
        self.assertEqual(len(scenes), 1)
        self.assertIn("moon-illustration", scenes[0].get("class", "").split())
        self.assertTrue(scenes[0].get("viewbox"))

    def test_both_languages_offer_only_light_and_dark_appearances(self):
        for language in ("zh", "en"):
            with self.subTest(language=language):
                response = self.client.get(reverse("home"), {"lang": language})
                elements = ElementCollector(response.content.decode())
                self.assertEqual(elements.matching("html")[0].get("data-theme"), "dark")
                buttons = [button for button in elements.matching("button") if "data-theme-value" in button]
                self.assertEqual([button["data-theme-value"] for button in buttons], ["light", "dark"])
                styles = [link.get("href") for link in elements.matching("link", rel="stylesheet")]
                self.assertEqual(styles, ["/static/moonsage/theme.css", "/static/moonsage/home.css"])

    def test_native_scene_has_one_full_moon_and_four_nodes_in_each_environment(self):
        response = self.client.get(reverse("home"))
        elements = ElementCollector(response.content.decode())
        circles = elements.matching("circle")
        moon = [circle for circle in circles if "data-home-moon" in circle]
        self.assertEqual(len(moon), 1)
        self.assertEqual((moon[0]["cx"], moon[0]["cy"], moon[0]["r"]), ("50", "50", "49"))
        for environment in ("sky", "sea"):
            with self.subTest(environment=environment):
                nodes = [circle for circle in circles if circle.get("data-home-node") == environment]
                self.assertEqual(len(nodes), 4)
                self.assertEqual(len({circle["cy"] for circle in nodes}), 4)
        features = [path["data-lunar-feature"] for path in elements.matching("path") if "data-lunar-feature" in path]
        self.assertEqual(features, [f"mare-{index}" for index in range(4)] + [f"crater-{index}" for index in range(5)])
        for tag in ("filter", "pattern", "animate", "animatetransform"):
            self.assertEqual(elements.matching(tag), [], "The small scene needs no heavy texture or animation")

    def test_shared_scene_carries_its_paint_without_home_stylesheet(self):
        for route in ("home", "login"):
            with self.subTest(route=route):
                elements = ElementCollector(self.client.get(reverse(route)).content.decode())
                groups = {group.get("class"): group for group in elements.matching("g")}
                self.assertEqual(groups["moon-scene-maria"]["fill"], "var(--lunar-terrain)")
                self.assertEqual(groups["moon-scene-maria"]["opacity"], ".16")
                self.assertEqual(groups["moon-scene-crater"]["stroke"], "var(--lunar-terrain)")
                self.assertEqual(groups["moon-scene-ripple"]["stroke"], "var(--scene-ripple)")
                for environment in ("sky", "sea"):
                    self.assertEqual(groups[f"moon-scene-{environment}-node"]["fill"], "var(--lunar-light)")
                if route == "login":
                    styles = [link.get("href") for link in elements.matching("link", rel="stylesheet")]
                    self.assertNotIn("/static/moonsage/home.css", styles)
