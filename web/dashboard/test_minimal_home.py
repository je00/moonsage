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
                self.assertEqual(elements.matching("html")[0].get("data-theme"), "light")
                buttons = [button for button in elements.matching("button") if "data-theme-value" in button]
                self.assertEqual([button["data-theme-value"] for button in buttons], ["light", "dark"])
                styles = [link.get("href") for link in elements.matching("link", rel="stylesheet")]
                self.assertEqual(styles, ["/static/moonsage/theme.css", "/static/moonsage/home.css"])
