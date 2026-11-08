#!/usr/bin/env python3
"""Recover one archived file from an exported catalogue and downloaded cloud files.
No network, Codex Web database, login, or original instance paths are required.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def load_catalog(location):
    files = sorted(location.glob('catalog-*.json')) if location.is_dir() else [location]
    catalog = None
    for file in files:
        value = json.loads(file.read_text())
        if value.get('format') == 'pp-portable-catalog-v1':
            catalog = value
            continue
        if value.get('format') != 'pp-portable-catalog-delta-v1' or catalog is None:
            raise ValueError('catalog_base_missing')
        if hashlib.sha256(encoded(catalog)).hexdigest() != value['baseSha256']:
            raise ValueError('catalog_delta_missing_or_out_of_order')
        for name in ['versions', 'chunks', 'legacy', 'nativeUnits', 'backupPoints']:
            rows = {r['id']: r for r in catalog[name]}
            for key in value['removed'][name]:
                rows.pop(key, None)
            rows.update({r['id']: r for r in value['changed'][name]})
            catalog[name] = sorted(rows.values(), key=lambda r: r['id'])
        if hashlib.sha256(encoded(catalog)).hexdigest() != value['resultSha256']:
            raise ValueError('catalog_delta_result_hash')
    if not catalog:
        raise ValueError('catalog_missing')
    return catalog


def copy_checked(source, output, size, expected_hash):
    digest = hashlib.sha256()
    total = 0
    while True:
        data = source.read(1024 * 1024)
        if not data:
            break
        total += len(data)
        if total > size:
            raise ValueError('size_exceeded')
        digest.update(data)
        if output:
            output.write(data)
    if total != size or digest.hexdigest() != expected_hash:
        raise ValueError('hash_or_size_mismatch')


def cloud_file(root, remote, size, sha):
    parts = PurePosixPath(remote).parts
    if not remote.startswith('/') or any(p in ('..', '.') for p in parts) or '\\' in remote:
        raise ValueError('unsafe_cloud_path')
    file = root.joinpath(*parts[1:])
    if file.resolve() != file or root not in file.parents or not file.is_file():
        raise ValueError('cloud_file_missing_or_symlink')
    with file.open('rb') as stream:
        copy_checked(stream, None, size, sha)
    return file


def decode(file, key, action):
    process = subprocess.Popen(['age', '-d', '-i', str(key), str(file)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        action(process.stdout)
        while process.stdout.read(1024 * 1024):
            pass
        if process.wait() != 0:
            raise ValueError('age_decrypt_failed')
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
        process.wait()


def recover(catalog, record, root, key, output, member=None):
    if 'chunkIds' in record:
        chunks = {c['id']: c for c in catalog['chunks']}
        for cid in record['chunkIds']:
            chunk = chunks[cid]
            if chunk['user_id'] != record['account'] or chunk['codec'] != 'gzip-age-v1':
                raise ValueError('chunk_owner_or_codec')
            file = cloud_file(root, chunk['remote_path'], chunk['ciphertext_bytes'], chunk['ciphertext_sha256'])
            def extract(stream):
                with gzip.GzipFile(fileobj=stream) as plain:
                    copy_checked(plain, output, chunk['plaintext_bytes'], chunk['plaintext_sha256'])
            decode(file, key, extract)
        return record['bytes'], record['sha256']
    file = cloud_file(root, record['remote_path'], record['archive_bytes'], record['archive_sha256'])
    manifest = json.loads(record['manifest_json'])
    if record['kind'] == 'voice':
        decode(file, key, lambda stream: copy_checked(stream, output, manifest['size'], manifest['sha256']))
        return manifest['size'], manifest['sha256']
    if not member:
        raise ValueError('legacy_tar_requires_explicit_member')
    entries = {(e['kind'] + '/' if record['kind'] == 'conversation' else 'resources/') + e['relativePath']: e for e in manifest['entries']}
    if member not in entries:
        raise ValueError('member_not_in_verified_manifest')
    selected = entries[member]
    def extract(stream):
        found = False
        with tarfile.open(fileobj=stream, mode='r|*') as archive:
            for entry in archive:
                name = entry.name
                while name.startswith('./'):
                    name = name[2:]
                if name != member:
                    continue
                if found or not entry.isfile() or entry.size != selected['size']:
                    raise ValueError('invalid_tar_member')
                with archive.extractfile(entry) as plain:
                    copy_checked(plain, output, selected['size'], selected['sha256'])
                found = True
        if not found:
            raise ValueError('member_missing')
    decode(file, key, extract)
    return selected['size'], selected['sha256']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', required=True)
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--id')
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--cloud-directory', help='Directory mirroring cloud absolute paths without the leading slash')
    parser.add_argument('--key')
    parser.add_argument('--member')
    parser.add_argument('--output')
    args = parser.parse_args()
    catalog = load_catalog(Path(args.catalog))
    if catalog.get('format') != 'pp-portable-catalog-v1':
        raise ValueError('unsupported_catalog')
    records = [*catalog['versions'], *catalog['legacy']]
    if args.list:
        for r in records:
            print(json.dumps({k: r[k] for k in ['id', 'account', 'user_id', 'name', 'kind', 'current', 'locator', 'subject_id'] if k in r}, ensure_ascii=False))
        return
    record = next((r for r in records if r['id'] == args.id), None)
    if not record:
        raise ValueError('record_not_found')
    if args.describe:
        chunks = {c['id']: c for c in catalog['chunks']}
        print(json.dumps(dict(record=record, download=[chunks[k] for k in record['chunkIds']] if 'chunkIds' in record else [record]), ensure_ascii=False, indent=2))
        return
    if not all([args.cloud_directory, args.key, args.output]):
        parser.error('restore requires --cloud-directory, --key and --output')
    root, key = Path(args.cloud_directory).resolve(), Path(args.key).resolve()
    target = Path(args.output).absolute()
    if target.parent.resolve() != target.parent:
        raise ValueError('output_parent_symlink')
    created = False
    try:
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        created = True
        with os.fdopen(fd, 'wb') as output:
            size, sha = recover(catalog, record, root, key, output, args.member)
            output.flush()
            os.fsync(output.fileno())
        with target.open('rb') as stream:
            copy_checked(stream, None, size, sha)
        print(json.dumps(dict(recovered=True, bytes=size, sha256=sha)))
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    main()
