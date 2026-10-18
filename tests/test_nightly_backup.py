import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'nightly-backup.py'


def load(env):
    with patch.dict(os.environ, env):
        spec = importlib.util.spec_from_file_location('nightly_backup', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class NightlyBackupTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.data = self.root / 'data'
        (self.data / 'photos' / 'display').mkdir(parents=True)
        (self.data / 'secrets').mkdir()
        (self.data / 'secrets' / 'token.json').write_text('{}')
        (self.data / 'photos' / 'display' / 'a.jpg').write_bytes(b'a' * 10)
        (self.data / 'photos' / 'display' / 'b.jpg').write_bytes(b'b' * 10)
        with sqlite3.connect(self.data / 'calendar.sqlite') as db:
            db.execute('CREATE TABLE settings(key TEXT, value TEXT)')
            db.execute("INSERT INTO settings VALUES('view', 'today')")
        self.config = self.root / 'etc'
        self.config.mkdir()
        (self.config / 'calendar.env').write_text('ADMIN_PIN=x\n')
        self.backups = self.root / 'backups'
        self.status = self.root / 'status' / 'status.json'
        self.module = load({'APP_DATA_DIR': str(self.data), 'CONFIG_DIR': str(self.config), 'BACKUP_DIR': str(self.backups), 'BACKUP_STATUS': str(self.status), 'KEEP_NIGHTS': '2', 'KEEP_PRE_UPDATE': '1'})

    def test_writes_database_secrets_configuration_and_status(self):
        self.module.main()
        nights = [path for path in (self.backups / 'nightly').iterdir() if path.name[0].isdigit()]
        self.assertEqual(len(nights), 1)
        folder = nights[0]
        self.assertEqual({path.name for path in folder.iterdir()}, {'calendar.sqlite', 'secrets.tgz', 'configuration.tgz', 'SHA256SUMS'})
        with sqlite3.connect(folder / 'calendar.sqlite') as db:
            self.assertEqual(db.execute("SELECT value FROM settings WHERE key='view'").fetchone()[0], 'today')
        status = json.loads(self.status.read_text())
        self.assertTrue(status['ok'])
        self.assertEqual(status['photos_copied'], 2)

    def test_photos_are_mirrored_once_and_follow_removals(self):
        self.module.main()
        (self.data / 'photos' / 'display' / 'b.jpg').unlink()
        (self.data / 'photos' / 'display' / 'c.jpg').write_bytes(b'c')
        self.module.main()
        mirrored = sorted(path.name for path in (self.backups / 'nightly' / 'photos').rglob('*.jpg'))
        self.assertEqual(mirrored, ['a.jpg', 'c.jpg'])
        status = json.loads(self.status.read_text())
        self.assertEqual((status['photos_copied'], status['photos_removed']), (1, 1))

    def test_keeps_only_recent_nights_and_pre_update_backups(self):
        nightly = self.backups / 'nightly'
        for name in ('2026-01-01', '2026-01-02', '2026-01-03'):
            (nightly / name).mkdir(parents=True)
        for name in ('20260101T010101-aa', '20260102T010101-bb'):
            (self.backups / name).mkdir(parents=True)
            (self.backups / name / 'commit.txt').write_text('abc\n')
        (self.backups / 'keep-me').mkdir()
        self.module.main()
        nights = sorted(path.name for path in nightly.iterdir() if path.name[0].isdigit())
        self.assertEqual(len(nights), 2)
        self.assertNotIn('2026-01-01', nights)
        self.assertEqual(sorted(path.name for path in self.backups.iterdir() if path.name != 'nightly'), ['20260102T010101-bb', 'keep-me'])

    def test_failure_is_recorded_for_the_phone(self):
        (self.data / 'calendar.sqlite').unlink()
        with self.assertRaises(Exception):
            self.module.main()
        status = json.loads(self.status.read_text())
        self.assertFalse(status['ok'])


if __name__ == '__main__':
    unittest.main()
