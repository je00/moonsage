"""Private subscription settings use the existing owner-scoped task workflow."""

import copy
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.conf import settings
from django.test import Client, SimpleTestCase, TestCase
from django.urls import reverse

from control_plane.client import AgentError
from .services import SUBSCRIPTION_RULES_REQUEST_MAX_BYTES, preview_subscription_rules_task, subscription_rules_status
from .task_navigation import task_navigation_context


REVISION = "a" * 64
TASK_ID = "task-" + "e" * 32
RULES = {
    "schema_version": 1, "version": 1, "revision": REVISION,
    "direct_rules": [{"match": "suffix", "value": "direct.example.com"}],
    "dns_rules": [{"match": "exact", "value": "dns.example.com", "route": "PROXY",
                   "servers": ["https://8.8.8.8/dns-query"]}],
}
TASK = {
    "id": TASK_ID, "action": "network.subscription_rules.change", "actor": "rules-admin",
    "state": "waiting_confirmation", "state_label": "待确认", "terminal": False,
    "preview": {"title": "保存订阅规则", "summary": "统一确认", "facts": {"直连规则": 2}},
}


class SubscriptionRulesUITests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = get_user_model().objects.create_user("rules-admin", is_staff=True)
        cls.viewer = get_user_model().objects.create_user("rules-viewer")

    def setUp(self):
        self.client.force_login(self.admin)
        self.url = reverse("network-subscriptions")
        self.preview_url = reverse("network-subscription-rules-preview")
        self.execute_url = reverse("network-subscription-rules-execute")
        self.status = self.mock("subscription_rules_status", return_value=copy.deepcopy(RULES))
        self.preview = self.mock("preview_subscription_rules_task", return_value=copy.deepcopy(TASK))
        self.read_task = self.mock("change_task", return_value=copy.deepcopy(TASK))
        self.confirm = self.mock("confirm_change_task", return_value={**TASK, "state": "queued"})
        self.overview = self.mock("network_overview", return_value={"nodes": [], "writes_enabled": True})
        self.mock("public_endpoint_status", return_value={"fqdn": ""})
        self.mock("public_endpoint_transaction_status", return_value={"state": "idle"})
        self.mock("duckdns_status", return_value={})

    def mock(self, name, **kwargs):
        patcher = patch("dashboard.views." + name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def data(self, **changes):
        return {
            "rules_present": "1", "expected_revision": REVISION,
            "direct_match": ["suffix", "cidr"],
            "direct_value": ["DIRECT.Example.com.", "192.168.50.0/24"],
            "dns_match": ["exact"], "dns_value": ["dns.example.com"],
            "dns_servers": ["https://8.8.8.8/dns-query, https://1.0.0.1/dns-query"],
            "dns_route": ["PROXY"], **changes,
        }

    def test_page_has_scoped_forms_and_persistence_explanation(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        for text in ("指定直连 / 指定 DNS", "规则独立保存在 VPS", "不进入 Git 仓库", "保存后请在客户端刷新订阅", "不修改 Xray 服务端强制 DNS", "data-rules-form", "data-rule-template", 'value="' + REVISION + '"'):
            self.assertContains(response, text)
        self.assertContains(response, "稳定公网入口")
        self.assertContains(response, "全局订阅强制解析")
        self.assertIn("no-store", response["Cache-Control"])

    def test_viewer_can_read_but_not_edit(self):
        self.client.force_login(self.viewer)
        response = self.client.get(self.url)
        self.assertContains(response, "direct.example.com")
        self.assertContains(response, "https://8.8.8.8/dns-query")
        self.assertNotContains(response, "data-rules-form")
        self.assertNotContains(response, "data-rule-template")
        self.assertEqual(self.client.post(self.preview_url, self.data()).status_code, 403)
        self.assertEqual(self.client.post(self.execute_url, {"task_id": TASK_ID}).status_code, 403)
        self.preview.assert_not_called()
        self.confirm.assert_not_called()

    def test_writes_disabled_has_no_editor(self):
        self.overview.return_value["writes_enabled"] = False
        self.assertNotContains(self.client.get(self.url), "data-rules-form")

    def test_status_error_hides_editor_without_faking_empty_rules(self):
        for result in ({}, {**RULES, "revision": None}, {**RULES, "direct_rules": None},
                       {**RULES, "dns_rules": [{}]}, {**RULES, "dns_rules": [{**RULES["dns_rules"][0], "servers": ["https://dns.example.com/dns-query"]}]}):
            self.status.return_value = result
            response = self.client.get(self.url)
            self.assertContains(response, "现有规则不会清除")
            self.assertContains(response, 'data-rules-ready="false"')
            self.assertNotContains(response, "data-rules-form")
        self.status.side_effect = AgentError("private socket path")
        self.assertNotContains(self.client.get(self.url), "private socket path")

    def test_all_rules_normalized_in_one_preview_with_revision(self):
        response = self.client.post(self.preview_url, self.data())
        self.assertEqual(response.status_code, 200)
        self.preview.assert_called_once_with([
            {"match": "suffix", "value": "direct.example.com"},
            {"match": "cidr", "value": "192.168.50.0/24"},
        ], [{"match": "exact", "value": "dns.example.com", "servers": [
            "https://8.8.8.8/dns-query", "https://1.0.0.1/dns-query",
        ], "route": "PROXY"}], "rules-admin", REVISION)
        self.assertContains(response, 'id="inline-task-preview"')
        self.assertContains(response, self.execute_url)
        self.confirm.assert_not_called()

    def test_empty_lists_are_explicit_clear_not_missing_form(self):
        self.assertEqual(self.client.post(self.preview_url, {"rules_present": "1", "expected_revision": REVISION}).status_code, 200)
        self.preview.assert_called_once_with([], [], "rules-admin", REVISION)
        self.preview.reset_mock()
        self.assertEqual(self.client.post(self.preview_url, {}).status_code, 400)
        self.preview.assert_not_called()

    def test_invalid_form_rejects_whole_batch(self):
        invalid = [
            {"direct_match": ["suffix"]}, {"expected_revision": ""},
            {"direct_value": ["https://example.com", "192.168.50.0/24"]},
            {"direct_value": ["a.example.com", "192.168.50.1/24"]},
            {"dns_route": ["MID"]}, {"dns_servers": ["https://dns.example.com/dns-query"]},
            {"dns_servers": ["8.8.8.8"]}, {"dns_servers": ["https://8.8.8.8/dns-query#DIRECT"]},
            {"dns_servers": ["https://8.8.8.8/dns-query " * 5]},
            {"direct_match": ["suffix"] * 129, "direct_value": ["a.example.com"] * 129},
            {"direct_match": ["suffix"] * 2, "direct_value": ["a.example.com"] * 2},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                self.assertEqual(self.client.post(self.preview_url, self.data(**changes)).status_code, 400)
        self.preview.assert_not_called()
        self.status.assert_not_called()

    def test_direct_dns_only_exception_is_explicit(self):
        self.status.return_value["dns_rules"][0].update(route="DIRECT", servers=["223.5.5.5"])
        response = self.client.get(self.url)
        self.assertContains(response, "仅这些域名的 DNS 直连，其余仍统一出口")
        self.assertContains(response, 'value="DIRECT" selected')
        response = self.client.post(self.preview_url, self.data(dns_route=["DIRECT"], dns_servers=["223.5.5.5\n1.12.12.12"]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.preview.call_args.args[1][0]["servers"], ["223.5.5.5", "1.12.12.12"])

    def test_read_failure_or_concurrent_update_never_overwrites(self):
        self.status.side_effect = OSError("private")
        self.assertEqual(self.client.post(self.preview_url, self.data()).status_code, 503)
        self.status.side_effect = None
        self.status.return_value["revision"] = "b" * 64
        self.assertEqual(self.client.post(self.preview_url, self.data()).status_code, 409)
        self.preview.assert_not_called()

    def test_agent_error_is_not_implicitly_executed_or_leaked(self):
        self.preview.side_effect = AgentError("private backend path")
        response = self.client.post(self.preview_url, self.data())
        self.assertEqual(response.status_code, 503)
        self.assertNotContains(response, "private backend path", status_code=503)
        self.confirm.assert_not_called()

    @patch("dashboard.services.AgentClient")
    def test_large_valid_rule_batch_reports_size_error_before_socket(self, client):
        self.preview.side_effect = preview_subscription_rules_task
        count = 60
        servers = ", ".join("https://8.8.8.8/" + "a" * 300 + str(index) for index in range(4))
        response = self.client.post(self.preview_url, self.data(
            dns_match=["exact"] * count,
            dns_value=[f"dns{index}.example.com" for index in range(count)],
            dns_servers=[servers] * count,
            dns_route=["PROXY"] * count,
        ))
        self.assertEqual(response.status_code, 400)
        self.assertContains(response, "超过 60 KiB", status_code=400)
        self.assertContains(response, "现有规则未修改", status_code=400)
        client.assert_not_called()
        self.confirm.assert_not_called()

    def test_confirmation_checks_actor_action_id_and_is_idempotent(self):
        for changed in ({"actor": "other"}, {"action": "service.restart"}, {"id": "task-" + "f" * 32}):
            self.read_task.return_value = {**TASK, **changed}
            self.assertEqual(self.client.post(self.execute_url, {"task_id": TASK_ID}).status_code, 403)
        self.confirm.assert_not_called()
        self.read_task.return_value = copy.deepcopy(TASK)
        self.assertRedirects(self.client.post(self.execute_url, {"task_id": TASK_ID}), reverse("change-task-detail", args=[TASK_ID]), fetch_redirect_response=False)
        self.confirm.assert_called_once_with(TASK_ID, "rules-admin")
        self.confirm.reset_mock()
        self.read_task.return_value["state"] = "queued"
        self.client.post(self.execute_url, {"task_id": TASK_ID})
        self.confirm.assert_not_called()

    def test_auth_csrf_and_methods(self):
        csrf = Client(enforce_csrf_checks=True)
        csrf.force_login(self.admin)
        self.assertEqual(csrf.post(self.preview_url, self.data()).status_code, 403)
        self.assertEqual(csrf.post(self.execute_url, {"task_id": TASK_ID}).status_code, 403)
        self.assertEqual(self.client.get(self.preview_url).status_code, 405)
        self.assertEqual(self.client.get(self.execute_url).status_code, 405)
        self.client.logout()
        self.assertEqual(self.client.post(self.preview_url, self.data()).status_code, 302)
        self.preview.assert_not_called()
        self.confirm.assert_not_called()

    def test_valid_csrf_multipart_body_is_not_read_twice(self):
        csrf = Client(enforce_csrf_checks=True)
        csrf.force_login(self.admin)
        csrf.get(self.url)
        token = csrf.cookies[settings.CSRF_COOKIE_NAME].value
        response = csrf.post(self.preview_url, self.data(), HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 200)
        self.preview.assert_called_once()

    def test_task_facts_and_json_are_escaped(self):
        self.preview.return_value["preview"]["facts"] = {"规则": "</script><img src=x onerror=alert(1)>"}
        response = self.client.post(self.preview_url, self.data())
        self.assertNotContains(response, "<img src=x")
        self.assertContains(response, "&lt;img")
        self.assertContains(response, "\\u003C/script\\u003E")

    def test_inline_confirmation_supports_only_owned_rule_tasks(self):
        with patch("dashboard.inline_tasks.change_task", return_value=copy.deepcopy(TASK)), patch("dashboard.inline_tasks.confirm_change_task", return_value={**TASK, "state": "queued"}) as confirm:
            response = self.client.post(reverse("inline-task-execute"), {"task_id": TASK_ID}, content_type="application/json")
            self.assertEqual(response.status_code, 200)
            confirm.assert_called_once_with(TASK_ID, "rules-admin")

    def test_task_origin_returns_to_rules_section(self):
        self.assertEqual(task_navigation_context(TASK, {}, TASK_ID)["task_origin"]["url"], self.url + "#subscription-rules")

    @patch("dashboard.services.AgentClient")
    def test_service_protocol_forwards_only_settings_actor_and_revision(self, client):
        subscription_rules_status()
        client.return_value.request.assert_called_with("network.subscription_rules.status", {})
        preview_subscription_rules_task([], [], "rules-admin", REVISION)
        client.return_value.request.assert_called_with("task.preview", {
            "action": "network.subscription_rules.change", "arguments": {"direct_rules": [], "dns_rules": [], "expected_revision": REVISION}, "actor": "rules-admin",
        })


class SubscriptionRuleRequestSizeTests(SimpleTestCase):
    def payload(self, value, actor="rules-admin"):
        return {"version": 1, "request_id": "0" * 32, "action": "task.preview", "params": {
            "action": "network.subscription_rules.change", "arguments": {
                "direct_rules": [{"match": "exact", "value": value}], "dns_rules": [],
                "expected_revision": REVISION,
            }, "actor": actor,
        }}

    def wire_size(self, value, actor="rules-admin"):
        return len(json.dumps(self.payload(value, actor), ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1

    @patch("dashboard.services.AgentClient")
    def test_request_at_60_kib_is_allowed_but_one_byte_over_never_opens_socket(self, client):
        exact_value = "x" * (SUBSCRIPTION_RULES_REQUEST_MAX_BYTES - self.wire_size(""))
        self.assertEqual(self.wire_size(exact_value), 60 * 1024)
        preview_subscription_rules_task([{"match": "exact", "value": exact_value}], [], "rules-admin", REVISION)
        client.return_value.request.assert_called_once()
        client.reset_mock()
        with self.assertRaisesMessage(AgentError, "超过 60 KiB") as raised:
            preview_subscription_rules_task([{"match": "exact", "value": exact_value + "x"}], [], "rules-admin", REVISION)
        self.assertEqual(raised.exception.code, "invalid_params")
        client.assert_not_called()

    @patch("dashboard.services.AgentClient")
    def test_unicode_actor_and_rules_are_counted_as_utf8_bytes_not_characters(self, client):
        actor = "管理员"
        room = SUBSCRIPTION_RULES_REQUEST_MAX_BYTES - self.wire_size("", actor)
        value = "海" * (room // 3) + "x" * (room % 3)
        self.assertEqual(self.wire_size(value, actor), SUBSCRIPTION_RULES_REQUEST_MAX_BYTES)
        preview_subscription_rules_task([{"match": "exact", "value": value}], [], actor, REVISION)
        client.reset_mock()
        with self.assertRaisesMessage(AgentError, "超过 60 KiB"):
            preview_subscription_rules_task([{"match": "exact", "value": value + "海"}], [], actor, REVISION)
        client.assert_not_called()
