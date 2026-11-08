import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {AppDatabase} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import {StorageChunkStore} from '../server/storage-chunks.js';
import {StorageBackups} from '../server/storage-backups.js';
import {storagePolicy,STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {collectStorageCloud} from '../server/storage-cloud-gc.js';

test('cloud GC preserves live pins, waits its grace, retries failures, and permits re-archiving identical material',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-cloud-gc-')),db=new AppDatabase(path.join(root,'data'),undefined,false);
 try{
  let now=Date.now(),failDelete=true;const cloud=new Map<string,Buffer>(),key=path.join(root,'key'),recipient=path.join(root,'recipient'),source=path.join(root,'original');
  execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));fs.writeFileSync(source,crypto.randomBytes(8192));
  const catalog=new StorageCatalog(db.sqlite,()=>now),policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'drive',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:key}),chunkBytes:65536,scratchBytes:4*1024**2};
  const chunks=new StorageChunkStore(catalog,policy,path.join(root,'scratch'),{put:async(file,remote)=>{cloud.set(remote,fs.readFileSync(file));},get:async(remote,file)=>{fs.writeFileSync(file,cloud.get(remote)!);}});
  const backups=new StorageBackups(catalog,chunks,{instanceId:'test',codeSha:'a'.repeat(40),keyRecovery:{mode:'external',reference:'fixture'}});
  db.sqlite.prepare("INSERT INTO storage_backup_points(id,instance_id,created_at,manifest_json,manifest_sha256,kind,state,verified_at,restore_tested_at) VALUES('fixture','test',?,'{}','','fixture','verified',?,?)").run(now,now,now);
  const material=await backups.captureFile('fixture','files/one',source),cipher=material.chunks[0],remote={locate:async(name:string)=>{const data=cloud.get(name);if(!data)throw new Error('storage_cloud_object_missing');return {file_id:name,size:data.length};},
   deleteExact:async(name:string)=>{if(failDelete)throw new Error('network_unavailable');cloud.delete(name);return {pending:false};}};
  now+=30*STORAGE_DAY;assert.equal((await collectStorageCloud(catalog,remote)).versions,0);assert.equal(cloud.size,1);
  db.sqlite.prepare("DELETE FROM storage_references WHERE kind='backup'").run();db.sqlite.prepare('DELETE FROM storage_backup_materials').run();
  await collectStorageCloud(catalog,remote);now+=7*STORAGE_DAY;
  assert.equal((await collectStorageCloud(catalog,remote)).versions,1);assert.equal(cloud.size,1);
  now+=7*STORAGE_DAY;assert.ok((await collectStorageCloud(catalog,remote)).blocked.includes('network_unavailable'));assert.equal(cloud.size,1);
  assert.throws(()=>catalog.protectChunk(cipher.id),/gc_in_progress/);
  failDelete=false;const receipt=await collectStorageCloud(catalog,remote);assert.equal(receipt.chunks,1);assert.equal(receipt.cipherBytesRemoved,cipher.ciphertext_bytes);assert.equal(cloud.size,0);
  const next=await backups.captureFile('fixture','files/one',source);assert.notEqual(next.versionId,material.versionId);assert.notEqual(next.chunks[0].id,cipher.id);assert.equal(cloud.size,1);
  const pending=next.chunks[0];db.sqlite.prepare('INSERT INTO storage_gc_chunks(chunk_id,queued_at,remote_path,ciphertext_bytes) VALUES(?,?,?,?)').run(pending.id,now-8*STORAGE_DAY,pending.remote_path,pending.ciphertext_bytes);
  catalog.protectChunk(pending.id);assert.equal(db.sqlite.prepare('SELECT 1 FROM storage_gc_chunks WHERE chunk_id=?').get(pending.id),undefined);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
