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
import {createStorageBackup,type BackupPlan} from '../server/storage-backup-plan.js';
import {readBackupManifest} from '../server/storage-backups.js';
import {storagePolicy} from '../server/storage-lifecycle-policy.js';
import {storageRoot} from '../server/storage-inventory.js';
import {safeStorageMember} from '../server/storage-file-lifecycle.js';
import type {StorageHost} from '../server/storage-host.js';

test('the backup inventory is frozen, changed originals prevent publication, and identical retries safely reuse chunks',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-backup-plan-')),dataRoot=path.join(root,'data'),db=new AppDatabase(dataRoot,undefined,false);
 try{
  const cid=crypto.randomUUID(),fid=crypto.randomUUID(),owner=LEGACY_USER_ID,tenantRoot=path.join(root,'tenants'),workspace=path.join(tenantRoot,owner,'conversations',cid),key=path.join(root,'key'),recipient=path.join(root,'recipient');
  fs.mkdirSync(workspace,{recursive:true});const file=path.join(workspace,'plan.txt');fs.writeFileSync(file,'initial plan');
  execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));
  db.createConversation(cid,'backup fixture');db.addFile({id:fid,conversation_id:cid,message_id:null,original_name:'plan.txt',relative_path:'plan.txt',mime_type:'text/plain',size:12,kind:'output',created_at:new Date().toISOString()});
  const catalog=new StorageCatalog(db.sqlite),roots={dataRoot,tenantRoot,hostRootCodexHome:path.join(root,'host'),hostUserId:crypto.randomUUID(),lifecycleRoot:path.join(root,'lifecycle')};
  const policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'drive',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:key}),chunkBytes:1024**2,scratchBytes:16*1024**2};
  const cloud=new Map<string,Buffer>();let mutate=true;
  const chunks=new StorageChunkStore(catalog,policy,path.join(root,'scratch'),{put:async(source,remote)=>{cloud.set(remote,fs.readFileSync(source));if(mutate){mutate=false;fs.writeFileSync(file,'concurrent edit');}},get:async(remote,target)=>{fs.writeFileSync(target,cloud.get(remote)!);}});
  const host={catalog,chunks,roots,policy,db:db.sqlite,legacyRoots:{databasePath:path.join(dataRoot,'codex-web.sqlite')},
   source:(item:{user_id:string;locator_json:string})=>{const loc=JSON.parse(item.locator_json);return safeStorageMember(storageRoot(catalog,roots,item.user_id,loc.root),loc.path);},
   reader:{assertPresent:async(remote:string,bytes:number)=>{assert.equal(cloud.get(remote)?.length,bytes);}}} as unknown as StorageHost;
  const plan:BackupPlan={format:'pp-storage-backup-plan-v1',codeSha:'a'.repeat(40),keyRecovery:{mode:'external',reference:'test custodian'},localRecoveryRoot:path.join(root,'recovery'),extraSources:[],excludeData:[],excludeTenant:[],excludeNative:[]};
  const oldId=crypto.randomUUID(),missingId=crypto.randomUUID(),legacyText='verified old plan';
  for(const [id,name,bytes] of [[oldId,'old.txt',Buffer.byteLength(legacyText)],[missingId,'missing.txt',123]] as const)
    db.addFile({id,conversation_id:cid,message_id:null,original_name:name,relative_path:name,mime_type:'text/plain',size:bytes,kind:'output',created_at:'2026-01-01T00:00:00Z'});
  const legacy=JSON.stringify({format:'conversation-cold-storage-v3',conversationId:cid,userId:owner,generation:1,entries:[{root:'conversation',kind:'file',relativePath:'old.txt',size:Buffer.byteLength(legacyText),sha256:crypto.createHash('sha256').update(legacyText).digest('hex')}]});
  db.sqlite.prepare("UPDATE conversation_storage SET generation=1,manifest_json=?,manifest_sha256=?,archive_sha256=?,archive_bytes=1234,remote_path='/legacy/package.age',remote_drive_id='drive',verified_at=? WHERE conversation_id=?")
    .run(legacy,crypto.createHash('sha256').update(legacy).digest('hex'),'b'.repeat(64),'2026-01-01T00:00:00Z',cid);
  // Verified old objects can remain cloud references. An unproven absence
  // cannot make a complete point; wrong owner/path/size evidence cannot either.
  await assert.rejects(createStorageBackup(host,plan),/storage_backup_registered_original_uncovered/);
  const missing={fileId:missingId,userId:owner,relativePath:'missing.txt',bytes:123,reason:'pre-existing-unavailable' as const,evidenceSha256:'c'.repeat(64)};
  plan.knownMissingOriginals=[{...missing,userId:crypto.randomUUID()}];
  await assert.rejects(createStorageBackup(host,plan),/storage_backup_registered_original_uncovered/);
  plan.knownMissingOriginals=[missing];
  fs.writeFileSync(path.join(workspace,'old.txt'),'new live version');
  plan.excludeTenant.push(`conversations/${cid}/old.txt`);
  await assert.rejects(createStorageBackup(host,plan),/storage_backup_registered_original_uncovered/);
  fs.unlinkSync(path.join(workspace,'old.txt'));
  await assert.rejects(createStorageBackup(host,plan),/storage_backup_source_changed_retry/);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM storage_backup_points WHERE state='verified'").get()!.n,0);
  const point=await createStorageBackup(host,plan);assert.equal(point.state,'verified');
  const manifest=await readBackupManifest(chunks,JSON.parse(point.manifest_json));
  const original=manifest.materials.find(m=>m.target.endsWith('/plan.txt'))!;assert.equal(original.sha256,crypto.createHash('sha256').update('concurrent edit').digest('hex'));
  assert.ok(manifest.materials.some(m=>m.target==='database/main.sqlite'));const uploads=cloud.size;
  assert.equal(manifest.legacy.length,1);assert.equal(manifest.legacy[0].remote_path,'/legacy/package.age');
  assert.equal(manifest.materials.some(m=>m.target.endsWith('/old.txt')),false);
  assert.deepEqual(manifest.unavailableOriginals,[missing]);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM storage_backup_legacy_refs WHERE point_id=?').get(point.id)!.n,1);
  assert.equal((await createStorageBackup(host,plan)).id,point.id);assert.equal(cloud.size,uploads);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
