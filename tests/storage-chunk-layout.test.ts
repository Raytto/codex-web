import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';
import {migrateStorageLifecycle} from '../server/storage-lifecycle-schema.js';
import {fileChunkBytes,migrateStorageChunkLayouts,LEGACY_CHUNK_BYTES} from '../server/storage-chunk-layout.js';
test('activation cutover preserves old files, old catalog entries after restore and pinned upload plans',()=>{
 const db=new DatabaseSync(':memory:');migrateStorageLifecycle(db);
 try{
  db.prepare("UPDATE storage_scan_state SET updated_at=10000 WHERE name='file-chunk-policy-v2'").run();
  const stat=(birth:number)=>({birthtimeMs:birth,mtimeMs:birth} as fs.Stats),GiB=1024**3;
  assert.equal(fileChunkBytes(db,'a','/old',stat(9999),GiB),LEGACY_CHUNK_BYTES);
  assert.equal(fileChunkBytes(db,'a','/new',stat(10001),GiB),GiB);
  assert.equal(fileChunkBytes(db,'a','/restored',stat(20000),GiB,9999),LEGACY_CHUNK_BYTES);
  assert.equal(fileChunkBytes(db,'a','/old',stat(20000),1.5*GiB),LEGACY_CHUNK_BYTES);
  assert.equal(fileChunkBytes(db,'b','/old',stat(20000),GiB),GiB,'no account-crossing policy lookup');
  migrateStorageChunkLayouts(db,30000);
  assert.equal(db.prepare("SELECT updated_at FROM storage_scan_state WHERE name='file-chunk-policy-v2'").get()!.updated_at,10000);
 }finally{db.close();}
});
