#!/usr/bin/env python3
"""Compact one configured instance through its existing maintenance gate.

SQLite owns all database/WAL mutations. Never replace the live database inode,
remove WAL/SHM, stop services, or kill a user job. A busy gate/DB defers safely.
"""
from __future__ import annotations
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time
import uuid


def digest(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def syncdir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_json(file, value):
    temporary = file.with_name('.' + file.name + '-' + str(uuid.uuid4()))
    with temporary.open('x') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, file); syncdir(file.parent)


def allocated(database):
    return sum(p.stat().st_blocks * 512 for p in [database, Path(str(database)+'-wal'), Path(str(database)+'-shm')] if p.exists())


def snapshot(db, source, root):
    """Publish the checked compact snapshot + manifest with one atomic pointer."""
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    previous = None
    pointer = root / 'current.json'
    if pointer.exists():
        previous = json.loads(pointer.read_text())
    name = 'point-' + str(uuid.uuid4())
    directory = root / name; directory.mkdir(mode=0o700)
    target = directory / 'database.sqlite'
    db.execute('VACUUM INTO ?', (str(target),))
    os.chmod(target, 0o600)
    check = sqlite3.connect(target.as_uri()+'?mode=ro', uri=True)
    try:
        if check.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('storage_compact_snapshot_integrity')
    finally:
        check.close()
    with target.open('rb') as f:
        os.fsync(f.fileno())
    manifest = {'format': 'pp-storage-local-recovery-v1', 'directory': name,
                'database': 'database.sqlite', 'source': str(source), 'createdAt': int(time.time()*1000),
                'sha256': digest(target), 'bytes': target.stat().st_size, 'quickCheck': 'ok'}
    publish_json(directory / 'manifest.json', manifest); syncdir(root)
    publish_json(pointer, manifest)
    # Remove only this helper's exact previous, verified generation. Other
    # deployment/full backups require their own acceptance/reference checks.
    if previous and previous.get('format') == manifest['format'] and previous.get('source') == str(source):
        old_name = previous.get('directory', '')
        try:
            if not old_name.startswith('point-') or str(uuid.UUID(old_name[6:])) != old_name[6:]:
                raise ValueError('invalid generation')
            old = root / old_name
            if not old.is_symlink() and digest(old/'database.sqlite') == previous['sha256']:
                shutil.rmtree(old); syncdir(root)
        except (ValueError, OSError, KeyError):
            pass  # Unrecognized materials are preserved, never guessed disposable.
    return manifest


def native_candidates(homes, minimum):
    result = []
    for user, home in homes.items():
        home = Path(home)
        if not home.exists():continue
        if home.is_symlink() or home.resolve()!=home:raise ValueError('storage_native_home_alias')
        for name in ('state_5.sqlite','thread_history_1.sqlite','logs_2.sqlite'):
            file=home/name
            if not file.exists():continue
            if file.is_symlink() or not file.is_file() or file.stat().st_nlink!=1:raise ValueError('storage_native_database_scope')
            db=sqlite3.connect(file.as_uri()+'?mode=ro',uri=True)
            try:
                pages=db.execute('PRAGMA page_count').fetchone()[0];free=db.execute('PRAGMA freelist_count').fetchone()[0];size=db.execute('PRAGMA page_size').fetchone()[0]
                if free*size>=minimum and free/max(1,pages)>=.2:result.append((str(user),home,file,pages*size))
            finally:db.close()
    return result


def compact_native(user, home, file, recovery):
    lock=home/'.pp-agent-lifecycle.lock';fd=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);db=None
    try:
        if os.getuid()==0:os.fchown(fd,home.stat().st_uid,home.stat().st_gid)
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'user':user,'database':file.name,'state':'deferred','reason':'native_runtime_active'}
        inodes={(p.stat().st_dev,p.stat().st_ino) for p in [file,Path(str(file)+'-wal')] if p.exists()}
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit() or int(proc.name)==os.getpid():continue
            try:
                args=(proc/'cmdline').read_bytes().split(b'\0')
                if args and b'codex' in args[0] and (b'app-server' in args or b'exec' in args):
                    env=(proc/'environ').read_bytes().split(b'\0')
                    if any(e==os.fsencode('CODEX_HOME='+str(home)) for e in env):
                        return {'user':user,'database':file.name,'state':'deferred','reason':'native_runtime_active'}
                for opened in (proc/'fd').iterdir():
                    try:
                        st=opened.stat()
                        if (st.st_dev,st.st_ino) in inodes:return {'user':user,'database':file.name,'state':'deferred','reason':'native_database_open'}
                    except FileNotFoundError:pass
            except (FileNotFoundError,ProcessLookupError):pass
        disk=os.statvfs(file.parent);size=file.stat().st_size
        if disk.f_bavail*disk.f_frsize-3*size<disk.f_blocks*disk.f_frsize*.1:
            return {'user':user,'database':file.name,'state':'deferred','reason':'storage_compaction_space_reserve'}
        db=sqlite3.connect(file.as_uri()+'?mode=rw',uri=True,timeout=5,isolation_level=None)
        deadline=time.monotonic()+300;db.set_progress_handler(lambda:int(time.monotonic()>deadline),10000)
        point=snapshot(db,file,recovery/'native'/user/file.stem);before=allocated(file);inode=file.stat().st_ino
        db.execute('VACUUM')
        if db.execute('PRAGMA quick_check').fetchall()!=[('ok',)] or file.stat().st_ino!=inode:raise RuntimeError('storage_native_compact_integrity')
        checkpoint=db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone();after=allocated(file)
        return {'user':user,'database':file.name,'state':'compacted' if checkpoint[0]==0 else 'checkpoint_pending',
                'allocatedBefore':before,'allocatedAfter':after,'physicalReleasedBytes':max(0,before-after),'recovery':point,'quickCheck':'ok'}
    finally:
        if db:db.close()
        os.close(fd)


def compact(database, gate, lock, lifecycle, recovery, *, minimum_reclaim_bytes=32*1024**2, settle_seconds=2, native_homes=None):
    database, gate, lock, lifecycle, recovery = map(Path, (database, gate, lock, lifecycle, recovery))
    for value in (database, gate, lock, lifecycle, recovery):
        if not value.is_absolute() or value.is_symlink() or value.resolve() != value:
            raise ValueError('storage_compact_path_invalid')
    if gate.parent != database.parent or recovery == database.parent:
        raise ValueError('storage_compact_scope_invalid')
    lifecycle.mkdir(parents=True, exist_ok=True, mode=0o700)
    locks = []; gate_inode = None; db = None
    receipt = {'format': 'pp-storage-compaction-v1', 'startedAt': int(time.time()*1000), 'state': 'deferred', 'physicalReleasedBytes': 0}
    try:
        for name in (lock, lifecycle/'.maintenance.flock', lifecycle/'.backup.flock', lifecycle/'.local-recovery.flock'):
            fd = os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600); locks.append(fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                receipt['reason'] = 'maintenance_or_storage_busy'; return receipt
        if gate.exists():
            receipt['reason'] = 'maintenance_gate_owned_elsewhere'; return receipt
        db = sqlite3.connect(database.as_uri()+'?mode=rw', uri=True, timeout=5, isolation_level=None)
        db.execute('PRAGMA busy_timeout=5000')
        if not db.execute("SELECT 1 FROM storage_backup_points WHERE state='verified' AND restore_tested_at IS NOT NULL LIMIT 1").fetchone():
            receipt['reason'] = 'independent_cloud_recovery_required'; return receipt
        pages = db.execute('PRAGMA page_count').fetchone()[0]
        free = db.execute('PRAGMA freelist_count').fetchone()[0]
        size = db.execute('PRAGMA page_size').fetchone()[0]
        receipt.update(pageCount=pages, freePages=free, reclaimableBytes=free*size)
        main_needed = free*size >= minimum_reclaim_bytes and free/max(1,pages) >= .2
        native = native_candidates(native_homes or {},minimum_reclaim_bytes)
        if not main_needed and not native:
            receipt['state'] = 'not_needed'; return receipt
        recovery.mkdir(parents=True, exist_ok=True, mode=0o700)
        for directory in (database.parent, recovery):
            disk = os.statvfs(directory)
            # Source/temp/WAL plus compact recovery point and a 10% reserve.
            if disk.f_bavail*disk.f_frsize - 3*pages*size < disk.f_blocks*disk.f_frsize*.1:
                receipt['reason'] = 'storage_compaction_space_reserve'; return receipt
        running = lambda: db.execute("SELECT count(*) FROM jobs WHERE status='running'").fetchone()[0]
        if running():
            receipt['reason'] = 'actual_job_running'; return receipt
        fd = os.open(gate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            gate_inode = os.fstat(fd).st_ino; os.write(fd, b'preparing\n'); os.fsync(fd)
        finally:
            os.close(fd)
        time.sleep(settle_seconds)
        if running():
            receipt['reason'] = 'job_won_idle_race'; return receipt
        if gate.stat().st_ino != gate_inode:
            raise RuntimeError('storage_compact_gate_changed')
        with gate.open('w') as f:
            f.write('active\n'); f.flush(); os.fsync(f.fileno())
        deadline = time.monotonic()+300
        db.set_progress_handler(lambda: int(time.monotonic()>deadline), 10000)
        receipt['recovery'] = snapshot(db, database, recovery)
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('storage_compact_source_integrity')
        before = allocated(database); inode = database.stat().st_ino
        receipt['allocatedBefore'] = before
        if main_needed:db.execute('VACUUM')
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)] or database.stat().st_ino != inode:
            raise RuntimeError('storage_compact_integrity')
        checkpoint = db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        after = allocated(database)
        receipt.update(state='compacted' if checkpoint[0] == 0 else 'checkpoint_pending',
                       allocatedAfter=after, physicalReleasedBytes=max(0,before-after), quickCheck='ok', checkpoint=list(checkpoint))
        receipt['native']=[]
        for user,home,file,_size in native:
            result=compact_native(user,home,file,recovery);receipt['native'].append(result)
            receipt['physicalReleasedBytes']+=result.get('physicalReleasedBytes',0)
        return receipt
    except sqlite3.OperationalError as error:
        # SQLite rolls interrupted work back itself; never remove its journals.
        receipt['reason'] = 'sqlite_busy_or_interrupted'; receipt['errorType'] = type(error).__name__
        return receipt
    except Exception as error:
        receipt['state']='error';receipt['reason']='storage_compaction_failed';receipt['errorType']=type(error).__name__
        raise
    finally:
        if db:
            db.close()
        if gate_inode is not None and gate.exists() and gate.stat().st_ino == gate_inode:
            gate.unlink(); syncdir(gate.parent)
        receipt['finishedAt'] = int(time.time()*1000)
        publish_json(lifecycle/'last-compaction.json', receipt)
        for fd in reversed(locks):
            os.close(fd)


def main():
    required = lambda name: os.environ[name]
    plan = json.loads(Path(required('STORAGE_BACKUP_PLAN')).read_text())
    source=Path(required('STORAGE_DATABASE_PATH'));database=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)
    try:
        homes={user:Path(required('STORAGE_HOST_CODEX_HOME')) if user==required('STORAGE_HOST_USER_ID') else Path(required('STORAGE_TENANT_ROOT'))/user/'codex-home' for (user,) in database.execute('SELECT id FROM users')}
    finally:database.close()
    result = compact(required('STORAGE_DATABASE_PATH'), required('STORAGE_MAINTENANCE_GATE'),
                     required('STORAGE_MAINTENANCE_LOCK'), required('STORAGE_LIFECYCLE_ROOT'), plan['localRecoveryRoot'],native_homes=homes)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
