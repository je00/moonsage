"""The brand home is public without changing protected console entry points."""

from urllib.parse import urlencode
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.urls import reverse


class LandingPageTests(SimpleTestCase):
    @patch("control_plane.client.AgentClient.request", side_effect=AssertionError("Home must not contact the agent"))
    def test_anonymous_home_renders_without_management_data(self, agent_request):
        response = self.client.get(reverse("home"))
        self.assertEqual(reverse("home"), "/")
        self.assertEqual(reverse("dashboard"), "/overview/")
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "dashboard/home.html")
        self.assertContains(response, "moonsage")
        self.assertNotContains(response, 'name="password"')
        agent_request.assert_not_called()

    def test_home_links_use_existing_protected_destinations(self):
        response = self.client.get(reverse("home"))
        for route in (
            "dashboard", "network-nodes", "network-topology",
            "node-deployment-guide", "deployment-wizard",
        ):
            with self.subTest(route=route):
                self.assertContains(response, f'href="{reverse(route)}"')

    @patch("control_plane.client.AgentClient.request", side_effect=AssertionError("Anonymous visitors cannot contact the agent"))
    def test_all_console_entry_points_still_require_login(self, agent_request):
        for route in (
            "dashboard", "network-nodes", "network-topology",
            "node-deployment-guide", "deployment-wizard",
        ):
            with self.subTest(route=route):
                destination = reverse(route)
                response = self.client.get(destination)
                self.assertRedirects(
                    response, f"{reverse('login')}?next={destination}",
                    fetch_redirect_response=False,
                )
        agent_request.assert_not_called()

    def test_language_is_explicit_local_and_does_not_set_cookies(self):
        for requested, expected in ((None, "zh"), ("zh", "zh"), ("en", "en"), ("fr", "zh"), ("", "zh")):
            with self.subTest(language=requested):
                response = self.client.get(reverse("home"), {} if requested is None else {"lang": requested})
                self.assertEqual(response.context["landing_language"], expected)
                self.assertFalse(response.cookies)
                self.assertEqual(settings.LANGUAGE_CODE, "zh-hans")

    def test_language_changes_copy_and_returns_to_chinese_without_parameter(self):
        chinese = self.client.get(reverse("home"))
        english = self.client.get(reverse("home"), {"lang": "en"})
        self.assertNotEqual(chinese.context["copy"], english.context["copy"])
        self.assertEqual(self.client.get(reverse("home")).context["landing_language"], "zh")


class LandingNavigationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            username="landing-demo", password="Landing-test-password-2026!",
        )

    @patch("control_plane.client.AgentClient.request", side_effect=AssertionError("Home must not contact the agent"))
    def test_authenticated_home_is_still_available_without_management_data(self, agent_request):
        self.client.force_login(self.user)
        response = self.client.get(reverse("home"))
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "dashboard/home.html")
        agent_request.assert_not_called()

    def test_login_without_next_enters_the_protected_overview(self):
        response = self.client.post(reverse("login"), {
            "username": self.user.username,
            "password": "Landing-test-password-2026!",
        })
        self.assertRedirects(response, reverse("dashboard"), fetch_redirect_response=False)

    def test_explicit_home_and_protected_deep_links_remain_valid_login_destinations(self):
        self.client.force_login(self.user)
        for destination in (
            "/?lang=en#explore",
            "/network/nodes/?from=home#nodes",
            "/guides/nodes/?platform=linux#linux",
        ):
            with self.subTest(destination=destination):
                response = self.client.get(reverse("login"), {"next": destination})
                self.assertRedirects(response, destination, fetch_redirect_response=False)

    @patch("dashboard.views.preview_change_task")
    def test_expired_post_without_safe_source_returns_to_overview_without_replay(self, preview_task):
        for referer in ("", "https://untrusted.example/", "http://testserver:9999/deploy/"):
            with self.subTest(referer=referer):
                response = self.client.post(
                    reverse("service-action-preview", kwargs={"service_id": "ssh"}),
                    {"operation": "restart"}, HTTP_REFERER=referer,
                )
                expected = f"{reverse('login')}?{urlencode({'next': reverse('dashboard')})}"
                self.assertRedirects(response, expected, fetch_redirect_response=False)
        preview_task.assert_not_called()

    @patch("dashboard.views.preview_change_task")
    def test_expired_post_keeps_a_safe_source_query_without_replay(self, preview_task):
        source = "/deploy/?service=clash"
        response = self.client.post(
            reverse("service-action-preview", kwargs={"service_id": "ssh"}),
            {"operation": "restart"}, HTTP_REFERER=f"http://testserver{source}",
        )
        expected = f"{reverse('login')}?{urlencode({'next': source})}"
        self.assertRedirects(response, expected, fetch_redirect_response=False)
        preview_task.assert_not_called()
