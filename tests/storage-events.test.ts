import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {AppDatabase,LEGACY_USER_ID} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import {StorageChunkStore} from '../server/storage-chunks.js';
import {StorageFileLifecycle} from '../server/storage-file-lifecycle.js';
import {storagePolicy,STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {prepareEventBatch,archiveEventBatch,reconcileEventReferences} from '../server/storage-events.js';
import {readEventHistory} from '../server/storage-event-reader.js';
import {DatabaseSync} from 'node:sqlite';

test('event serialization and fsync leave the WAL writer available, with bounded lossless partitions',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-event-contention-')),db=new AppDatabase(root,undefined,false);
 const peer=new DatabaseSync(path.join(root,'codex-web.sqlite'));peer.exec('PRAGMA busy_timeout=1');
 try{
  const cid=crypto.randomUUID(),jid=crypto.randomUUID();db.createConversation(cid,'partition');db.createJob(jid,cid);
  const insert=db.sqlite.prepare('INSERT INTO job_events(job_id,seq,event_type,payload,created_at) VALUES(?,?,?,?,?)');
  db.sqlite.exec('BEGIN IMMEDIATE');
  for(let i=1;i<=500;i++)insert.run(jid,i,'progress','x'.repeat(8192),new Date(Date.now()-40*STORAGE_DAY).toISOString());
  db.sqlite.exec('COMMIT');db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jid);
  const original=fs.fsyncSync;let syncs=0;
  t.mock.method(fs,'fsyncSync',(fd:number)=>{
   assert.equal(db.sqlite.isTransaction,false,'slow disk work must not own the shared writer');
   peer.prepare('UPDATE jobs SET updated_at=updated_at WHERE id=?').run(jid);syncs++;original(fd);
  });
  const catalog=new StorageCatalog(db.sqlite),directory=path.join(root,'events');
  const batch=prepareEventBatch(catalog,jid,directory,256*1024**2)!;
  assert.ok(syncs>0);assert.ok(batch.event_count>0&&batch.event_count<=256);
  assert.ok(fs.statSync(path.join(directory,batch.id+'.jsonl')).size<=1024**2);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM job_events WHERE job_id=?').get(jid)!.n,500);
  assert.equal(prepareEventBatch(catalog,jid,directory)!.id,batch.id,'idempotent existing partition');
 }finally{peer.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('old events are pruned only after verified cloud storage, and an empty event table never resets its sequence',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-events-')),db=new AppDatabase(path.join(root,'data'),undefined,false);
 try{
  let now=Date.now(),badHash=true;const cid=crypto.randomUUID(),jid=crypto.randomUUID(),key=path.join(root,'key'),recipient=path.join(root,'recipient'),events=path.join(root,'events');
  execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));
  db.createConversation(cid,'old events');db.createJob(jid,cid);
  for(let i=1;i<=3;i++)assert.equal(db.appendEvent(jid,'progress',{step:i}),i);
  db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jid);
  db.sqlite.prepare('UPDATE job_events SET created_at=? WHERE job_id=?').run(new Date(now-40*STORAGE_DAY).toISOString(),jid);
  const catalog=new StorageCatalog(db.sqlite,()=>now),cloud=new Map<string,Buffer>(),policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'drive',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:key}),chunkBytes:65536,scratchBytes:4*1024**2};
  const chunks=new StorageChunkStore(catalog,policy,path.join(root,'scratch'),{put:async(file,remote)=>{cloud.set(remote,fs.readFileSync(file));},get:async(remote,file)=>{const body=Buffer.from(cloud.get(remote)!);if(badHash)body[0]^=1;fs.writeFileSync(file,body);}});
  const lifecycle=new StorageFileLifecycle(catalog,chunks,path.join(root,'isolated'),()=>events,()=>undefined),batch=prepareEventBatch(catalog,jid,events)!;
  await assert.rejects(archiveEventBatch(lifecycle,batch),/ciphertext_hash/);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM job_events WHERE job_id=?').get(jid)!.n,3);
  badHash=false;assert.equal(await archiveEventBatch(lifecycle,batch),3);assert.equal(await archiveEventBatch(lifecycle,batch),0);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM job_events WHERE job_id=?').get(jid)!.n,0);assert.equal(db.appendEvent(jid,'late-audit',{retained:true}),4);
  const resolve=(item:{locator_json:string})=>path.join(events,JSON.parse(item.locator_json).path);
  const request={jobId:jid,limit:2};
  const beforeRead=catalog.item(LEGACY_USER_ID,batch.item_id).last_used_at;
  assert.equal((await readEventHistory(catalog,LEGACY_USER_ID,request,resolve,'test')).state,'cold');
  assert.equal(catalog.item(LEGACY_USER_ID,batch.item_id).last_used_at,beforeRead);
  await assert.rejects(readEventHistory(catalog,'other',request,resolve,'test'),/job_not_found/);
  await assert.rejects(readEventHistory(catalog,LEGACY_USER_ID,{...request,afterSeq:-1},resolve,'test'),/cursor_invalid/);
  const restored=await lifecycle.restore(LEGACY_USER_ID,batch.item_id,'tool-read');assert.equal(fs.readFileSync(restored,'utf8').trim().split('\n').length,3);
  const first=await readEventHistory(catalog,LEGACY_USER_ID,request,resolve,'test');assert.deepEqual(first.events?.map(e=>e.seq),[1,2]);assert.equal(first.nextSeq,2);assert.equal(first.hasMore,true);
  const second=await readEventHistory(catalog,LEGACY_USER_ID,{...request,afterSeq:2},resolve,'test');assert.deepEqual(second.events?.map(e=>e.seq),[3]);assert.equal(second.hasMore,true);
  assert.deepEqual((await readEventHistory(catalog,LEGACY_USER_ID,{...request,afterSeq:3},resolve,'test')).events?.map(e=>e.seq),[4]);
  const raw=await readEventHistory(catalog,LEGACY_USER_ID,{jobId:jid,batchId:batch.id},resolve,'test');assert.equal(Buffer.from(raw.bodyBase64!,'base64').toString(),fs.readFileSync(restored,'utf8'));
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM storage_leases WHERE released_at IS NULL').get()!.n,0);
  const version=catalog.item(LEGACY_USER_ID,batch.item_id).current_version!;
  catalog.reference(LEGACY_USER_ID,version,'recovery-events',jid);reconcileEventReferences(catalog);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM storage_references WHERE kind='recovery-events'").get()!.n,0);
  db.sqlite.prepare('INSERT INTO job_recovery_checkpoints(job_id,checkpoint_json) VALUES(?,?)').run(jid,'{}');reconcileEventReferences(catalog);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM storage_references WHERE kind='recovery-events'").get()!.n,1);
  now+=3*STORAGE_DAY;for(const replica of catalog.isolationDue())lifecycle.purge(replica);
  assert.equal(fs.existsSync(restored),true);assert.equal(db.sqlite.prepare('SELECT high_water FROM job_event_sequences WHERE job_id=?').get(jid)!.high_water,4);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('oversized cold events are exposed as bounded byte ranges without cross-account access or truncation',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-event-pages-')),db=new AppDatabase(root,undefined,false);
 try{
  const catalog=new StorageCatalog(db.sqlite),cid=crypto.randomUUID(),jid=crypto.randomUUID();db.createConversation(cid,'history');db.createJob(jid,cid);
  const body=JSON.stringify({seq:1,event_type:'large',payload:'汉字'.repeat(300000),created_at:new Date().toISOString()})+'\n',file=path.join(root,'events.jsonl'),sha256=crypto.createHash('sha256').update(body).digest('hex');fs.writeFileSync(file,body);
  const item=catalog.enroll({userId:LEGACY_USER_ID,scope:'events',sourceKey:'test',kind:'events',name:'events.jsonl',locator:{root:'events',path:'events.jsonl'}});
  const version=catalog.registerVersion(LEGACY_USER_ID,item.id,{sha256,bytes:Buffer.byteLength(body),fingerprint:'test'});
  db.sqlite.prepare("UPDATE storage_versions SET verified_at=?,state='local' WHERE id=?").run(Date.now(),version.id);
  db.sqlite.prepare('INSERT INTO storage_event_batches(id,user_id,job_id,first_seq,last_seq,event_count,sha256,item_id,created_at,expires_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('batch',LEGACY_USER_ID,jid,1,1,1,sha256,item.id,Date.now(),Date.now()+1e7,Date.now());
  const page=await readEventHistory(catalog,LEGACY_USER_ID,{jobId:jid},()=>file,'test');assert.equal(page.requiresByteRead,true);
  let offset=0;const buffers:Buffer[]=[];
  for(;;){const part=await readEventHistory(catalog,LEGACY_USER_ID,{jobId:jid,batchId:'batch',offsetBytes:offset},()=>file,'test');const buffer=Buffer.from(part.bodyBase64!,'base64');assert.ok(buffer.length<=128*1024);buffers.push(buffer);offset=part.nextOffsetBytes!;if(part.done)break;}
  assert.equal(crypto.createHash('sha256').update(Buffer.concat(buffers)).digest('hex'),sha256);
  await assert.rejects(readEventHistory(catalog,'other',{jobId:jid,batchId:'batch'},()=>file,'test'),/job_not_found/);
  db.sqlite.prepare("UPDATE storage_versions SET state='error' WHERE id=?").run(version.id);
  assert.equal((await readEventHistory(catalog,LEGACY_USER_ID,{jobId:jid},()=>file,'test')).state,'expired');
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
