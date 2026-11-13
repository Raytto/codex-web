import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {AppDatabase,LEGACY_USER_ID} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import {StorageChunkStore} from '../server/storage-chunks.js';
import {StorageFileLifecycle,safeStorageMember} from '../server/storage-file-lifecycle.js';
import {storageRoot} from '../server/storage-inventory.js';
import {storagePolicy,STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {runStorageMaintenance,verifyVersionPresent} from '../server/storage-maintenance.js';
import type {StorageHost} from '../server/storage-host.js';

test('known-account unclassified native work has finite preservation and exact recovery; absent recovery manifest forbids final purge',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-maint-pass-')),dataRoot=path.join(root,'data'),db=new AppDatabase(dataRoot,undefined,false);
 try{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const lifecycleRoot=path.join(root,'lifecycle'),roots={dataRoot,tenantRoot:path.join(root,'tenants'),hostRootCodexHome:path.join(root,'host'),hostUserId:crypto.randomUUID(),lifecycleRoot};
  const home=path.join(roots.tenantRoot,LEGACY_USER_ID,'codex-home'),source=path.join(home,'sessions','damaged-header.jsonl');fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,'unique interrupted engine recovery material\n');
  const key=path.join(root,'key'),recipient=path.join(root,'recipient');execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));
  const catalog=new StorageCatalog(db.sqlite),policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'fixture',STORAGE_AGE_IDENTITY:key,STORAGE_AGE_RECIPIENT:recipient}),chunkBytes:1024**2,scratchBytes:16*1024**2};
  const cloud=new Map<string,Buffer>(),chunks=new StorageChunkStore(catalog,policy,path.join(lifecycleRoot,'scratch'),{put:async(file,remote)=>{cloud.set(remote,fs.readFileSync(file));},get:async(remote,file)=>{fs.writeFileSync(file,cloud.get(remote)!);}});
  const files=new StorageFileLifecycle(catalog,chunks,path.join(lifecycleRoot,'isolated'),(u,r)=>storageRoot(catalog,roots,u,r));
  const host={catalog,db:db.sqlite,roots,policy,chunks,files,inventory:()=>({}),writeIndex:()=>undefined,source:(item:{locator_json:string;user_id:string})=>{const loc=JSON.parse(item.locator_json);return safeStorageMember(storageRoot(catalog,roots,item.user_id,loc.root),loc.path);},
   legacyRoots:{isolationRoot:path.join(root,'legacy'),voiceIsolationRoot:path.join(root,'voice-legacy')},reader:{assertPresent:async(remote:string,bytes:number)=>assert.equal(cloud.get(remote)?.length,bytes)}} as unknown as StorageHost;
  const first=await runStorageMaintenance(host);assert.ok(first.blocked.some(b=>b.scope==='native-unclassified'));
  const item=catalog.linked(LEGACY_USER_ID,'native-unclassified','sessions/damaged-header.jsonl')[0];assert.equal(item.retention_days,60);assert.ok(fs.existsSync(source));
  const originalDue=item.last_used_at+60*STORAGE_DAY;t.mock.timers.setTime(originalDue+1);
  const second=await runStorageMaintenance(host);assert.equal(second.filesIsolated,1);assert.equal(fs.existsSync(source),false);assert.equal(catalog.item(LEGACY_USER_ID,item.id).last_used_at,item.last_used_at);
  await assert.rejects(verifyVersionPresent(host,LEGACY_USER_ID,catalog.item(LEGACY_USER_ID,item.id).current_version!),/recovery_manifest_pending/);
  t.mock.timers.setTime(originalDue+3*STORAGE_DAY+2);const third=await runStorageMaintenance(host);assert.equal(third.releasedBytes,0);assert.ok(third.blocked.some(b=>b.reason==='storage_version_recovery_manifest_pending'));
  await files.restore(LEGACY_USER_ID,item.id,'tool-read');assert.match(fs.readFileSync(source,'utf8'),/unique interrupted/);
  catalog.audit(LEGACY_USER_ID,null,null,'bounded-test',0,{large:'x'.repeat(20000)});const detail=String(db.sqlite.prepare("SELECT details_json FROM storage_audit WHERE action='bounded-test'").get()!.details_json);assert.ok(Buffer.byteLength(detail)<=8192);assert.equal(JSON.parse(detail).bounded,true);
 }finally{t.mock.timers.reset();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

for(const conservative of [true,false])test(`${conservative?'conservative':'normal'} background passes share one batch across old packages and new files, and yield to user restores`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-bounded-pass-')),db=new AppDatabase(path.join(root,'data'),undefined,false);
 try{
  const lifecycleRoot=path.join(root,'lifecycle');fs.mkdirSync(lifecycleRoot);
  const catalog=new StorageCatalog(db.sqlite),cid=crypto.randomUUID();db.createConversation(cid,'isolated background fixture');
  db.sqlite.prepare("UPDATE conversation_storage SET manifest_json='{}',verified_at=? WHERE conversation_id=?").run(new Date().toISOString(),cid);
  const source=path.join(root,'new-file');fs.writeFileSync(source,'not yet archived');
  catalog.enroll({userId:LEGACY_USER_ID,scope:'test',sourceKey:'new',kind:'file',locator:{root:'fixture',path:'new'},name:'new',trustedUsedAt:Date.now()-90*STORAGE_DAY});
  let imports=0,files=0;
  const host={db:db.sqlite,catalog,roots:{lifecycleRoot},policy:{graceMs:3*STORAGE_DAY},inventory:()=>({}),writeIndex:()=>{},importConversation:async()=>{imports++;},
   source:()=>source,files:{archive:async()=>{files++;}},legacyRoots:{}} as unknown as StorageHost;
  const result=await runStorageMaintenance(host,{conservative,maxItems:1});
  assert.equal(imports,1);assert.equal(files,0);assert.equal(result.operationsAttempted,1);assert.equal(result.releasedBytes,0);
  db.sqlite.prepare("INSERT INTO storage_restores(user_id,kind,subject_id,attempt_id,state,stage,started_at,updated_at) VALUES(?,'file','fixture','attempt','restoring','downloading',?,?)").run(LEGACY_USER_ID,Date.now(),Date.now());
  const busy=await runStorageMaintenance(host,{conservative,maxItems:1});
  assert.equal(busy.yieldedToUser,true);assert.equal(busy.operationsAttempted,0);assert.equal(imports,1);assert.equal(files,0);
  if(!conservative){
   db.sqlite.prepare('DELETE FROM storage_restores').run();
   const resumed=await runStorageMaintenance(host,{maxItems:1});
   assert.equal(resumed.operationsAttempted,1);assert.equal(resumed.filesIsolated,1);
   assert.equal(imports,1);assert.equal(files,1);assert.equal(resumed.blockedCount,0);
  }
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
