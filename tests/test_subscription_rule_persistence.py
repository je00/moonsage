"""Private subscription settings must survive release changes and encrypted restore."""
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

from ruamel.yaml import YAML
from lib.server_kit_backup import BackupStore
from lib.server_kit_subscription_rules import atomic_write, load

ROOT = Path(__file__).resolve().parents[1]


class FakeScheduler:
    def schedule(self, seconds):
        pass

    def cancel(self):
        pass


class PrivateSubscriptionPersistenceTests(unittest.TestCase):
    def test_encrypted_backup_restores_private_rules_not_repository_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'etc/server-kit/subscription-rules.json'
            config = {'version': 1, 'direct_rules': [
                {'match': 'suffix', 'value': 'private-business.example'}
            ], 'dns_rules': []}
            atomic_write(path, config)
            store = BackupStore(root / 'backups', root, scheduler=FakeScheduler(), writes_enabled=True)
            password = 'Test-only-backup-passphrase-2026'
            created = store.create(password)
            archive = root / 'backups' / created['download_name']
            self.assertNotIn(b'private-business.example', archive.read_bytes())
            atomic_write(path, {'version': 1, 'direct_rules': [], 'dns_rules': []})
            store.apply_restore(created['backup_id'], password)
            store.confirm_restore()
            self.assertEqual(load(path), config)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            # The explicitly saved empty DNS list must not re-enable public defaults.
            self.assertEqual(load(path)['dns_rules'], [])

    def test_private_rules_are_ignored_by_git_and_not_in_release_template(self):
        result = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin'],
                                cwd=ROOT, input='subscription-rules.json\nclash_skeleton.private.yaml\n',
                                text=True, capture_output=True, check=True)
        self.assertEqual(set(result.stdout.splitlines()), {'subscription-rules.json', 'clash_skeleton.private.yaml'})
        skeleton = YAML(typ='safe').load((ROOT / 'clash_skeleton.yaml').read_text())
        self.assertEqual(skeleton['dns']['nameserver-policy']['+.byd.auto'],
                         ['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query'])
        self.assertNotIn('private-business.example', json.dumps(skeleton))


if __name__ == '__main__':
    unittest.main()
