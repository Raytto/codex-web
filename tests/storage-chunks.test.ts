import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateStorageLifecycle } from '../server/storage-lifecycle-schema.js';
import { StorageCatalog } from '../server/storage-catalog.js';
import { StorageChunkStore, sha256Path, type ChunkTransport } from '../server/storage-chunks.js';
import { storagePolicy } from '../server/storage-lifecycle-policy.js';
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-storage-chunks-')),identity=path.join(root,'key'),recipient=path.join(root,'recipient');
  execFileSync('age-keygen',['-o',identity],{stdio:'ignore'});
  fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',identity]),{mode:0o600});
  const db=new DatabaseSync(':memory:');migrateStorageLifecycle(db);const catalog=new StorageCatalog(db);
  const remote=path.join(root,'remote');fs.mkdirSync(remote);
  let downloads=0,uploads=0,fail=false,corrupt=false;
  const transport:ChunkTransport={
    put:async(file,key)=>{uploads++;const dest=path.join(remote,crypto.createHash('sha256').update(key).digest('hex'));if(!fs.existsSync(dest))fs.copyFileSync(file,dest);if(fail)throw new Error('network_after_upload');},
    get:async(key,file)=>{downloads++;fs.copyFileSync(path.join(remote,crypto.createHash('sha256').update(key).digest('hex')),file);if(corrupt)fs.appendFileSync(file,'corrupt');},
  };
  const policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'test-drive',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:identity}),chunkBytes:1024*1024,scratchBytes:16*1024*1024};
  const store=new StorageChunkStore(catalog,policy,path.join(root,'scratch'),transport);
  const source=path.join(root,'source.bin');fs.writeFileSync(source,crypto.randomBytes(3*1024*1024+123));
  return {root,db,catalog,store,source,policy,counts:()=>({uploads,downloads}),fail:(v:boolean)=>{fail=v;},corrupt:(v:boolean)=>{corrupt=v;},close:()=>{db.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('real age/gzip multi-chunk roundtrip and account-local dedup never hardlink mutable files',async()=>{
  const f=fixture();try{
    const a=await f.store.archiveFile('alice',f.source);assert.equal(a.chunks.length,4);assert.equal(f.counts().downloads,4);
    const target=path.join(f.root,'restored');await f.store.restoreFile('alice',a.chunks,target,a);
    assert.equal(sha256Path(target),sha256Path(f.source));assert.notEqual(fs.statSync(target).ino,fs.statSync(f.source).ino);
    const before=f.counts().uploads;await f.store.archiveFile('alice',f.source);assert.equal(f.counts().uploads,before);
    const b=await f.store.archiveFile('bob',f.source);assert.equal(f.counts().uploads,before+4);
    assert.ok(b.chunks.every(c=>c.user_id==='bob'));
    await assert.rejects(f.store.restoreFile('bob',a.chunks,path.join(f.root,'cross'),a),/scope_mismatch/);
  }finally{f.close();}
});
test('process-style restart reuses fixed ciphertext after upload failure; corrupt download cannot verify',async()=>{
  const f=fixture();try{
    f.fail(true);await assert.rejects(f.store.archiveFile('alice',f.source),/network_after_upload/);
    const first=f.db.prepare('SELECT * FROM storage_chunk_uploads').get()!;assert.ok(first);assert.equal(fs.existsSync(f.source),true);
    f.fail(false);f.corrupt(true);await assert.rejects(f.store.archiveFile('alice',f.source),/ciphertext_hash_mismatch/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_chunks').get()!.n,0);
    assert.equal(f.db.prepare('SELECT remote_path FROM storage_chunk_uploads').get()!.remote_path,first.remote_path);
    f.corrupt(false);const result=await f.store.archiveFile('alice',f.source);assert.equal(result.chunks[0].remote_path,first.remote_path);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_chunk_uploads').get()!.n,0);
  }finally{f.close();}
});
test('quota/auth download failures and corrupt restored content leave original intact and no false target',async()=>{
  const f=fixture();try{
    const a=await f.store.archiveFile('alice',f.source);f.corrupt(true);const target=path.join(f.root,'failed-restore');
    await assert.rejects(f.store.restoreFile('alice',a.chunks,target,a),/ciphertext_hash_mismatch/);
    assert.equal(fs.existsSync(target),false);assert.equal(fs.statSync(f.source).size,a.bytes);
    fs.linkSync(f.source,path.join(f.root,'hardlink'));
    await assert.rejects(f.store.archiveFile('alice',f.source),/exclusive_regular/);
  }finally{f.close();}
});

test('production default, inclusive 1.5 GiB parameter ceiling and 6 GiB budget do not preallocate disk',()=>{
 const f=fixture();try{
  const GiB=1024**3,defaults=storagePolicy({});
  assert.equal(defaults.chunkBytes,GiB);assert.equal(defaults.scratchBytes,6*GiB);
  for(const bytes of [GiB-1,GiB,1.5*GiB-1,1.5*GiB]){
   const s=new StorageChunkStore(f.catalog,{...f.policy,chunkBytes:bytes,scratchBytes:6*GiB},path.join(f.root,'bounds'),f.store.transport);
   assert.equal(fs.readdirSync(s.scratch).length,0);
  }
  for(const bytes of [1.5*GiB+1,0,-1,1.5,NaN,Infinity])assert.throws(()=>new StorageChunkStore(f.catalog,{...f.policy,chunkBytes:bytes,scratchBytes:6*GiB},path.join(f.root,'invalid'),f.store.transport),/budget_invalid/);
 }finally{f.close();}
});

test('a restarted upload keeps its persisted split when the default changes; existing manifests and chunks stay immutable',async()=>{
 const f=fixture();try{
  f.fail(true);await assert.rejects(f.store.archiveFile('alice',f.source),/network_after_upload/);
  const pending=f.db.prepare('SELECT * FROM storage_chunk_uploads').get()!;
  const newer=new StorageChunkStore(f.catalog,{...f.policy,chunkBytes:2*1024**2},f.store.scratch,f.store.transport);
  f.fail(false);const result=await newer.archiveFile('alice',f.source);
  assert.deepEqual(result.chunks.map(c=>c.plaintext_bytes),[1024**2,1024**2,1024**2,123]);
  assert.equal(result.chunks[0].remote_path,pending.remote_path);
  const before=JSON.stringify(f.db.prepare('SELECT * FROM storage_chunks ORDER BY id').all());
  const uploadCount=f.counts().uploads;await newer.archiveFile('alice',f.source);
  assert.equal(f.counts().uploads,uploadCount);assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM storage_chunks ORDER BY id').all()),before);
  await newer.restoreFile('alice',result.chunks,path.join(f.root,'new-reader-old-chunks'),result);
  assert.equal(sha256Path(path.join(f.root,'new-reader-old-chunks')),sha256Path(f.source));
 }finally{f.close();}
});

test('existing residual staging consumes budget and refusal preserves the original',async()=>{
 const f=fixture();try{
  fs.writeFileSync(path.join(f.store.scratch,'previous-upload.age'),Buffer.alloc(14*1024**2));
  await assert.rejects(f.store.archiveFile('alice',f.source),/scratch_budget/);
  assert.equal(fs.statSync(f.source).size,3*1024**2+123);assert.equal(f.counts().uploads,0);
 }finally{f.close();}
});

test('restore accounts actual expanded ciphertext alongside interrupted staging rather than reserving three extra chunks',async()=>{
 const f=fixture();try{
  const archived=await f.store.archiveFile('alice',f.source);
  fs.writeFileSync(path.join(f.store.scratch,'interrupted.age'),Buffer.alloc(2*1024**2));
  const store=new StorageChunkStore(f.catalog,{...f.policy,scratchBytes:4*1024**2},f.store.scratch,f.store.transport);
  await store.restoreFile('alice',archived.chunks,path.join(f.root,'with-residual'),archived);
  assert.equal(sha256Path(path.join(f.root,'with-residual')),archived.sha256);
  assert.equal(fs.statSync(path.join(f.store.scratch,'interrupted.age')).size,2*1024**2);
 }finally{f.close();}
});
