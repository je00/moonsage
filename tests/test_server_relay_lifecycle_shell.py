#!/usr/bin/env python3
"""Mocked shell orchestration: no network, real systemctl, or installed files."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parent.parent
MOCKS = r'''
source "$REPOSITORY/debian_vless_manager.sh"
CONFIG_DIR="$CASE_DIR/config"
CONFIG_PATH="$CONFIG_DIR/xray.json"
SERVER_RELAY_CONFIG="$CASE_DIR/relay.json"
CLASH_SERVICE_CONFIG="$CASE_DIR/clash.json"
CLASH_INPUT_CONFIG="$CASE_DIR/clash.json"
EXIT_DNS_TRANSACTION_ROOT="$CASE_DIR/transactions"
XRAY_BIN=/usr/bin/true
SERVICE_NAME=xray
FILE_MANAGER="$CASE_DIR/publish.sh"
render_server_relay_candidate() {
  cp "$SERVER_RELAY_CONFIG" "$1"
  if [[ "${RETAIN_STATS:-0}" == 1 && "$(< "$SERVER_RELAY_CONFIG")" == old ]]; then
    printf 'residual-stats\n' >> "$1"
  fi
}
systemctl() {
  printf 'service %s\n' "$*" >> "$CASE_DIR/events"
  [[ "${RESTORE_FAIL:-0}" != 1 || "$1" != restart ]]
}
exit_dns_lifecycle() {
  printf 'dns %s\n' "$1" >> "$CASE_DIR/events"
  [[ "$1" != "${DNS_FAIL:-none}" ]]
}
activate_xray_candidate() {
  printf 'activate\n' >> "$CASE_DIR/events"
  cp "$CONFIG_PATH" "$2"
  cp "$1" "$CONFIG_PATH"
}
python3() {
  [[ "$2" == enable-vless ]] || return 91
  printf 'enabled\n' > "$SERVER_RELAY_CONFIG"
}
'''


class RelayShellLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "config").mkdir()
        (self.root / "config/xray.json").write_text("old\n")
        (self.root / "relay.json").write_text("new\n")
        (self.root / "clash.json").write_text("{}\n")
        (self.root / "publish.sh").write_text(
            'printf "publish\\n" >> "$CASE_DIR/events"\nexit "${PUBLISH_FAIL:-0}"\n'
        )

    def run_shell(self, command="refresh_server_relay", **environment):
        return subprocess.run(
            ["bash", "-c", MOCKS + "\n" + command],
            env={**os.environ, "REPOSITORY": str(REPOSITORY), "CASE_DIR": str(self.root), **environment},
            text=True, capture_output=True,
        )

    def events(self):
        return (self.root / "events").read_text().splitlines()

    def test_workers_ready_before_main_switch_and_deleted_only_after_switch(self):
        result = self.run_shell()
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events()
        self.assertLess(events.index("dns apply"), events.index("activate"))
        self.assertLess(events.index("activate"), events.index("dns commit"))
        self.assertNotIn("dns rollback", events)

    def test_worker_failure_leaves_main_config_untouched(self):
        result = self.run_shell(DNS_FAIL="apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "config/xray.json").read_text(), "old\n")
        self.assertNotIn("activate", self.events())
        self.assertIn("dns rollback", self.events())

    def test_partial_delete_commit_failure_restores_workers_before_main(self):
        result = self.run_shell(DNS_FAIL="commit")
        self.assertNotEqual(result.returncode, 0)
        events = self.events()
        self.assertLess(events.index("dns rollback"), events.index("service restart xray"))
        self.assertEqual((self.root / "config/xray.json").read_text(), "old\n")

    def test_unchanged_main_still_commits_retired_workers_without_restart(self):
        (self.root / "relay.json").write_text("old\n")
        result = self.run_shell()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.events(), ["dns prepare", "dns apply", "dns commit"])

    def test_failed_recovery_is_reported_and_backups_retained(self):
        result = self.run_shell(DNS_FAIL="commit", RESTORE_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SERVER_KIT_DIAGNOSTIC:permission_recovery_required", result.stderr)
        self.assertTrue(list((self.root / "config").glob("xray.json.bak.*")))
        self.assertTrue(list((self.root / "transactions").glob("change.*")))

    def test_first_vless_enable_prepares_workers_before_switch_and_publish(self):
        result = self.run_shell("enable_vless_server_relay")
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events()
        self.assertLess(events.index("dns apply"), events.index("activate"))
        self.assertLess(events.index("dns commit"), events.index("publish"))
        self.assertEqual((self.root / "relay.json").read_text(), "enabled\n")

    def test_failed_publish_after_first_enable_restores_relay_and_workers(self):
        (self.root / "relay.json").write_text("old\n")
        result = self.run_shell("enable_vless_server_relay", PUBLISH_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "relay.json").read_text(), "old\n")
        self.assertEqual((self.root / "config/xray.json").read_text(), "old\n")
        events = self.events()
        self.assertEqual(events.count("dns prepare"), 2)
        self.assertEqual(events.count("dns commit"), 2)
        self.assertEqual(events.count("activate"), 2)

    def test_legacy_ss_port_operations_require_worker_baseline_first(self):
        for command in ("enable_server_relay 2083", "disable_shadowsocks_server_relay"):
            with self.subTest(command=command):
                (self.root / "events").write_text("")
                result = self.run_shell(command, DNS_FAIL="apply")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("dns apply", self.events())
                self.assertIn("dns rollback", self.events())
                self.assertNotIn("activate", self.events())
                self.assertEqual((self.root / "relay.json").read_text(), "new\n")
                self.assertEqual((self.root / "config/xray.json").read_text(), "old\n")

    def test_failed_first_enable_removes_residual_stats_and_restores_exact_xray(self):
        (self.root / "relay.json").write_text("old\n")
        config = self.root / "config/xray.json"
        config.chmod(0o640)
        result = self.run_shell("enable_vless_server_relay", PUBLISH_FAIL="1", RETAIN_STATS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config.read_bytes(), b"old\n")
        self.assertEqual(config.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.events().count("service restart xray"), 1)


if __name__ == "__main__":
    unittest.main()
