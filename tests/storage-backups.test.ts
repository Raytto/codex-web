import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {AppDatabase} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import {StorageChunkStore} from '../server/storage-chunks.js';
import {storagePolicy,STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {StorageBackups,retainedBackupIds,readBackupManifest,restoreBackupMaterial} from '../server/storage-backups.js';
import {migrateStorageLifecycle} from '../server/storage-lifecycle-schema.js';
import {recoverStorageSite} from '../server/storage-recovery.js';

test('independent cloud recovery requires neither the original application database, original files nor original key file',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-backup-independent-')),db=new AppDatabase(path.join(root,'data'),undefined,false);
 let open=true;
 try{
  const cloud=path.join(root,'cloud'),key=path.join(root,'identity'),recipient=path.join(root,'recipient'),recoveredKey=path.join(root,'recovered-identity');fs.mkdirSync(cloud);
  execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));fs.copyFileSync(key,recoveredKey);
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'independently restorable planning file\n');
  const libraryFile=path.join(root,'library.sqlite'),library=new DatabaseSync(libraryFile);
  library.exec("CREATE VIRTUAL TABLE plans USING fts5(body);INSERT INTO plans VALUES('recover searchable original planning text')");library.close();
  const catalog=new StorageCatalog(db.sqlite),policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'drive',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:key}),chunkBytes:1024*1024,scratchBytes:16*1024**2};
  let uploads=0;
  const transport={put:async(file:string,remote:string)=>{const target=path.join(cloud,path.basename(remote));if(!fs.existsSync(target)){uploads++;fs.copyFileSync(file,target);}},get:async(remote:string,file:string)=>{fs.copyFileSync(path.join(cloud,path.basename(remote)),file);}};
  const store=new StorageChunkStore(catalog,policy,path.join(root,'scratch'),transport),backups=new StorageBackups(catalog,store,{instanceId:'test',codeSha:'a'.repeat(40),keyRecovery:{mode:'external',reference:'isolated-test-key-custodian'}});
  await assert.rejects(()=>backups.captureFile('not-a-point','key.agekey',key),/storage_identity_requires_external_custody/);
  assert.equal(uploads,0);
  const cid=crypto.randomUUID();db.createConversation(cid,'restore-preserved-id');
  const preserved=catalog.enroll({userId:'__shared__',scope:'test-recovery',sourceKey:'old-isolation',kind:'recovery',locator:{root:'fixture',path:'old'},name:'old'});
  const preservedVersion=catalog.registerVersion('__shared__',preserved.id,{sha256:'b'.repeat(64),bytes:100,fingerprint:'fixture'});
  db.sqlite.prepare(`INSERT INTO storage_replicas(id,user_id,version_id,path,purpose,created_at,verified_at,allocated_bytes,state) VALUES(?,?,?,?,'isolation',?,?,4096,'present')`)
   .run(crypto.randomUUID(),'__shared__',preservedVersion.id,path.join(root,'lost-host-isolation'),Date.now(),Date.now());
  const point=await backups.create(async id=>[await backups.captureFile(id,'files/plan.txt',source),await backups.captureDatabase(id,'files/library.sqlite',libraryFile),await backups.captureDatabase(id,'database/main.sqlite',path.join(root,'data','codex-web.sqlite'))]);
  assert.equal(point.state,'verified');assert.equal(point.kind,'weekly-recovery-manifest');const count=uploads;
  assert.equal((await backups.create(async()=>{throw new Error('must not recreate same recovery point');})).id,point.id);assert.equal(uploads,count);
  const descriptor=JSON.parse(fs.readFileSync(path.join(cloud,path.basename(point.remote_path!)),'utf8'));
  db.close();open=false;fs.rmSync(path.join(root,'data'),{recursive:true});fs.unlinkSync(source);fs.unlinkSync(libraryFile);fs.unlinkSync(key);
  const empty=new DatabaseSync(':memory:');migrateStorageLifecycle(empty);
  try{
   const independent=new StorageChunkStore(new StorageCatalog(empty),{...policy,identity:recoveredKey},path.join(root,'independent-scratch'),transport);
   const manifest=await readBackupManifest(independent,descriptor);assert.equal(manifest.materials.length,3);
   assert.equal(manifest.materials.find(m=>m.target==='files/library.sqlite')!.format,'sqlite-binary');
   for(const material of manifest.materials)await restoreBackupMaterial(independent,material,path.join(root,'restored',material.target));
   assert.equal(fs.readFileSync(path.join(root,'restored','files','plan.txt'),'utf8'),'independently restorable planning file\n');
   const restored=new DatabaseSync(path.join(root,'restored','database','main.sqlite'));
   try{assert.equal(restored.prepare('PRAGMA quick_check').get()!.quick_check,'ok');assert.equal(restored.prepare('SELECT title FROM conversations WHERE id=?').get(cid)!.title,'restore-preserved-id');}
   finally{restored.close();}
   let interrupted=false;const destination=path.join(root,'site-restore');
   await assert.rejects(recoverStorageSite({chunks:independent,descriptor,destination,onProgress:()=>{if(!interrupted){interrupted=true;throw new Error('test_process_boundary');}}}),/test_process_boundary/);
   assert.equal(JSON.parse(fs.readFileSync(path.join(destination,'.pp-recovery-state.json'),'utf8')).complete,false);
   const receipt=await recoverStorageSite({chunks:independent,descriptor,destination});assert.equal(receipt.complete,true);
   const recoveredLibrary=new DatabaseSync(path.join(destination,'files/library.sqlite'),{readOnly:true});
   try{assert.equal(recoveredLibrary.prepare("SELECT body FROM plans WHERE plans MATCH 'searchable'").get()!.body,'recover searchable original planning text');}
   finally{recoveredLibrary.close();}
   const full=new DatabaseSync(path.join(destination,'database/main.sqlite'),{readOnly:true});
   try{
    assert.equal(full.prepare("SELECT state FROM storage_replicas WHERE version_id=?").get(preservedVersion.id)!.state,'unavailable');
    assert.equal(full.prepare('SELECT title FROM conversations WHERE id=?').get(cid)!.title,'restore-preserved-id');
    assert.equal(full.prepare('SELECT state FROM storage_backup_points WHERE id=?').get(point.id)!.state,'verified');
    assert.ok(Number(full.prepare("SELECT count(*) n FROM storage_references WHERE kind='backup' AND ref_id=?").get(point.id)!.n)>=3);
   }finally{full.close();}
   assert.equal((await recoverStorageSite({chunks:independent,descriptor,destination})).complete,true);
   fs.writeFileSync(path.join(destination,'files/plan.txt'),'changed after restore');
   await assert.rejects(recoverStorageSite({chunks:independent,descriptor,destination}),/storage_recovery_destination_changed/);
  }finally{empty.close();}
 }finally{if(open)db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('recovery retention keeps 4/7/8/12 overlapping periods once and keeps the last tested point through outages',()=>{
 const now=Date.UTC(2026,10,7,18),points=[];
 for(let n=0;n<400*4;n++){const at=now-n*6*3600_000;points.push({id:String(n),created_at:at,verified_at:at+1,restore_tested_at:n===1599?at+2:null});}
 const keep=retainedBackupIds(points,now);assert.ok(keep.has('0'));assert.ok(keep.has('1'));assert.ok(keep.has('2'));assert.ok(keep.has('3'));assert.ok(keep.has('1599'));
 assert.ok(keep.size<=32);assert.ok(!keep.has('1580'));
 assert.equal(retainedBackupIds([points[1599]],now).has('1599'),true);
});
