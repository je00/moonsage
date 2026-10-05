"""Topology endpoints expose configured access facts through one read only."""

from copy import deepcopy
from html.parser import HTMLParser
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.templatetags.static import static
from django.urls import reverse

from control_plane.client import AgentError


NETWORK = {
    "nodes": [
        {"name": "desktop", "kind": "awg", "kind_label": "AmneziaWG",
         "address": "10.44.0.20", "state": "已启用", "protected": True,
         "access_mode": "unrestricted", "permissions": [],
         "private_key": "must-not-project-private-key", "domains": ["must-not-project.example"]},
        {"name": "phone", "kind": "vless", "kind_label": "VLESS",
         "address": "—", "state": "已启用", "protected": False,
         "access_mode": "restricted", "permissions": []},
    ],
    "pending_access": False, "pending_vless": False,
    "exit_options": [{"password": "must-not-project-proxy-password"}],
    "server_public_key": "must-not-project-key-material",
}


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class TopologyViewTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        users = get_user_model().objects
        cls.viewer = users.create_user("topology-viewer", password="test-only-password")
        cls.staff = users.create_user("topology-staff", password="test-only-password", is_staff=True)
        cls.owner = users.create_superuser("topology-owner", password="test-only-password")

    def setUp(self):
        self.url = reverse("network-topology")
        self.client.force_login(self.viewer)

    @patch("dashboard.topology_views.network_overview", return_value=NETWORK)
    def test_all_authenticated_roles_can_read_safe_projection_once(self, read):
        before = deepcopy(NETWORK)
        for user in (self.viewer, self.staff, self.owner):
            self.client.force_login(user)
            for as_json in (False, True):
                with self.subTest(user=user.username, as_json=as_json):
                    read.reset_mock()
                    response = self.client.get(self.url, {"format": "json"} if as_json else {})
                    self.assertEqual(response.status_code, 200)
                    self.assertIn("no-store", response["Cache-Control"])
                    self.assertNotIn("must-not-project", response.content.decode())
                    read.assert_called_once_with()
                    if as_json:
                        value = response.json()
                        self.assertEqual(value["selected_id"], "awg:desktop")
                        self.assertIn("observed_at", value)
                        self.assertEqual(len(value["nodes"]), 3)
                        self.assertEqual(value["links"], [{
                            "source": "awg:desktop", "target": "hub", "status": "allowed",
                            "label": "全部协议 · 全部端口", "scopes": ["全部协议 · 全部端口"],
                        }])
                    else:
                        self.assertContains(response, "data-topology-root")
                        self.assertContains(response, "未检测")
        self.assertEqual(NETWORK, before)

    @patch("dashboard.topology_views.network_overview")
    def test_exit_configuration_uses_only_safe_catalog_ids_and_names(self, read):
        overview = deepcopy(NETWORK)
        overview["exit_options"] = [
            {"id": "111111111111", "name": "北美 · 主出口", "default": True,
             "server": "must-not-project-proxy.example", "username": "must-not-project-user",
             "proxy": {"password": "must-not-project-password"}},
            {"id": "abcdef123456", "name": "备用出口", "share_uri": "must-not-project-share"},
        ]
        overview["nodes"][0]["exit_ids"] = ["111111111111"]
        overview["nodes"][1]["exit_ids"] = ["abcdef123456", "111111111111"]
        overview["nodes"][1]["address"] = "must-not-project-vless-address.example"
        original = deepcopy(overview)
        read.return_value = overview
        expected = {"hub": [], "awg:desktop": ["111111111111"],
                    "vless:phone": ["abcdef123456", "111111111111"]}
        for selected_id in expected:
            for as_json in (False, True):
                with self.subTest(selected_id=selected_id, as_json=as_json):
                    read.reset_mock()
                    query = {"node": selected_id, **({"format": "json"} if as_json else {})}
                    response = self.client.get(self.url, query)
                    self.assertEqual(response.status_code, 200)
                    read.assert_called_once_with()
                    self.assertNotIn("must-not-project", response.content.decode())
                    value = response.json() if as_json else response.context["topology"]
                    self.assertEqual(value["exits"], [
                        {"id": "111111111111", "name": "北美 · 主出口"},
                        {"id": "abcdef123456", "name": "备用出口"},
                    ])
                    self.assertEqual({node["id"]: node["exit_ids"] for node in value["nodes"]}, expected)
                    self.assertEqual(value["selected"]["exit_ids"], expected[selected_id])
                    for relation in value["relations"]:
                        self.assertEqual(relation["node"]["exit_ids"], expected[relation["node"]["id"]])
                    addresses = {node["id"]: node["address"] for node in value["nodes"]}
                    self.assertEqual(addresses["awg:desktop"], "10.44.0.20")
                    self.assertEqual(addresses["vless:phone"], "")
                    self.assertIn("仅表示配置选择", value["note"])
                    self.assertIn("不代表当前实际流量路径", value["note"])
        self.assertEqual(overview, original)

    @patch("dashboard.topology_views.network_overview")
    def test_malformed_exit_selection_never_reaches_html_or_json(self, read):
        overview = deepcopy(NETWORK)
        overview["exit_options"] = [{"id": "111111111111", "name": "安全名称"}]
        overview["nodes"][0]["exit_ids"] = ["111111111111", {"password": "must-not-project-password"}]
        overview["nodes"][1]["exit_ids"] = ["must-not-project-unknown-id"]
        read.return_value = overview
        for as_json in (False, True):
            response = self.client.get(self.url, {"format": "json"} if as_json else {})
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("must-not-project", response.content.decode())
            value = response.json() if as_json else response.context["topology"]
            self.assertTrue(all(node["exit_ids"] == [] for node in value["nodes"]))
            self.assertTrue(value["warnings"])
            self.assertEqual(value["links"], [{
                "source": "awg:desktop", "target": "hub", "status": "allowed",
                "label": "全部协议 · 全部端口", "scopes": ["全部协议 · 全部端口"],
            }])

    @patch("dashboard.topology_views.network_overview")
    def test_exit_display_text_remains_inert_in_embedded_json(self, read):
        overview = deepcopy(NETWORK)
        name = "</script><b>Moon</b>"
        overview["exit_options"] = [{"id": "111111111111", "name": name}]
        read.return_value = overview
        response = self.client.get(self.url)
        self.assertEqual(response.context["topology"]["exits"], [{"id": "111111111111", "name": name}])
        self.assertNotContains(response, name)
        self.assertContains(response, r"\u003C/script\u003E\u003Cb\u003EMoon\u003C/b\u003E")

    @patch("dashboard.topology_views.network_overview")
    def test_anonymous_and_non_get_requests_never_read(self, read):
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assertEqual(getattr(self.client, method)(self.url).status_code, 405)
        self.client.logout()
        for query in ({}, {"format": "json"}):
            response = self.client.get(self.url, query)
            self.assertEqual(response.status_code, 302)
            self.assertTrue(response["Location"].startswith(reverse("login")))
        read.assert_not_called()

    @patch("dashboard.topology_views.network_overview", return_value=NETWORK)
    def test_selection_and_unknown_id_remain_read_only(self, read):
        response = self.client.get(self.url, {"format": "json", "node": "vless:phone"})
        self.assertEqual(response.json()["selected_id"], "vless:phone")
        all_links = response.json()["links"]
        response = self.client.get(self.url, {"format": "json", "node": "not-a-node"})
        self.assertEqual(response.json()["selected_id"], "awg:desktop")
        self.assertEqual(response.json()["links"], all_links)
        self.assertEqual(read.call_count, 2)

    @patch("dashboard.topology_views.network_overview")
    def test_graph_keeps_all_nodes_and_links_without_pagination(self, read):
        read.return_value = {"nodes": [
            {"name": f"device-{index}", "kind": "awg", "address": f"10.44.0.{index + 2}",
             "state": "已启用", "protected": False, "access_mode": "unrestricted", "permissions": []}
            for index in range(40)
        ]}
        response = self.client.get(self.url, {"format": "json", "page": 2, "limit": 5})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["nodes"]), 41)
        self.assertEqual(len(response.json()["links"]), 1600)
        read.assert_called_once_with()
        response = self.client.get(self.url)
        self.assertNotContains(response, "data-topology-prev")
        self.assertNotContains(response, "data-topology-next")
        self.assertNotContains(response, "data-topology-fit")
        self.assertContains(response, "data-topology-reset")

    @patch("dashboard.topology_views.network_overview", return_value=NETWORK)
    def test_spatial_view_exposes_one_direct_rearrange_action_without_zoom(self, read):
        response = self.client.get(self.url)
        markup = response.content.decode()
        for removed in ("data-topology-projection", "data-topology-zoom", "data-topology-fit"):
            self.assertNotIn(removed, markup)
        self.assertContains(response, "data-topology-reset", count=1)
        self.assertContains(response, "自动重排")
        self.assertContains(response, "VPS 不可移动")
        self.assertContains(response, "自动重排恢复节点位置和默认视角，不改变权限")
        self.assertContains(response, 'data-topology-orbit="reset"')
        for direction in ("left", "right", "up", "down"):
            self.assertNotContains(response, f'data-topology-orbit="{direction}"')
        self.assertNotContains(response, "data-topology-rotate-pad")
        self.assertContains(response, "data-topology-layout-edit", count=1)
        self.assertContains(response, "左右旋转 · 上下滚动")
        self.assertContains(response, "空白和 VPS 仍可上下滚页")

        class Buttons(HTMLParser):
            def __init__(self):
                super().__init__()
                self.parents = []
                self.reset = []

            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if "data-topology-reset" in attrs:
                    self.reset.append((tag, attrs, tuple(self.parents)))
                if tag not in {"input", "link", "meta", "br", "img", "hr"}:
                    self.parents.append((tag, attrs.get("class", "")))

            def handle_endtag(self, tag):
                for index in range(len(self.parents) - 1, -1, -1):
                    if self.parents[index][0] == tag:
                        del self.parents[index:]
                        break

        controls = Buttons()
        controls.feed(markup)
        tag, attrs, parents = controls.reset[0]
        self.assertEqual((tag, attrs.get("type")), ("button", "button"))
        self.assertIn(("div", "topology-primary-bar"), parents)
        self.assertFalse(any(tag == "details" for tag, _ in parents))
        read.assert_called_once_with()

    @patch("dashboard.topology_views.network_overview", return_value=NETWORK)
    def test_lunar_surface_loads_once_before_the_camera_with_defer(self, read):
        response = self.client.get(self.url)
        moon = f'<script src="{static("topology_moon.js")}" defer></script>'
        camera = f'<script src="{static("topology.js")}" defer></script>'
        self.assertContains(response, moon, count=1)
        self.assertContains(response, camera, count=1)
        markup = response.content.decode()
        self.assertLess(markup.index(moon), markup.index(camera))
        read.assert_called_once_with()

    @patch("dashboard.topology_views.network_overview", return_value=NETWORK)
    def test_graph_has_progressive_controls_and_accessible_full_details(self, read):
        response = self.client.get(self.url)
        self.assertContains(response, 'data-topology-mode="overview" aria-pressed="true"')
        self.assertContains(response, 'data-topology-mode="relations"')
        self.assertContains(response, 'data-topology-direction="forward"')
        self.assertContains(response, 'data-topology-direction="reverse"')
        self.assertContains(response, "data-topology-inspector")
        self.assertContains(response, "data-topology-full-details open")
        self.assertNotContains(response, "data-topology-focus")
        self.assertContains(response, "节点 → VPS")
        self.assertContains(response, "VPS → 节点")
        self.assertContains(response, "topology-legend-line route-line flow-inbound", count=1)
        self.assertContains(response, "topology-legend-line route-line flow-outbound", count=1)
        self.assertContains(response, "点空白取消选中")
        self.assertContains(response, "data-topology-mouse-help", count=1)
        self.assertContains(response, "data-topology-touch-help", count=1)
        self.assertContains(response, "箭头表示经 VPS 的访问方向")
        self.assertContains(response, "不代表 VPS 另有访问权限")
        self.assertNotContains(response, "箭头：访问方向（经 VPS）")
        self.assertNotContains(response, "箭头指向访问终点")
        read.assert_called_once_with()

    @patch("dashboard.topology_views.network_overview")
    def test_exit_resources_share_the_scene_without_changing_access_facts(self, read):
        overview = deepcopy(NETWORK)
        overview["exit_options"] = [{"id": "111111111111", "name": "备用出口"}]
        overview["nodes"][0]["exit_ids"] = ["111111111111"]
        read.return_value = overview
        response = self.client.get(self.url)
        markup = response.content.decode()
        self.assertContains(response, 'id="topology-graph"', count=1)
        self.assertContains(response, "data-topology-stage", count=1)
        self.assertContains(response, "data-topology-exit-region", count=1)
        for removed in ("data-topology-exit-field", "data-topology-galaxies", "data-topology-exit-summary",
                        "data-topology-exit-count", "星系"):
            self.assertNotIn(removed, markup)

        class SceneRegions(HTMLParser):
            def __init__(self):
                super().__init__()
                self.parents = []
                self.regions = {}
                self.exit_headings = []
                self.exit_actions = []

            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if any("data-topology-exit-region" in parent for _, parent in self.parents):
                    if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
                        self.exit_headings.append(tag)
                    if tag in {"a", "button", "form"}:
                        self.exit_actions.append(tag)
                for marker in ("data-topology-stage", "data-topology-graph", "data-topology-exit-region"):
                    if marker in attrs:
                        self.regions[marker] = (attrs, tuple(self.parents))
                if tag not in {"input", "link", "meta", "br", "img", "hr"}:
                    self.parents.append((tag, attrs))

            def handle_endtag(self, tag):
                for index in range(len(self.parents) - 1, -1, -1):
                    if self.parents[index][0] == tag:
                        del self.parents[index:]
                        break

        regions = SceneRegions()
        regions.feed(markup)
        _, graph_parents = regions.regions["data-topology-graph"]
        exit_attrs, exit_parents = regions.regions["data-topology-exit-region"]
        self.assertTrue(any("data-topology-stage" in attrs for _, attrs in graph_parents))
        self.assertTrue(any("data-topology-stage" in attrs for _, attrs in exit_parents))
        self.assertFalse(any("data-topology-graph" in attrs for _, attrs in exit_parents))
        self.assertFalse(any("data-topology-exit-region" in attrs for _, attrs in graph_parents))
        self.assertEqual(exit_attrs.get("aria-label"), "订阅出口")
        self.assertEqual(regions.exit_headings, [])
        self.assertEqual(regions.exit_actions, [])
        self.assertContains(response, "topology-legend-line exit-line", count=1)
        self.assertContains(response, "出口配置")
        self.assertContains(response, "亮起表示当前节点订阅中已展示该出口，不代表正在使用或实时连通")
        self.assertLess(markup.index("topology-legend-line exit-line"), markup.index('id="topology-graph"'))
        self.assertContains(response, "topology-legend-line route-line flow-inbound", count=1)
        self.assertContains(response, "topology-legend-line route-line flow-outbound", count=1)
        topology = response.context["topology"]
        self.assertEqual(topology["exits"], [{"id": "111111111111", "name": "备用出口"}])
        self.assertEqual({node["id"] for node in topology["nodes"]}, {"hub", "awg:desktop", "vless:phone"})
        self.assertEqual(topology["summary"]["nodes"], 2)
        self.assertEqual(topology["links"], [{
            "source": "awg:desktop", "target": "hub", "status": "allowed",
            "label": "全部协议 · 全部端口", "scopes": ["全部协议 · 全部端口"],
        }])
        self.assertIn("出口关联仅表示配置选择，不代表当前实际流量路径", topology["note"])
        read.assert_called_once_with()

    @patch("dashboard.topology_views.network_overview")
    def test_read_failures_return_noncacheable_generic_error_without_fake_nodes(self, read):
        for failure in (AgentError("must-not-project-socket", "unavailable"),
                        OSError("must-not-project-path"), RuntimeError("must-not-project-key")):
            read.side_effect = failure
            for as_json in (False, True):
                with self.subTest(failure=type(failure), as_json=as_json):
                    response = self.client.get(self.url, {"format": "json"} if as_json else {})
                    self.assertEqual(response.status_code, 503)
                    self.assertIn("no-store", response["Cache-Control"])
                    self.assertNotIn("must-not-project", response.content.decode())
                    if as_json:
                        self.assertEqual(response.json()["code"], "snapshot_unavailable")
                        self.assertNotIn("nodes", response.json())
                    else:
                        self.assertContains(response, "暂时无法读取", status_code=503)

    @patch("dashboard.topology_views.network_overview")
    def test_malformed_snapshot_is_not_a_valid_empty_network(self, read):
        for value in (None, [], {}, {"nodes": None}, {"nodes": {}}):
            read.return_value = value
            with self.subTest(value=value):
                response = self.client.get(self.url, {"format": "json"})
                self.assertEqual(response.status_code, 503)

    @patch("dashboard.topology_views.network_overview", return_value={"nodes": []})
    def test_real_empty_snapshot_keeps_hub_and_reports_zero_clients(self, read):
        response = self.client.get(self.url, {"format": "json"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["selected_id"], "hub")
        self.assertEqual(response.json()["summary"]["nodes"], 0)
        self.assertEqual(response.json()["relations"], [])
        self.assertEqual(response.json()["links"], [])
