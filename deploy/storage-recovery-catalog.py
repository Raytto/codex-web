#!/usr/bin/env python3
"""Read-only portable catalogue. Contains private filenames: encrypt before upload."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def collect(database):
    db = sqlite3.connect(Path(database).as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    try:
        chunks = {r['id']: dict(r) for r in db.execute('SELECT * FROM storage_chunks WHERE verified_at IS NOT NULL ORDER BY id')}
        versions = []
        for row in db.execute('SELECT v.*,i.display_name,i.locator_json,i.current_version,i.kind FROM storage_versions v JOIN storage_items i ON i.id=v.item_id AND i.user_id=v.user_id WHERE v.verified_at IS NOT NULL ORDER BY v.id'):
            r = dict(row)
            raw = r['manifest_json']
            if not raw or hashlib.sha256(raw.encode()).hexdigest() != r['manifest_sha256']:
                raise ValueError('catalog_manifest_hash')
            manifest = json.loads(raw)
            ids = [x[0] for x in db.execute('SELECT chunk_id FROM storage_version_chunks WHERE version_id=? ORDER BY ordinal', (r['id'],))]
            if ids != manifest['chunks'] or any(k not in chunks or chunks[k]['user_id'] != r['user_id'] for k in ids):
                raise ValueError('catalog_chunk_order_or_owner')
            if sum(chunks[k]['plaintext_bytes'] for k in ids) != r['logical_bytes']:
                raise ValueError('catalog_chunk_size')
            versions.append(dict(id=r['id'], account=r['user_id'], name=r['display_name'], kind=r['kind'],
                current=r['current_version'] == r['id'], locator=json.loads(r['locator_json']),
                sha256=r['sha256'], bytes=r['logical_bytes'], manifest=manifest, manifestSha256=r['manifest_sha256'],
                manifestJson=raw, chunkIds=ids, verifiedAt=r['verified_at']))
        legacy = {}
        queries = [
            "SELECT kind,subject_id,generation,user_id,remote_drive,remote_path,archive_sha256,archive_bytes,manifest_json FROM storage_legacy_generations WHERE verified_at IS NOT NULL",
            "SELECT 'conversation' kind,s.conversation_id subject_id,s.generation,c.user_id,s.remote_drive_id remote_drive,s.remote_path,s.archive_sha256,s.archive_bytes,s.manifest_json FROM conversation_storage s JOIN conversations c ON c.id=s.conversation_id WHERE s.verified_at IS NOT NULL AND s.remote_path IS NOT NULL",
            "SELECT 'reader' kind,id subject_id,storage_generation generation,user_id,remote_drive_id remote_drive,remote_path,storage_archive_sha256 archive_sha256,storage_archive_bytes archive_bytes,storage_manifest_json manifest_json FROM reading_source_versions WHERE storage_verified_at IS NOT NULL AND remote_path IS NOT NULL",
            "SELECT 'voice' kind,id subject_id,audio_generation generation,user_id,audio_remote_drive_id remote_drive,audio_remote_path remote_path,audio_archive_sha256 archive_sha256,audio_archive_bytes archive_bytes,json_object('size',audio_bytes,'sha256',audio_sha256,'path',audio_relative_path) manifest_json FROM voice_transcriptions WHERE audio_verified_at IS NOT NULL AND audio_remote_path IS NOT NULL",
        ]
        for query in queries:
            for row in db.execute(query):
                r = dict(row)
                identity = json.dumps([r['remote_drive'], r['remote_path']], separators=(',', ':'))
                r['id'] = 'legacy-' + hashlib.sha256(identity.encode()).hexdigest()
                if not r['manifest_json'] or not r['archive_sha256'] or not r['archive_bytes']:
                    raise ValueError('catalog_legacy_proof_missing')
                old = legacy.get(r['id'])
                if old and (old['archive_sha256'], old['archive_bytes']) != (r['archive_sha256'], r['archive_bytes']):
                    raise ValueError('catalog_legacy_conflict')
                legacy[r['id']] = r
        # Explicitly report incomplete points; never turn a material index into a full backup.
        points = [dict(r) for r in db.execute('SELECT id,instance_id,created_at,state,verified_at,restore_tested_at FROM storage_backup_points ORDER BY id')]
        native = [dict(r) for r in db.execute('SELECT id,user_id,conversation_id,manifest_json,manifest_sha256,verified_at FROM storage_native_units WHERE verified_at IS NOT NULL ORDER BY id')]
        return dict(format='pp-portable-catalog-v1', completeSiteBackup=False,
            versions=versions, chunks=list(chunks.values()), legacy=sorted(legacy.values(), key=lambda r: r['id']),
            nativeUnits=native, backupPoints=points,
            limits=['Only verified archived versions are covered; local-only data is absent.',
                    'A preparing backup point is incomplete; this catalogue is not a whole-site restore proof.'])
    finally:
        db.rollback()
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    payload = json.dumps(collect(args.database), ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as out:
        out.write(payload)
        out.flush()
        os.fsync(out.fileno())
    print(json.dumps(dict(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())))


if __name__ == '__main__':
    main()
