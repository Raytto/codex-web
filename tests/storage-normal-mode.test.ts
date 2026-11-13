import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {AppDatabase,LEGACY_USER_ID} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import {STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {runStorageMaintenance} from '../server/storage-maintenance.js';
import {verifyPortableLegacy} from '../server/storage-recovery-proof.js';
import type {LegacyGeneration} from '../server/storage-legacy-isolation.js';
import type {StorageHost} from '../server/storage-host.js';

const hash=(v:string)=>crypto.createHash('sha256').update(v).digest('hex');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'normal-storage-')),db=new AppDatabase(path.join(root,'data'),undefined,false),catalog=new StorageCatalog(db.sqlite);
 const lifecycleRoot=path.join(root,'lifecycle'),isolationRoot=path.join(root,'legacy');fs.mkdirSync(lifecycleRoot);
 const rows:LegacyGeneration[]=[];
 for(let i=0;i<2;i++){
  const cid=crypto.randomUUID();db.createConversation(cid,'isolated maintenance fixture');
  const isolated=path.join(isolationRoot,cid,'1'),body='unique preserved fixture '+i;
  fs.mkdirSync(path.join(isolated,'file'),{recursive:true});fs.writeFileSync(path.join(isolated,'file','plan'),body);
  const manifest=JSON.stringify({entries:[{kind:'file',relativePath:'plan',size:Buffer.byteLength(body),sha256:hash(body)}]});
  const row:LegacyGeneration={kind:'conversation',subject_id:cid,generation:1,user_id:LEGACY_USER_ID,manifest_json:manifest,manifest_sha256:hash(manifest),
   remote_drive:'fixture',remote_path:'/fixture/legacy/generation-1-'+hash('cipher'+i)+'.age',archive_sha256:hash('cipher'+i),archive_bytes:120,
   verified_at:Date.now()-4*STORAGE_DAY,isolated_path:isolated,isolated_at:Date.now()-4*STORAGE_DAY,purge_started_at:null,released_at:null,blocked_reason:null};
  rows.push(row);db.sqlite.prepare(`INSERT INTO storage_legacy_generations(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 }
 const directory=path.join(lifecycleRoot,'portable-catalog');fs.mkdirSync(directory);
 const publish=(mutate?:(v:{legacy:LegacyGeneration[]})=>void)=>{
  const snapshot={format:'pp-portable-catalog-v1',completeSiteBackup:false,versions:[],nativeUnits:[],legacy:structuredClone(rows)};mutate?.(snapshot);
  const body=JSON.stringify(snapshot),sha=hash(body),remote='/fixture/recovery/receipt.json';
  fs.writeFileSync(path.join(directory,'current.json'),body,{mode:0o600});
  fs.writeFileSync(path.join(directory,'state.json'),JSON.stringify({catalogSha256:sha,latestDescriptor:remote,lastPublishedAt:new Date().toISOString(),
   descriptorProof:{remote,bytes:500,fileId:'descriptor',catalogSha256:sha}}),{mode:0o600});
 };
 publish();let checks=0,reads=0;
 const host={db:db.sqlite,catalog,roots:{lifecycleRoot},policy:{graceMs:3*STORAGE_DAY,remoteRoot:'/fixture'},inventory:()=>({}),
  legacyRoots:{isolationRoot},reader:{assertPresent:async()=>{checks++;},stream:async()=>{reads++;throw new Error('successful business bytes must not be read');}}} as unknown as StorageHost;
 db.sqlite.prepare("INSERT INTO storage_scan_state VALUES('maintenance-phase',?,?)").run(JSON.stringify({next:'legacy-purge'}),Date.now());
 return {root,db,catalog,host,rows,publish,counts:()=>({checks,reads}),close(){db.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('normal pass reclaims one real eligible copy using its portable object proof without whole-site backup or repeated download',async()=>{
 const f=fixture();try{
  const result=await runStorageMaintenance(f.host,{maxItems:1});
  assert.equal(result.conservative,false);assert.equal(result.operationsAttempted,1);assert.ok(result.releasedBytes>0);
  assert.equal(f.rows.filter(r=>fs.existsSync(r.isolated_path!)).length,1);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM storage_backup_points').get()!.n,0);
  assert.deepEqual(f.counts(),{checks:2,reads:0});
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM storage_legacy_generations WHERE released_at IS NOT NULL').get()!.n,1);
 }finally{f.close();}
});

test('normal mode yields before any work and rechecks a foreground restore after cloud metadata returns',async()=>{
 const f=fixture();try{
  const busy=()=>f.db.sqlite.prepare("INSERT OR REPLACE INTO storage_restores(user_id,kind,subject_id,attempt_id,state,stage,started_at,updated_at) VALUES(?,'file','fixture','test','restoring','downloading',?,?)").run(LEGACY_USER_ID,Date.now(),Date.now());
  busy();const first=await runStorageMaintenance(f.host,{maxItems:1});assert.equal(first.yieldedToUser,true);assert.equal(first.operationsAttempted,0);
  f.db.sqlite.prepare('DELETE FROM storage_restores').run();
  f.host.reader.assertPresent=async()=>{busy();};
  const raced=await runStorageMaintenance(f.host,{maxItems:1});assert.equal(raced.yieldedToUser,true);assert.equal(raced.releasedBytes,0);
  assert.ok(f.rows.every(r=>fs.existsSync(r.isolated_path!)));
 }finally{f.close();}
});

test('normal cleanup rejects a different account in the published catalogue and keeps the original grace start',async()=>{
 const f=fixture();try{
  f.publish(s=>{s.legacy[0].user_id='another-account';});
  await assert.rejects(verifyPortableLegacy(f.host,f.rows[0]),/recovery_manifest_pending/);
  const result=await runStorageMaintenance(f.host,{maxItems:1});assert.equal(result.releasedBytes,0);assert.equal(result.operationsAttempted,1);
  assert.ok(f.rows.every(r=>fs.existsSync(r.isolated_path!)));
  assert.equal(f.db.sqlite.prepare('SELECT isolated_at FROM storage_legacy_generations WHERE subject_id=?').get(f.rows[0].subject_id)!.isolated_at,f.rows[0].isolated_at);
 }finally{f.close();}
});

test('normal pass cannot reclaim before three real days even with a valid recovery catalogue',async()=>{
 const f=fixture();try{
  f.db.sqlite.prepare('UPDATE storage_legacy_generations SET isolated_at=?').run(Date.now()-2*STORAGE_DAY);
  // Other phases have no object candidates in this isolated host.
  f.host.roots.tenantRoot=path.join(f.root,'tenants');f.host.roots.hostRootCodexHome=path.join(f.root,'host');
  f.host.roots.hostUserId=crypto.randomUUID();
  const result=await runStorageMaintenance(f.host,{maxItems:1});assert.equal(result.releasedBytes,0);assert.equal(f.counts().reads,0);
  assert.ok(f.rows.every(r=>fs.existsSync(r.isolated_path!)));
 }finally{f.close();}
});

test('changed isolated bytes stay protected while a failed generation does not starve the next one',async()=>{
 const f=fixture();try{
  const first=f.rows[0];fs.appendFileSync(path.join(first.isolated_path!,'file','plan'),' changed');
  const failed=await runStorageMaintenance(f.host,{maxItems:1});
  assert.equal(failed.releasedBytes,0);assert.match(failed.blocked[0].reason,/member_changed/);
  f.db.sqlite.prepare("UPDATE storage_scan_state SET value_json=? WHERE name='maintenance-phase'").run(JSON.stringify({next:'legacy-purge'}));
  const next=await runStorageMaintenance(f.host,{maxItems:1});
  assert.ok(next.releasedBytes>0);assert.equal(next.operationsAttempted,1);
  assert.ok(fs.existsSync(first.isolated_path!));assert.equal(fs.existsSync(f.rows[1].isolated_path!),false);
 }finally{f.close();}
});

test('a later pass on the same host rechecks the current recovery proof',async()=>{
 const f=fixture();try{
  const first=await runStorageMaintenance(f.host,{maxItems:1});assert.ok(first.releasedBytes>0);
  fs.writeFileSync(path.join(f.host.roots.lifecycleRoot!,'portable-catalog','current.json'),'{}');
  f.db.sqlite.prepare("UPDATE storage_scan_state SET value_json=? WHERE name='maintenance-phase'").run(JSON.stringify({next:'legacy-purge'}));
  const later=await runStorageMaintenance(f.host,{maxItems:1});
  assert.equal(later.releasedBytes,0);assert.match(later.blocked[0].reason,/catalog_proof_pending/);
  assert.equal(f.rows.filter(r=>fs.existsSync(r.isolated_path!)).length,1);
 }finally{f.close();}
});
