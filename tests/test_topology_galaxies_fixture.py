"""Credential-free galaxy UI data projected by the production topology model."""

from __future__ import annotations

import copy
import json
import sys
import unittest

from test_topology_permissions_fixture import overview_fixture, build_topology, SECRET_SENTINEL, OBSERVED_AT


EXIT_IDS = ["111111111111", "222222222222", "333333333333", "444444444444"]
INITIAL = "awg:media-server"
IPV6_ID = "awg:nas-backup"
IPV6 = "2001:db8:1234:5678:9abc:def0:1234:5678"
LONG_NAME = "external-galaxy-north-atlantic-backup-26"


def galaxy_overview():
    raw = overview_fixture()
    raw["exit_options"] = [
        {"id": identifier, "name": name, "default": index == 0,
         "server": "private-proxy.example", "port": 1080, "type": "socks5",
         "password": SECRET_SENTINEL, "username": SECRET_SENTINEL,
         "proxy_yaml": SECRET_SENTINEL, "subscription_url": "https://private-subscription.example/secret"}
        for index, (identifier, name) in enumerate(zip(EXIT_IDS, ("north-atlantic", "pacific-edge", LONG_NAME, "quiet-harbor")))
    ]
    assignments = {
        INITIAL: [EXIT_IDS[0], EXIT_IDS[2]],
        "vless:phone-all": [EXIT_IDS[1], EXIT_IDS[3]],
        "awg:office-laptop": [EXIT_IDS[0]],
        IPV6_ID: [EXIT_IDS[2]],
        # Removed IDs and repeated values are not extra galaxies or live routes.
        "awg:lab-server": ["ffffffffffff", EXIT_IDS[1], EXIT_IDS[1]],
        "vless:phone-disabled": [EXIT_IDS[3]],
    }
    for node in raw["nodes"]:
        identifier = f"{node['kind']}:{node['name']}"
        node["exit_ids"] = assignments.get(identifier, [])
        node["exit_names"] = [SECRET_SENTINEL]
        if identifier == IPV6_ID:
            node["address"] = IPV6
    return raw


def projected_models():
    raw = galaxy_overview()
    identifiers = ["hub", *(f"{node['kind']}:{node['name']}" for node in raw["nodes"])]

    def project_all(source):
        return {identifier: {**build_topology(source, identifier), "observed_at": OBSERVED_AT}
                for identifier in identifiers}

    changed = copy.deepcopy(raw)
    changed["exit_options"] = [exit for exit in changed["exit_options"] if exit["id"] != EXIT_IDS[2]]
    changed["exit_options"][0]["name"] = "north-atlantic-updated"
    for node in changed["nodes"]:
        identifier = f"{node['kind']}:{node['name']}"
        if identifier == INITIAL:
            node["exit_ids"] = [EXIT_IDS[3]]
        if identifier == "vless:phone-all":
            node["exit_ids"] = [EXIT_IDS[0]]
    empty = copy.deepcopy(raw)
    empty["exit_options"] = []
    return {"generated_by": "dashboard.topology.build_topology", "initial_selected": INITIAL,
            "models": project_all(raw), "changed": project_all(changed), "empty": project_all(empty),
            "ipv6_node": IPV6_ID, "long_exit_id": EXIT_IDS[2]}


class TopologyGalaxiesFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.packet = projected_models()
        cls.model = cls.packet["models"][INITIAL]

    def test_raw_model_is_not_mutated(self):
        raw = galaxy_overview()
        before = copy.deepcopy(raw)
        build_topology(raw, INITIAL)
        self.assertEqual(raw, before)

    def test_four_separate_galaxies_do_not_become_permission_nodes(self):
        self.assertEqual(len(self.model["exits"]), 4)
        self.assertTrue(all(set(exit) == {"id", "name"} for exit in self.model["exits"]))
        self.assertEqual(len(self.model["nodes"]), 12)
        self.assertEqual(self.model["summary"]["nodes"], 11)
        self.assertTrue(all(node["kind"] in {"hub", "awg", "vless"} for node in self.model["nodes"]))
        self.assertTrue(all(link["source"] not in EXIT_IDS and link["target"] not in EXIT_IDS for link in self.model["links"]))

    def test_assignments_are_exact_and_no_default_is_inferred(self):
        by_id = {node["id"]: node for node in self.model["nodes"]}
        self.assertEqual(by_id[INITIAL]["exit_ids"], [EXIT_IDS[0], EXIT_IDS[2]])
        self.assertEqual(by_id["vless:phone-all"]["exit_ids"], [EXIT_IDS[1], EXIT_IDS[3]])
        self.assertEqual(by_id["awg:lab-server"]["exit_ids"], [])
        self.assertEqual(by_id["awg:travel-laptop"]["exit_ids"], [])
        self.assertEqual(by_id["hub"]["exit_ids"], [])

    def test_addresses_remain_real_and_complete(self):
        by_id = {node["id"]: node for node in self.model["nodes"]}
        self.assertEqual(by_id[IPV6_ID]["address"], IPV6)
        self.assertEqual(by_id["hub"]["address"], "10.77.0.1")
        self.assertEqual(by_id["vless:phone-all"]["address"], "")

    def test_refresh_can_remove_rename_and_reassign_exits(self):
        changed = self.packet["changed"][INITIAL]
        self.assertEqual(changed["selected"]["exit_ids"], [EXIT_IDS[3]])
        self.assertNotIn(EXIT_IDS[2], [exit["id"] for exit in changed["exits"]])
        self.assertEqual(changed["exits"][0]["name"], "north-atlantic-updated")
        self.assertEqual(self.packet["changed"]["vless:phone-all"]["selected"]["exit_ids"], [EXIT_IDS[0]])
        self.assertEqual(self.packet["empty"][INITIAL]["exits"], [])
        self.assertTrue(all(node["exit_ids"] == [] for node in self.packet["empty"][INITIAL]["nodes"]))

    def test_sensitive_resource_fields_never_enter_browser_packet(self):
        serialized = json.dumps(self.packet, ensure_ascii=False)
        for value in (SECRET_SENTINEL, "private-proxy.example", "private-subscription.example", "vless://"):
            self.assertNotIn(value, serialized)


if __name__ == "__main__":
    if "--json" in sys.argv:
        print(json.dumps(projected_models(), ensure_ascii=False))
    else:
        unittest.main()
