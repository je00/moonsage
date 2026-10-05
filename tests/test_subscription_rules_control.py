"""Private rule tasks and safe publication never mutate the data plane."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from control_plane.actions import ActionKind, validate_action_request
from control_plane.core import ControlPlane
from control_plane.runner import ScriptRunner
from control_plane.task_crypto import TaskPayloadCipher
from control_plane.tasks import ChangeTaskEngine, TaskEngineError
from lib.server_kit_backup import _is_allowed_source
from lib.server_kit_subscription_rules import default_config, normalize_config, revision


POLICY = {"version": 1, "direct_rules": [{"match": "suffix", "value": "private.example.com"}], "dns_rules": [{
    "match": "exact", "value": "private.example.com", "servers": ["https://9.9.9.9/dns-query"], "route": "PROXY",
}]}


class RulesRunner:
    def __init__(self):
        self.state = default_config()
        self.changes = []

    def subscription_rules_status(self):
        return {"schema_version": 1, **copy.deepcopy(self.state), "revision": revision(self.state)}

    def change_subscription_rules(self, config, expected, actor):
        if expected != revision(self.state):
            raise ValueError("revision")
        self.state = copy.deepcopy(config)
        self.changes.append(actor)
        return {"schema_version": 1, "operation": "set", "direct_count": len(config["direct_rules"]), "dns_count": len(config["dns_rules"])}


class RulesControlTests(unittest.TestCase):
    def setUp(self):
        self.runner = RulesRunner()
        self.control = ControlPlane(self.runner, {1000})
        self.arguments = {key: copy.deepcopy(POLICY[key]) for key in ("direct_rules", "dns_rules")}
        self.arguments["expected_revision"] = revision(self.runner.state)

    def test_action_is_task_only_and_sensitive(self):
        action = validate_action_request("network.subscription_rules.change", {**self.arguments, "actor": "admin", "confirmed": True})
        self.assertEqual(action.kind, ActionKind.CHANGE)
        self.assertTrue(action.task_only)
        self.assertEqual(action.sensitive_fields, {"direct_rules", "dns_rules"})

    def test_preview_uses_counts_and_encryptable_payload(self):
        prepared = self.control.prepare_task_action("network.subscription_rules.change", self.arguments, "admin")
        self.assertNotIn("private.example.com", json.dumps(dict(prepared.params)))
        self.assertNotIn("private.example.com", json.dumps(dict(prepared.preview)))
        self.assertEqual(prepared.sensitive_params["direct_rules"], POLICY["direct_rules"])
        self.assertEqual(prepared.fact_digest, revision(self.runner.state))

    def test_stale_editor_cannot_overwrite_other_changes(self):
        self.runner.state = normalize_config(POLICY)
        with self.assertRaises(TaskEngineError) as error:
            self.control.prepare_task_action("network.subscription_rules.change", self.arguments, "admin")
        self.assertEqual(error.exception.code, "facts_changed")

    def test_invalid_policy_and_extra_fields_rejected(self):
        for patch in ({"dns_rules": [{"match": "suffix", "value": "*", "servers": [], "route": "DIRECT"}]}, {"path": "/tmp/unsafe"}):
            with self.assertRaises(TaskEngineError):
                self.control.prepare_task_action("network.subscription_rules.change", {**self.arguments, **patch}, "admin")

    def test_task_payload_is_encrypted_and_concurrent_change_invalidates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            engine = ChangeTaskEngine(path / "tasks.db", self.control.prepare_task_action, self.control.execute_task_action,
                                      self.control.inspect_task_action, TaskPayloadCipher(path / "keys" / "key"), start_worker=False)
            task = engine.preview("network.subscription_rules.change", self.arguments, "admin")
            with sqlite3.connect(path / "tasks.db") as database:
                row = database.execute("SELECT params_json, preview_json, payload_ciphertext FROM tasks").fetchone()
                self.assertNotIn("private.example.com", " ".join(row))
                self.assertTrue(row[2])
            engine.confirm(task["id"], "admin")
            self.runner.state = copy.deepcopy(POLICY)
            engine.process_one()
            self.assertEqual(engine.get(task["id"])["state"], "invalidated")
            self.assertFalse(self.runner.changes)

    def test_task_executes_revalidated_sensitive_rules(self):
        prepared = self.control.prepare_task_action("network.subscription_rules.change", self.arguments, "admin")
        result = self.control.execute_task_action("network.subscription_rules.change", {**prepared.params, **prepared.sensitive_params})
        self.assertEqual(self.runner.state, POLICY)
        self.assertEqual(result["direct_count"], 1)
        self.assertNotIn("private.example.com", json.dumps(result))

    def test_private_policy_is_already_in_encrypted_backup_scope(self):
        self.assertTrue(_is_allowed_source("etc/server-kit/subscription-rules.json"))

    def test_script_runner_sends_stdin_and_audits_only_action(self):
        calls = []
        def execute(args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 0, json.dumps({"schema_version": 1, "operation": "set", **POLICY}), "")
        with tempfile.TemporaryDirectory() as directory:
            audit = Path(directory) / "audit.jsonl"
            runner = ScriptRunner("/test/manager.sh", executor=execute, audit_path=str(audit), network_writes=True)
            result = runner.change_subscription_rules(POLICY, revision(default_config()), "admin")
            self.assertNotIn("private.example.com", json.dumps(calls[0][0]))
            self.assertIn("private.example.com", calls[0][1]["input"])
            self.assertNotIn("private.example.com", audit.read_text())
            self.assertNotIn("private.example.com", json.dumps(result))

    def test_status_validates_revision_and_schema(self):
        status = self.runner.subscription_rules_status()
        def execute(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, json.dumps(status), "")
        runner = ScriptRunner("/test/manager.sh", executor=execute)
        self.assertEqual(runner.subscription_rules_status(), status)
        status["revision"] = "0" * 64
        with self.assertRaises(RuntimeError):
            runner.subscription_rules_status()

    def test_direct_mutation_protocol_is_not_a_task_bypass(self):
        response = self.control.handle({"version": 1, "request_id": "rules", "action": "network.subscription_rules.change",
                                        "params": {**self.arguments, "actor": "admin", "confirmed": True}}, 1000)
        self.assertFalse(response["ok"])
        self.assertFalse(self.runner.changes)

    def test_runner_timeout_signals_process_group_and_allows_rollback_grace(self):
        runner = ScriptRunner("/test/manager.sh")
        with patch("control_plane.runner.subprocess.Popen") as popen, patch("control_plane.runner.os.killpg") as killpg:
            child = popen.return_value.__enter__.return_value
            child.pid = 12345
            child.communicate.side_effect = [subprocess.TimeoutExpired("test", 180), ("", "")]
            with self.assertRaises(subprocess.TimeoutExpired):
                runner._run_subscription_rules("{}")
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            killpg.assert_called_once_with(12345, signal.SIGTERM)
            self.assertEqual(child.communicate.call_args_list[0].kwargs["timeout"], 180)
            self.assertEqual(child.communicate.call_args_list[1].kwargs["timeout"], 60)


class RulesShellTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name)
        self.rules = self.path / "rules.json"
        self.config = self.path / "clash.json"
        self.config.write_text("{}")
        self.fake_manager = self.path / "file-manager.sh"
        self.fake_manager.write_text("#!/bin/bash\n[[ $1 == refresh-clash-rules ]] || exit 99\n[[ ${REFRESH_RESULT:-0} == 0 ]] || exit 1\ncp \"$2\" \"$3\"\n")
        script = (ROOT / "server-kit-manager.sh").read_text()
        self.functions = script[script.index("show_subscription_rules_json() {"):script.index("sync_network_subscriptions_json() {")]
        self.environment = {**os.environ, "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"],
                            "SCRIPT_DIR": str(ROOT), "SUBSCRIPTION_RULES_PATH": str(self.rules),
                            "FILE_MANAGER": str(self.fake_manager), "CLASH_CONFIG": str(self.config),
                            "SERVER_KIT_NETWORK_WRITES": "1"}

    def tearDown(self):
        self.directory.cleanup()

    def run_set(self, config, **environment):
        return subprocess.run(["bash", "-c", "set -euo pipefail\nfail() { echo failed >&2; return 1; }\n" + self.functions + "\nset_subscription_rules_json"],
                              input=json.dumps(config), capture_output=True, text=True, env={**self.environment, **environment})

    def test_private_write_success_and_root_only_permissions(self):
        result = self.run_set({**POLICY, "expected_revision": revision(default_config())})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.rules.read_text()), POLICY)
        self.assertEqual(self.rules.stat().st_mode & 0o777, 0o600)

    def test_refresh_failure_restores_exact_previous_rules(self):
        previous = '{ "version": 1, "direct_rules": [], "dns_rules": [] }\n'
        self.rules.write_text(previous)
        result = self.run_set(POLICY, REFRESH_RESULT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.rules.read_text(), previous)
        self.assertNotIn("private.example.com", result.stderr)

    def test_failure_without_previous_file_restores_absence(self):
        self.assertNotEqual(self.run_set(POLICY, REFRESH_RESULT="1").returncode, 0)
        self.assertFalse(self.rules.exists())

    def test_revision_checked_under_management_lock(self):
        result = self.run_set({**POLICY, "expected_revision": "0" * 64})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SERVER_KIT_DIAGNOSTIC:subscription_rules_changed", result.stderr)
        self.assertFalse(self.rules.exists())

    def test_malformed_existing_rules_fail_closed(self):
        self.rules.write_text("not json")
        self.assertNotEqual(self.run_set(POLICY).returncode, 0)
        self.assertEqual(self.rules.read_text(), "not json")

    def test_symlink_config_cannot_redirect_private_writes(self):
        target = self.path / "other.json"
        target.write_text(json.dumps(default_config()))
        self.rules.symlink_to(target)
        self.assertNotEqual(self.run_set(POLICY).returncode, 0)
        self.assertTrue(self.rules.is_symlink())
        self.assertEqual(json.loads(target.read_text()), default_config())

    def test_write_gate_is_required(self):
        self.assertNotEqual(self.run_set(POLICY, SERVER_KIT_NETWORK_WRITES="0").returncode, 0)
        self.assertFalse(self.rules.exists())

    def slow_manager(self):
        self.fake_manager.write_text("#!/bin/bash\nprintf '%s' \"$$\" > \"$GENERATION_MARKER\"\nsleep 30\ncp \"$2\" \"$3\"\n")
        marker = self.path / "generation-started"
        return marker

    def test_timeout_terminates_entire_generation_group_without_changing_rules(self):
        marker = self.slow_manager()
        self.rules.write_text(json.dumps(default_config()))
        started = time.monotonic()
        result = self.run_set(POLICY, SERVER_KIT_RULES_REFRESH_TIMEOUT="0.15", GENERATION_MARKER=str(marker))
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(json.loads(self.rules.read_text()), default_config())
        self.assertFalse(list(self.path.glob(".subscription-rules-*")))
        with self.assertRaises(ProcessLookupError):
            os.kill(int(marker.read_text()), 0)

    def test_sigterm_during_generation_preserves_rules_and_reaps_child_group(self):
        marker = self.slow_manager()
        script = "set -euo pipefail\nfail() { return 1; }\n" + self.functions + "\nset_subscription_rules_json"
        child = subprocess.Popen(["bash", "-c", script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, start_new_session=True, env={**self.environment, "GENERATION_MARKER": str(marker)})
        child.stdin.write(json.dumps(POLICY))
        child.stdin.close()
        child.stdin = None
        try:
            deadline = time.monotonic() + 3
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists())
            self.assertFalse(self.rules.exists(), "Candidate generation must not modify canonical state")
            os.killpg(child.pid, signal.SIGTERM)
            child.communicate(timeout=5)
            self.assertFalse(self.rules.exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(int(marker.read_text()), 0)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


class RulesPublicationTests(unittest.TestCase):
    """Exercise the real refresh function with local render/service doubles."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name)
        self.config_dir = self.path / "config"
        self.config_dir.mkdir()
        self.data = self.path / "data"
        self.payload = self.data / "clash-subscriptions"
        self.payload.mkdir(parents=True)
        (self.payload / "profile.yaml").write_text("old contents")
        self.config = self.config_dir / "clash-config.json"
        self.original = {"mode": "clash", "port": 8444, "server_address": "vpn.example.com",
                         "cert_path": "/etc/example/cert", "key_path": "/etc/example/key",
                         "downloads": [{"token": "a" * 64, "download_name": "profile.yaml",
                                        "payload_path": str(self.payload / "profile.yaml"),
                                        "sha256": "b" * 64, "file_size": 12}]}
        self.config.write_text(json.dumps(self.original))
        self.rules = self.path / "rules.json"
        self.rules.write_text(json.dumps(default_config()))
        self.rules_candidate = self.path / "candidate.json"
        self.rules_candidate.write_text(json.dumps(POLICY))
        (self.path / "clash-inputs.json").write_text("{}")
        self.log = self.path / "systemctl.log"
        self.fakebin = self.path / "bin"
        self.fakebin.mkdir()
        fake = self.fakebin / "systemctl"
        fake.write_text(f"#!{sys.executable}\n" + '''import os, pathlib, signal, sys
path = pathlib.Path(os.environ["SYSTEMCTL_LOG"])
with path.open("a") as out:
    out.write(" ".join(sys.argv[1:]) + "\\n")
fail = pathlib.Path(os.environ["FAIL_ONCE_PATH"])
if sys.argv[1] == "restart" and fail.exists():
    fail.unlink()
    if os.environ.get("SIGNAL_PUBLISH") == "1":
        os.kill(os.getppid(), signal.SIGTERM)
        raise SystemExit(0)
    raise SystemExit(1)
if sys.argv[1] == "restart" and os.environ.get("FAIL_ALWAYS") == "1":
    raise SystemExit(1)
''')
        fake.chmod(0o700)
        self.fail_once = self.path / "fail-once"
        self.environment = {**os.environ, "PATH": str(self.fakebin) + os.pathsep + str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"],
                            "CONFIG_DIR": str(self.config_dir), "DATA_DIR": str(self.data),
                            "SERVER_KIT_CONFIG_DIR": str(self.path), "SYSTEMCTL_LOG": str(self.log),
                            "SUBSCRIPTION_RULES_PATH": str(self.rules_candidate), "RULES_COMMIT_PATH": str(self.rules),
                            "RULES_EXPECTED_REVISION": revision(default_config()),
                            "FAIL_ONCE_PATH": str(self.fail_once)}

    def tearDown(self):
        self.directory.cleanup()

    def refresh(self, mutate="", generation_failure=False):
        script = '''source "$1"
use_clash_service
resolve_source_file() { printf '%s\n' "$1"; }
sync_server_relay_if_configured() { echo forbidden-relay-sync >&2; return 99; }
chown() { return 0; }
render_clash_skeleton() { cp "$1" "$2"; printf '{}' > "$3"; }
verify_clash_vless_relay_bundle() { return 0; }
generate_clash_bundle() {
  python3 - "$2" "$4" "$5" <<'PY'
import json, os, pathlib, sys
if os.environ.get("GENERATION_FAILURE") == "1":
    raise SystemExit(1)
staging, existing, candidate = map(pathlib.Path, sys.argv[1:])
(staging / "profile.yaml").write_text("new rule contents")
config = json.loads(existing.read_text())
config["downloads"][0]["sha256"] = "c" * 64
config["downloads"][0]["file_size"] = 17
if os.environ.get("MUTATE_SETTING") == "port":
    config["port"] = 8445
if os.environ.get("MUTATE_SETTING") == "token":
    config["downloads"][0]["token"] = "d" * 64
if os.environ.get("MUTATE_SETTING") == "cert":
    config["cert_path"] = "/etc/other/cert"
candidate.write_text(json.dumps(config))
PY
}
refresh_clash_subscriptions "" "" 1
'''
        return subprocess.run(["bash", "-c", script, "test", str(ROOT / "debian_file_manager.sh")], capture_output=True, text=True,
                              env={**self.environment, "MUTATE_SETTING": mutate, "GENERATION_FAILURE": "1" if generation_failure else "0"})

    def test_rules_publish_only_restarts_subscription_download_worker(self):
        result = self.refresh()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.payload / "profile.yaml").read_text(), "new rule contents")
        self.assertEqual(json.loads(self.rules.read_text()), POLICY)
        self.assertEqual(self.log.read_text().splitlines(), ["restart secure-clash-service", "is-active --quiet secure-clash-service"])
        current = json.loads(self.config.read_text())
        self.assertEqual(current["downloads"][0]["token"], self.original["downloads"][0]["token"])
        self.assertFalse(list(self.data.glob(".clash-rules-recovery-*")))

    def test_failed_subscription_restart_restores_payload_and_config(self):
        self.fail_once.touch()
        result = self.refresh()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.payload / "profile.yaml").read_text(), "old contents")
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        self.assertEqual(json.loads(self.rules.read_text()), default_config())
        self.assertEqual(self.log.read_text().splitlines(), ["restart secure-clash-service", "restart secure-clash-service", "is-active --quiet secure-clash-service"])

    def test_changed_token_port_or_certificate_is_rejected_before_publish(self):
        for mutation in ("port", "token", "cert"):
            result = self.refresh(mutate=mutation)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((self.payload / "profile.yaml").read_text(), "old contents")
            self.assertEqual(json.loads(self.config.read_text()), self.original)
            self.assertFalse(self.log.exists())

    def test_generation_failure_does_not_publish_or_restart(self):
        result = self.refresh(generation_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.payload / "profile.yaml").read_text(), "old contents")
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        self.assertFalse(self.log.exists())

    def test_sigterm_during_publish_rolls_back_all_three_artifacts(self):
        self.fail_once.touch()
        self.environment["SIGNAL_PUBLISH"] = "1"
        result = self.refresh()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.payload / "profile.yaml").read_text(), "old contents")
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        self.assertEqual(json.loads(self.rules.read_text()), default_config())
        self.assertFalse(list(self.data.glob(".clash-rules-recovery-*")))

    def test_unconfirmed_rollback_preserves_journal_and_blocks_next_publish(self):
        self.environment["FAIL_ALWAYS"] = "1"
        result = self.refresh()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SERVER_KIT_DIAGNOSTIC:subscription_rules_recovery_required", result.stderr)
        recoveries = list(self.data.glob(".clash-rules-recovery-*"))
        self.assertEqual(len(recoveries), 1)
        self.assertTrue((recoveries[0] / "transaction.json").exists())
        self.assertEqual(recoveries[0].stat().st_mode & 0o777, 0o700)
        self.environment.pop("FAIL_ALWAYS")
        before = self.log.read_text()
        self.assertNotEqual(self.refresh().returncode, 0)
        self.assertEqual(self.log.read_text(), before)


if __name__ == "__main__":
    unittest.main()
