import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateStorageLifecycle } from '../server/storage-lifecycle-schema.js';
import { StorageCatalog, type StorageReplica } from '../server/storage-catalog.js';
import { StorageChunkStore } from '../server/storage-chunks.js';
import { storagePolicy, STORAGE_DAY } from '../server/storage-lifecycle-policy.js';
import { StorageFileLifecycle } from '../server/storage-file-lifecycle.js';
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-file-lifecycle-')),files=path.join(root,'files'),remote=path.join(root,'remote');
  fs.mkdirSync(files);fs.mkdirSync(remote);const key=path.join(root,'key'),recipient=path.join(root,'recipient');
  execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));
  const db=new DatabaseSync(':memory:');migrateStorageLifecycle(db);let now=Date.now(),busy=false;
  const c=new StorageCatalog(db,()=>now),policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'d',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:key}),chunkBytes:1024*1024,scratchBytes:8*1024*1024};
  const transport={put:async(file:string,name:string)=>{fs.copyFileSync(file,path.join(remote,path.basename(name)));},get:async(name:string,file:string)=>{fs.copyFileSync(path.join(remote,path.basename(name)),file);}};
  const store=new StorageChunkStore(c,policy,path.join(root,'scratch'),transport);
  const lifecycle=new StorageFileLifecycle(c,store,path.join(root,'isolation'),(u,r)=>{assert.equal(u,'alice');assert.equal(r,'conversation');return files;},()=>{if(busy)throw new Error('active_process');});
  const source=path.join(files,'sample.bin');fs.writeFileSync(source,crypto.randomBytes(12345),{mode:0o640});
  const item=c.enroll({userId:'alice',scope:'conversation:c',sourceKey:'f',kind:'file',locator:{root:'conversation',path:'sample.bin'},name:'sample.bin',trustedUsedAt:now-100*STORAGE_DAY});
  return {root,c,db,lifecycle,source,item,advance:(ms:number)=>{now+=ms;},busy:(v:boolean)=>{busy=v;},close:()=>{db.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('warm-up leaves older isolation eligible after its own three days and does not remove the warm original',async()=>{
  const f=fixture();try{
    const r=await f.lifecycle.archive('alice',f.item.id);assert.equal(fs.existsSync(f.source),false);assert.equal(fs.statSync(r.path).size,12345);
    assert.throws(()=>f.lifecycle.purge(r),/in_grace/);
    f.advance(2*STORAGE_DAY);await f.lifecycle.restore('alice',f.item.id,'user-read');assert.equal(fs.statSync(f.source).mode&0o777,0o640);
    f.advance(STORAGE_DAY);assert.equal(f.lifecycle.purge(r),r.allocated_bytes);assert.equal(fs.existsSync(r.path),false);assert.equal(fs.existsSync(f.source),true);
    assert.equal(f.lifecycle.purge(r),0);assert.equal(f.c.due(f.c.item('alice',f.item.id)),false);
  }finally{f.close();}
});
test('a process exit after filesystem rename has a durable plan and starts grace only on recovery',async()=>{
  const f=fixture();const rename=fs.renameSync;let injected=false;
  try{
    fs.renameSync=((a:fs.PathLike,b:fs.PathLike)=>{rename(a,b);if(String(a)===f.source&&!injected){injected=true;throw new Error('crash_after_rename');}}) as typeof fs.renameSync;
    await assert.rejects(f.lifecycle.archive('alice',f.item.id),/crash_after_rename/);fs.renameSync=rename;
    const r=f.db.prepare('SELECT * FROM storage_replicas').get() as StorageReplica;assert.ok(r);assert.equal(r.isolated_at,null);assert.equal(fs.existsSync(r.path),true);
    f.advance(10*STORAGE_DAY);await f.lifecycle.archive('alice',f.item.id);
    assert.equal(f.c.isolationDue().length,0);f.advance(3*STORAGE_DAY);assert.equal(f.c.isolationDue().length,1);
    f.lifecycle.purge(r);
  }finally{fs.renameSync=rename;f.close();}
});
test('active dependency and altered isolation block deletion, leaving the only local copy intact',async()=>{
  const f=fixture();try{
    f.busy(true);await assert.rejects(f.lifecycle.archive('alice',f.item.id),/active_process/);assert.equal(fs.existsSync(f.source),true);
    f.busy(false);const r=await f.lifecycle.archive('alice',f.item.id);f.advance(3*STORAGE_DAY);f.busy(true);
    assert.throws(()=>f.lifecycle.purge(r),/active_process/);assert.equal(fs.existsSync(r.path),true);
    f.busy(false);fs.appendFileSync(r.path,'changed');assert.throws(()=>f.lifecycle.purge(r),/replica_changed/);assert.equal(fs.existsSync(r.path),true);
  }finally{f.close();}
});

test('a crashed standalone SQLite writer is checkpointed through SQLite before its complete database is archived',async()=>{
 const f=fixture();try{
  fs.unlinkSync(f.source);
  const code=String.raw`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE valuable(value TEXT);INSERT INTO valuable VALUES('retained WAL work')");process.kill(process.pid,'SIGKILL')`;
  try{execFileSync(process.execPath,['-e',code,f.source],{stdio:'ignore'});}catch(error){assert.equal((error as {signal?:string}).signal,'SIGKILL');}
  assert.ok(fs.statSync(f.source+'-wal').size>0);
  const replica=await f.lifecycle.archive('alice',f.item.id);assert.ok(replica);
  const source=await f.lifecycle.restore('alice',f.item.id,'user-read'),check=new DatabaseSync(source,{readOnly:true});
  try{assert.equal(check.prepare('SELECT value FROM valuable').get()!.value,'retained WAL work');assert.equal(check.prepare('PRAGMA quick_check').get()!.quick_check,'ok');}finally{check.close();}
 }finally{f.close();}
});

test('cache pressure can isolate an unchanged rewarm copy early but still preserves three real days and rejects modified work',async()=>{
 const f=fixture();try{
  const first=await f.lifecycle.archive('alice',f.item.id);f.advance(3*STORAGE_DAY);f.lifecycle.purge(first);
  await f.lifecycle.restore('alice',f.item.id,'user-read');
  await assert.rejects(f.lifecycle.archive('alice',f.item.id,{cachePressure:true}),/storage_not_due/);
  f.advance(16*60_000);const second=await f.lifecycle.archive('alice',f.item.id,{cachePressure:true});
  assert.throws(()=>f.lifecycle.purge(second),/storage_replica_in_grace/);
  await f.lifecycle.restore('alice',f.item.id,'user-read');fs.appendFileSync(f.source,'unique edited work');f.advance(16*60_000);
  await assert.rejects(f.lifecycle.archive('alice',f.item.id,{cachePressure:true}),/storage_cache_copy_changed/);
  assert.ok(fs.readFileSync(f.source).includes(Buffer.from('unique edited work')));
 }finally{f.close();}
});
