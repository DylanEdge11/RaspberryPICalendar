#!/usr/bin/python3
"""Root-owned, fixed-purpose updater. No commands or paths come from the browser."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request

REPO = Path('/opt/family-calendar')
DATA = Path('/var/lib/family-calendar')
STATE = Path('/var/lib/family-calendar-updater')
BACKUPS = Path('/var/backups/family-calendar')
SERVICE = 'family-calendar.service'
REMOTE = 'https://github.com/DylanEdge11/RaspberryPICalendar.git'


def command(*args, timeout=180):
    # No shell, interactive credential prompts, npm lifecycle hooks, or browser input.
    result = subprocess.run(args, cwd=REPO, text=True, capture_output=True,
                            timeout=timeout, umask=0o022,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    if result.returncode:
        raise RuntimeError('Command failed: ' + args[0])
    return result.stdout.strip()


def status(state, message, **details):
    payload = {'state': state, 'message': message, 'updated_at': time.time(), **details}
    fd, name = tempfile.mkstemp(prefix='status-', dir=STATE)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(payload, output)
        os.chmod(name, 0o644)
        os.replace(name, STATE / 'status.json')
    finally:
        if os.path.exists(name):
            os.unlink(name)


def root_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Updater requires root-owned directories without group/other write access')


def verify_layout():
    for path in (Path('/opt'), REPO, REPO / '.git', STATE, BACKUPS):
        root_directory(path)
    # This first installer deliberately supports the documented default layout only.
    config = {}
    for line in Path('/etc/family-calendar/calendar.env').read_text().splitlines():
        key, sep, value = line.strip().partition('=')
        if sep and not key.startswith('#'):
            config[key] = value.strip().strip('\"\'')
    if config.get('APP_DATA_DIR') != str(DATA) or config.get('APP_PORT', '8080') != '8080':
        raise RuntimeError('Phone updates require the documented data directory and port 8080')
    if command('/usr/bin/git', 'remote', 'get-url', 'origin') != REMOTE:
        raise RuntimeError('Unexpected GitHub remote')
    if command('/usr/bin/git', 'status', '--porcelain', '--untracked-files=normal'):
        raise RuntimeError('Local code changes must be resolved on the Pi first')


def schema_version():
    with sqlite3.connect(f'file:{DATA / "calendar.sqlite"}?mode=ro', uri=True) as db:
        row = db.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone()
    return row[0] if row else None


def backup(previous):
    directory = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%S-'), dir=BACKUPS))
    os.chmod(directory, 0o700)
    with sqlite3.connect(f'file:{DATA / "calendar.sqlite"}?mode=ro', uri=True) as source:
        with sqlite3.connect(directory / 'calendar.sqlite') as target:
            source.backup(target)
    for entry in ('photos', 'secrets'):
        if (DATA / entry).exists():
            with tarfile.open(directory / f'{entry}.tgz', 'w:gz') as archive:
                archive.add(DATA / entry, arcname=entry)
    with tarfile.open(directory / 'configuration.tgz', 'w:gz') as archive:
        archive.add('/etc/family-calendar', arcname='family-calendar')
    (directory / 'commit.txt').write_text(previous + '\n')
    lines = []
    for file in sorted(directory.iterdir()):
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        lines.append(f'{digest}  {file.name}\n')
    (directory / 'SHA256SUMS').write_text(''.join(lines))
    return str(directory)


def install_dependencies():
    command('/usr/bin/npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', timeout=420)
    # Execute repository code only as the application user, never as root.
    command('/usr/sbin/runuser', '-u', 'family-calendar', '--', '/usr/bin/npm', 'run', 'check')
    command('/usr/sbin/runuser', '-u', 'family-calendar', '--', '/usr/bin/node', '-e',
            "require('sharp')({create:{width:1,height:1,channels:3,background:'#fff'}}).jpeg().toBuffer().catch(()=>process.exit(1))")


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            with opener.open('http://127.0.0.1:8080/api/health', timeout=2) as response:
                result = json.loads(response.read(8192))
                if result.get('ok') is True and result.get('mode') == 'production':
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False


def update():
    previous = None
    snapshot = None
    old_schema = None
    stopped = False
    changed = False
    try:
        status('running', 'Checking GitHub for an update.')
        verify_layout()
        previous = command('/usr/bin/git', 'rev-parse', 'HEAD')
        command('/usr/bin/git', 'fetch', '--no-tags', 'origin', 'main')
        target = command('/usr/bin/git', 'rev-parse', 'FETCH_HEAD')
        command('/usr/bin/git', 'merge-base', '--is-ancestor', previous, target)
        if previous == target:
            status('complete', 'Already up to date.', revision=previous)
            return
        status('running', 'Backing up household data. The display will briefly disconnect.')
        command('/usr/bin/systemctl', 'stop', SERVICE, timeout=60)
        stopped = True
        old_schema = schema_version()
        snapshot = backup(previous)
        status('running', 'Installing the update.', backup=snapshot, previous=previous)
        command('/usr/bin/git', 'checkout', '--detach', target)
        changed = True
        install_dependencies()
        command('/usr/bin/systemctl', 'start', SERVICE)
        stopped = False
        if not healthy():
            raise RuntimeError('Updated application failed its health check')
        status('complete', 'Update installed. Refresh the display and controls.', revision=target, backup=snapshot)
    except Exception as error:
        # Never guess at reversing a database migration. Keep its snapshot for manual recovery.
        recovered = False
        try:
            if changed:
                command('/usr/bin/systemctl', 'stop', SERVICE, timeout=60)
                stopped = True
                if schema_version() != old_schema:
                    raise RuntimeError('Database version changed; restore the backup manually')
                command('/usr/bin/git', 'checkout', '--detach', previous)
                install_dependencies()
            if stopped:
                command('/usr/bin/systemctl', 'start', SERVICE)
                recovered = healthy()
            else:
                recovered = True
        except Exception:
            recovered = False
        status('failed', 'Update failed; the previous application is available.' if recovered else
               'Update failed and needs Pi maintenance. Preserve the backup and follow README recovery steps.',
               reason=str(error) if isinstance(error, RuntimeError) else 'An installation or backup operation failed.',
               backup=snapshot, previous=previous)
        raise


if __name__ == '__main__':
    import fcntl
    if os.geteuid() != 0:
        raise SystemExit('Run this only through the installed update service.')
    os.umask(0o077)
    with (STATE / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Only the existence of this file matters. Never read or execute its contents.
        (DATA / 'update-request').unlink(missing_ok=True)
        try:
            update()
        except Exception:
            print('Update failed. See the protected updater status and README recovery instructions.')
            raise SystemExit(1)
