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
