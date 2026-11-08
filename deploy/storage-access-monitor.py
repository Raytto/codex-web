#!/usr/bin/env python3
"""Linux fanotify helper. Never logs process environments or file contents.

Permission events keep the reader alive long enough to identify the exact
task. A tiny usage marker is committed before allowing that read. SQLite is
updated asynchronously by the parent, avoiding a reader/database deadlock.
Closing the fanotify descriptor releases pending kernel permission requests.
"""
import ctypes
import errno
import json
import os
import selectors
import struct
import sys
import time

libc = ctypes.CDLL(None, use_errno=True)
FAN_CLOEXEC, FAN_NONBLOCK, FAN_CLASS_CONTENT = 1, 2, 4
FAN_MARK_ADD, FAN_MARK_REMOVE = 1, 2
FAN_MODIFY, FAN_OPEN_PERM, FAN_ACCESS_PERM = 2, 0x10000, 0x20000
FAN_Q_OVERFLOW, FAN_ALLOW = 0x4000, 1
MASK = FAN_MODIFY | FAN_OPEN_PERM | FAN_ACCESS_PERM
metadata = struct.Struct('=IBBHQii')
marker_root = os.path.realpath(sys.argv[1])
os.makedirs(marker_root, mode=0o700, exist_ok=True)
boot = open('/proc/sys/kernel/random/boot_id').read().strip()
fd = libc.fanotify_init(FAN_CLOEXEC | FAN_NONBLOCK | FAN_CLASS_CONTENT, os.O_RDONLY | os.O_CLOEXEC)
if fd < 0:
    raise OSError(ctypes.get_errno(), 'storage_access_monitor_unavailable')
watch, jobs, actors, recent = {}, {}, {}, {}

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

def identity(pid):
    raw = open('/proc/%s/stat' % pid).read()
    return '%s:%s:%s' % (boot, pid, raw[raw.rfind(')')+2:].split()[19])

def actor(pid):
    try:
        ident = identity(pid)
        cached = actors.get(pid)
        if cached and cached[0] == ident:
            return cached[1]
        env = {}
        with open('/proc/%s/environ' % pid, 'rb') as source:
            for entry in source.read(2*1024*1024).split(b'\0'):
                key, _, value = entry.partition(b'=')
                if key in (b'CODEX_WEB_AUTOMATION_JOB_ID', b'PPAGENT_STORAGE_MAINTENANCE', b'SSH_CONNECTION'):
                    env[key] = value.decode('utf8', 'replace')
        job = env.get(b'CODEX_WEB_AUTOMATION_JOB_ID')
        result = None
        if env.get(b'PPAGENT_STORAGE_MAINTENANCE') != '1':
            if job in jobs:
                result = {'processIdentity': ident, 'jobId': job, 'userId': jobs[job]}
            elif not job and env.get(b'SSH_CONNECTION'):
                result = {'processIdentity': ident, 'jobId': None, 'userId': None}
        actors[pid] = (ident, result)
        if len(actors) > 10000:
            actors.clear()
        return result
    except (OSError, ValueError):
        return None

def update(config):
    global jobs
    jobs = config['jobs']
    actors.clear()
    wanted = set()
    for item in config['files']:
        try:
            stat = os.stat(item['path'], follow_symlinks=False)
            key = '%s:%s' % (stat.st_dev, stat.st_ino)
            wanted.add(key)
            if key not in watch:
                if libc.fanotify_mark(fd, FAN_MARK_ADD, ctypes.c_ulonglong(MASK), -100, os.fsencode(item['path'])) < 0:
                    raise OSError(ctypes.get_errno(), 'mark_failed')
            watch[key] = item
        except OSError as error:
            if error.errno != errno.ENOENT:
                emit({'event': 'watch_error', 'itemId': item['id'], 'errno': error.errno})
    # Removed files may still be in isolation. Their inode mark is harmless:
    # without an index entry no usage is attributed to a deleted generation.
    for key in set(watch)-wanted:
        item = watch.pop(key)
        libc.fanotify_mark(fd, FAN_MARK_REMOVE, ctypes.c_ulonglong(MASK), -100, os.fsencode(item['path']))
    emit({'event': 'ready', 'watched': len(watch), 'items': [item['id'] for item in watch.values()]})

selector = selectors.DefaultSelector()
selector.register(fd, selectors.EVENT_READ, 'events')
selector.register(sys.stdin.buffer, selectors.EVENT_READ, 'config')
pending = b''
try:
    while True:
        for key, _ in selector.select(30):
            if key.data == 'config':
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    sys.exit(0)
                pending += data
                if len(pending) > 64*1024*1024:
                    raise ValueError('watch_configuration_budget')
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    if line:
                        update(json.loads(line))
                continue
            data = os.read(fd, 1024*1024)
            offset = 0
            while offset < len(data):
                length, version, _, meta_len, mask, event_fd, pid = metadata.unpack_from(data, offset)
                offset += length
                if version != 3 or length < metadata.size:
                    raise ValueError('fanotify_metadata_version')
                if mask & FAN_Q_OVERFLOW:
                    emit({'event': 'overflow'})
                    continue
                if event_fd < 0:
                    continue
                try:
                    stat = os.fstat(event_fd)
                    item = watch.get('%s:%s' % (stat.st_dev, stat.st_ino))
                    who = actor(pid) if item else None
                    if item and who and mask & (FAN_ACCESS_PERM | FAN_MODIFY):
                        value = {**who, 'userId': item['userId'], 'itemId': item['id'], 'at': int(time.time()*1000),
                                 'evidence': 'write' if mask & FAN_MODIFY else 'tool-read'}
                        prior = recent.get(item['id'])
                        if prior and prior['processIdentity'] == value['processIdentity'] and prior['evidence'] == value['evidence'] and value['at']-prior['at'] < 1000:
                            continue
                        temporary = os.path.join(marker_root, item['id']+'.tmp')
                        with open(temporary, 'w') as marker:
                            json.dump(value, marker, separators=(',', ':'))
                            marker.flush(); os.fsync(marker.fileno())
                        os.replace(temporary, os.path.join(marker_root, item['id']+'.json'))
                        directory_fd = os.open(marker_root, os.O_RDONLY | os.O_DIRECTORY)
                        try:
                            os.fsync(directory_fd)
                        finally:
                            os.close(directory_fd)
                        recent[item['id']] = value
                        emit({'event': 'used', **value})
                finally:
                    if mask & (FAN_OPEN_PERM | FAN_ACCESS_PERM):
                        os.write(fd, struct.pack('=iI', event_fd, FAN_ALLOW))
                    os.close(event_fd)
finally:
    os.close(fd)
