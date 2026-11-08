import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {AppDatabase,LEGACY_USER_ID} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import type {StorageHost} from '../server/storage-host.js';
import {disjointStorageRoots,largeStorageWriteBlocked,measureStorage} from '../server/storage-metrics.js';

test('physical metrics exclude absent isolation intents, avoid root overlap and backup material duplication, and expire stale watermarks',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-metric-')),dataRoot=path.join(root,'data'),db=new AppDatabase(dataRoot,undefined,false);
 try{
  const now=Date.now(),catalog=new StorageCatalog(db.sqlite,()=>now),lifecycle=path.join(root,'lifecycle'),tenantRoot=path.join(root,'tenants');fs.mkdirSync(lifecycle);
  const host={db:db.sqlite,catalog,roots:{dataRoot,tenantRoot,lifecycleRoot:lifecycle,hostUserId:LEGACY_USER_ID,hostRootCodexHome:path.join(root,'native')},
   legacyRoots:{isolationRoot:path.join(root,'legacy'),voiceIsolationRoot:path.join(root,'voice-old')},policy:{highBytes:32*1024**3,softBytes:24*1024**3,hotBytes:8*1024**3},source:()=>{throw new Error('not materialized');}} as unknown as StorageHost;
  const item=catalog.enroll({userId:LEGACY_USER_ID,scope:'backup-material',sourceKey:'db',kind:'recovery',locator:{root:'backup-material',path:'db'},name:'db'});
  const version=catalog.registerVersion(LEGACY_USER_ID,item.id,{sha256:'a'.repeat(64),bytes:99999,fingerprint:'old'});
  db.sqlite.prepare(`INSERT INTO storage_replicas(id,user_id,version_id,path,purpose,created_at,verified_at,allocated_bytes,state) VALUES('intent',?,?,?,'isolation',?,?,999999,'planned')`)
   .run(LEGACY_USER_ID,version.id,path.join(lifecycle,'isolated',LEGACY_USER_ID,'absent'),now,now);
  const materialized=path.join(lifecycle,'materialized',LEGACY_USER_ID,'events');fs.mkdirSync(materialized,{recursive:true});fs.writeFileSync(path.join(materialized,'old.jsonl'),Buffer.alloc(100000));
  assert.deepEqual(disjointStorageRoots([root,lifecycle,root,dataRoot]),[root]);
  const report=measureStorage(host,{stateRoot:root,sharedRoots:[dataRoot]}) as any,account=report.accounts.find((r:any)=>r.id===LEGACY_USER_ID);
  assert.equal(account.isolatedAllocatedBytes,0);assert.equal(account.currentLogicalBytes,0);assert.ok(account.localAllocatedBytes>=100000);assert.ok(report.shared.sharedAllocatedBytes>0);
  db.sqlite.prepare("UPDATE storage_scan_state SET value_json=?,updated_at=? WHERE name='watermark'").run(JSON.stringify({level:'high'}),now);
  assert.equal(largeStorageWriteBlocked(db.sqlite,[root],10*1024**2),true);
  db.sqlite.prepare("UPDATE storage_scan_state SET updated_at=? WHERE name='watermark'").run(now-31*60_000);
  const disk=fs.statfsSync(root);assert.equal(largeStorageWriteBlocked(db.sqlite,[root],10*1024**2),disk.bavail*disk.bsize-10*1024**2<disk.blocks*disk.bsize*.1);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
