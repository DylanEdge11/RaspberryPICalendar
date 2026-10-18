#!/usr/bin/env python3
"""Nightly backup of the family calendar, run as root by family-calendar-backup.timer.

Each night writes a dated folder with the database, Google/Immich secrets and the
configuration, keeping the last KEEP_NIGHTS. Photos are kept as one mirror that is
updated in place, so they are not copied again every night. Old pre-update backups
made by the phone updater are trimmed to the newest few, since each holds every photo.
"""
import datetime
import hashlib
import json
import os
import re
import shutil
import sqlite3
import tarfile
import time
from pathlib import Path

DATA = Path(os.environ.get('APP_DATA_DIR', '/var/lib/family-calendar'))
CONFIG = Path(os.environ.get('CONFIG_DIR', '/etc/family-calendar'))
BACKUPS = Path(os.environ.get('BACKUP_DIR', '/var/backups/family-calendar'))
STATUS = Path(os.environ.get('BACKUP_STATUS', '/var/lib/family-calendar-backup/status.json'))
KEEP_NIGHTS = int(os.environ.get('KEEP_NIGHTS', '7'))
KEEP_PRE_UPDATE = int(os.environ.get('KEEP_PRE_UPDATE', '3'))
PRE_UPDATE = re.compile(r'^\d{8}T\d{6}-')


def write_status(**fields):
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    temp = STATUS.with_suffix('.tmp')
    temp.write_text(json.dumps({**fields, 'updated_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}))
    # Readable by the web service so the phone controls can show the last backup.
    os.chmod(temp, 0o644)
    os.replace(temp, STATUS)


def tar_directory(source, target, name):
    with tarfile.open(target, 'w:gz') as archive:
        archive.add(source, arcname=name)


def mirror(source, target):
    """Copy new or changed files and remove files that no longer exist."""
    copied = removed = 0
    target.mkdir(parents=True, exist_ok=True)
    wanted = set()
    for path in source.rglob('*'):
        if not path.is_file() or path.name.endswith('.tmp'):
            continue
        relative = path.relative_to(source)
        wanted.add(relative)
        destination = target / relative
        stat = path.stat()
        if destination.exists() and destination.stat().st_size == stat.st_size and int(destination.stat().st_mtime) == int(stat.st_mtime):
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
        copied += 1
    for path in sorted(target.rglob('*'), reverse=True):
        if path.is_file() and path.relative_to(target) not in wanted:
            path.unlink()
            removed += 1
        elif path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    return copied, removed


def prune(directories, keep):
    for directory in sorted(directories, key=lambda path: path.name)[:-keep or None] if keep else []:
        shutil.rmtree(directory)


def backup():
    started = time.time()
    nightly = BACKUPS / 'nightly'
    folder = nightly / datetime.date.today().isoformat()
    temp = nightly / f'.{folder.name}.partial'
    shutil.rmtree(temp, ignore_errors=True)
    temp.mkdir(parents=True, mode=0o700)
    os.chmod(BACKUPS, 0o700)

    with sqlite3.connect(f'file:{DATA / "calendar.sqlite"}?mode=ro', uri=True) as source:
        with sqlite3.connect(temp / 'calendar.sqlite') as target:
            source.backup(target)
    if (DATA / 'secrets').exists():
        tar_directory(DATA / 'secrets', temp / 'secrets.tgz', 'secrets')
    if CONFIG.exists():
        tar_directory(CONFIG, temp / 'configuration.tgz', 'family-calendar')
    lines = []
    for file in sorted(temp.iterdir()):
        with file.open('rb') as stream:
            lines.append(f'{hashlib.file_digest(stream, "sha256").hexdigest()}  {file.name}\n')
    (temp / 'SHA256SUMS').write_text(''.join(lines))
    shutil.rmtree(folder, ignore_errors=True)
    temp.rename(folder)

    copied, removed = mirror(DATA / 'photos', nightly / 'photos') if (DATA / 'photos').exists() else (0, 0)
    prune([path for path in nightly.iterdir() if path.is_dir() and re.fullmatch(r'\d{4}-\d{2}-\d{2}', path.name)], KEEP_NIGHTS)
    prune([path for path in BACKUPS.iterdir() if path.is_dir() and PRE_UPDATE.match(path.name) and (path / 'commit.txt').exists()], KEEP_PRE_UPDATE)
    return {'folder': str(folder), 'photos_copied': copied, 'photos_removed': removed, 'seconds': round(time.time() - started, 1)}


def main():
    try:
        result = backup()
        write_status(ok=True, **result)
        print(f"Backup written to {result['folder']} ({result['photos_copied']} photos copied, {result['photos_removed']} removed)")
    except Exception as error:
        write_status(ok=False, error=str(error)[:300])
        raise


if __name__ == '__main__':
    main()
