import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('phone_update', Path(__file__).resolve().parents[1] / 'scripts' / 'phone-update.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateTests(unittest.TestCase):
    def exercise(self, *, target='new', backup_error=None, installs=None, schema=None, health=None, verify_error=None):
        events = []
        reports = []

        def command(*args, **kwargs):
            events.append(args)
            if args[1:] == ('rev-parse', 'HEAD'):
                return 'old'
            if args[1:] == ('rev-parse', 'FETCH_HEAD'):
                return target
            return ''

        with patch.object(updater, 'command', side_effect=command), \
             patch.object(updater, 'status', side_effect=lambda *a, **kw: reports.append((a, kw))), \
             patch.object(updater, 'verify_layout', side_effect=verify_error), \
             patch.object(updater, 'backup', side_effect=backup_error, return_value='/protected/backup') as backup, \
             patch.object(updater, 'schema_version', side_effect=schema or ['1', '1']), \
             patch.object(updater, 'install_dependencies', side_effect=installs), \
             patch.object(updater, 'healthy', side_effect=health or [True]):
            try:
                updater.update()
            except Exception:
                pass
            return events, reports, backup.call_count

    def test_no_change_does_not_stop_service_or_backup(self):
        events, reports, count = self.exercise(target='old')
        self.assertFalse(any('stop' in event for event in events))
        self.assertEqual(count, 0)
        self.assertEqual(reports[-1][0][0], 'complete')

    def test_update_stops_backs_up_installs_and_checks_health(self):
        events, reports, count = self.exercise()
        self.assertEqual(count, 1)
        self.assertLess(events.index(('/usr/bin/systemctl', 'stop', updater.SERVICE)), events.index(('/usr/bin/git', 'checkout', '--detach', 'new')))
        self.assertEqual(reports[-1][0][0], 'complete')
        self.assertEqual(reports[-1][1]['revision'], 'new')

    def test_backup_failure_never_changes_code_and_restarts_old_service(self):
        events, reports, _ = self.exercise(backup_error=OSError('disk full'))
        self.assertFalse(any('checkout' in event for event in events))
        self.assertIn(('/usr/bin/systemctl', 'start', updater.SERVICE), events)
        self.assertEqual(reports[-1][0][0], 'failed')

    def test_failed_install_rolls_back_code_when_schema_unchanged(self):
        events, reports, _ = self.exercise(installs=[RuntimeError('Install failed'), None])
        self.assertIn(('/usr/bin/git', 'checkout', '--detach', 'old'), events)
        self.assertIn('previous application is available', reports[-1][0][1])

    def test_changed_schema_requires_manual_restore_instead_of_guessing(self):
        events, reports, _ = self.exercise(schema=['1', '2'], health=[False])
        self.assertNotIn(('/usr/bin/git', 'checkout', '--detach', 'old'), events)
        self.assertIn('needs Pi maintenance', reports[-1][0][1])
        self.assertEqual(reports[-1][1]['backup'], '/protected/backup')

    def test_invalid_layout_or_local_changes_abort_before_fetch(self):
        events, reports, count = self.exercise(verify_error=RuntimeError('Local code changes'))
        self.assertEqual(events, [])
        self.assertEqual(count, 0)
        self.assertEqual(reports[-1][1]['reason'], 'Local code changes')


if __name__ == '__main__':
    unittest.main()
