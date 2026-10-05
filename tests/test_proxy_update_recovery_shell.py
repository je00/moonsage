#!/usr/bin/env python3
"""Proxy-update rollback orchestration with isolated files and mocked managers."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parent.parent
MOCKS = r'''
set -euo pipefail
SCRIPT_DIR="$REPOSITORY"
CLASH_INPUT_CONFIG="$CASE_DIR/inputs.json"
CLASH_CONFIG="$CASE_DIR/clash.json"
VLESS_MANAGER="$CASE_DIR/relay.sh"
FILE_MANAGER="$CASE_DIR/publish.sh"
SERVER_KIT_NETWORK_WRITES=1
mktemp() { command mktemp "$CASE_DIR/temporary.XXXXXX"; }
copy_count=0
cp() {
  copy_count=$((copy_count + 1))
  if [[ "${COPY_RESTORE_FAIL:-0}" == 1 && "$copy_count" == 2 ]]; then return 1; fi
  command cp "$@"
}
python3() {
  [[ "$2" == update ]] || return 90
  printf 'new\n' > "$3"
  printf '{"updated":true}\n'
}
if update_proxy_resources_json; then exit 0; else exit 1; fi
'''


class ProxyUpdateRecoveryShellTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name, content in (('inputs.json', 'old\n'), ('clash.json', '{}\n'), ('server-relay.json', '{}\n')):
            (self.root / name).write_text(content)
        (self.root / 'relay.sh').write_text(r'''
count=0
[[ ! -f "$CASE_DIR/relay-count" ]] || read -r count < "$CASE_DIR/relay-count"
count=$((count + 1))
printf '%s\n' "$count" > "$CASE_DIR/relay-count"
printf 'relay %s %s\n' "$count" "$(< "$CASE_DIR/inputs.json")" >> "$CASE_DIR/events"
if [[ "${RELAY_FAIL_AT:-none}" == all || "${RELAY_FAIL_AT:-none}" == "$count" ]]; then
  printf 'private relay credential=must-not-leak\n' >&2
  exit 1
fi
''')
        (self.root / 'publish.sh').write_text(r'''
printf 'publish\n' >> "$CASE_DIR/events"
if [[ "${PUBLISH_FAIL:-0}" == 1 ]]; then
  printf 'private subscription=must-not-leak\n' >&2
  [[ "${PUBLISH_RECOVERY_FAIL:-0}" != 1 ]] || printf 'SERVER_KIT_DIAGNOSTIC:permission_recovery_required\n' >&2
  exit 1
fi
''')

    def run_shell(self, **environment):
        # Only load these exact production functions: unrelated Linux manager
        # startup uses associative arrays absent from macOS's built-in Bash.
        source = (REPOSITORY / 'server-kit-manager.sh').read_text()
        functions = '\n'.join(
            name + '() {\n' + source.split('\n' + name + '() {\n', 1)[1].split('\n}\n', 1)[0] + '\n}\n'
            for name in ('fail', 'safe_diagnostic', 'update_proxy_resources_json')
        )
        return subprocess.run(['bash', '-c', functions + MOCKS],
                              env={**os.environ, 'REPOSITORY': str(REPOSITORY), 'CASE_DIR': str(self.root), **environment},
                              text=True, capture_output=True)

    def assert_recovery_required(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SERVER_KIT_DIAGNOSTIC:permission_recovery_required', result.stderr)
        self.assertNotIn('已恢复', result.stderr)
        self.assertNotIn('must-not-leak', result.stdout + result.stderr)
        backups = list(self.root.glob('temporary.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), 'old\n')
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

    def test_failed_relay_recovery_is_reported_and_backup_retained(self):
        self.assert_recovery_required(self.run_shell(RELAY_FAIL_AT='all'))
        self.assertEqual((self.root / 'inputs.json').read_text(), 'old\n')
        self.assertEqual((self.root / 'events').read_text().splitlines(), ['relay 1 new', 'relay 2 old'])

    def test_failed_subscription_then_relay_recovery_is_reported(self):
        self.assert_recovery_required(self.run_shell(PUBLISH_FAIL='1', RELAY_FAIL_AT='2'))
        self.assertEqual((self.root / 'events').read_text().splitlines(), ['relay 1 new', 'publish', 'relay 2 old'])

    def test_failed_restore_copy_does_not_reapply_new_configuration(self):
        self.assert_recovery_required(self.run_shell(RELAY_FAIL_AT='1', COPY_RESTORE_FAIL='1'))
        self.assertEqual((self.root / 'events').read_text().splitlines(), ['relay 1 new'])

    def test_downstream_incomplete_publication_recovery_is_not_hidden(self):
        self.assert_recovery_required(self.run_shell(PUBLISH_FAIL='1', PUBLISH_RECOVERY_FAIL='1'))

    def test_successful_relay_rollback_reports_only_original_failure(self):
        result = self.run_shell(RELAY_FAIL_AT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SERVER_KIT_DIAGNOSTIC:proxy_relay_refresh_failed', result.stderr)
        self.assertNotIn('permission_recovery_required', result.stderr)
        self.assertNotIn('must-not-leak', result.stderr)
        self.assertEqual((self.root / 'inputs.json').read_text(), 'old\n')
        self.assertFalse(list(self.root.glob('temporary.*')))

    def test_successful_subscription_rollback_does_not_claim_service_recovery(self):
        result = self.run_shell(PUBLISH_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SERVER_KIT_DIAGNOSTIC:proxy_subscription_refresh_failed', result.stderr)
        self.assertNotIn('permission_recovery_required', result.stderr)
        self.assertNotIn('已恢复原配置和订阅', result.stderr)
        self.assertFalse(list(self.root.glob('temporary.*')))

    def test_success_stays_successful_and_drops_temporary_backup(self):
        result = self.run_shell()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"updated":true', result.stdout)
        self.assertEqual((self.root / 'inputs.json').read_text(), 'new\n')
        self.assertFalse(list(self.root.glob('temporary.*')))


if __name__ == '__main__':
    unittest.main()
