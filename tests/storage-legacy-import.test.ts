import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {AppDatabase,LEGACY_USER_ID} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import {StorageChunkStore,sha256Path} from '../server/storage-chunks.js';
import {StorageFileLifecycle} from '../server/storage-file-lifecycle.js';
import {storagePolicy} from '../server/storage-lifecycle-policy.js';
import {enrollRegisteredFiles,itemForFile,storageRoot} from '../server/storage-inventory.js';
import {defaultColdStorageRoots} from '../server/conversation-cold-storage.js';
import {importLegacyConversation} from '../server/storage-legacy-import.js';

test('legacy conversion is one streaming pass; reopening one small planning file downloads only that file object',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-legacy-import-')),db=new AppDatabase(path.join(root,'data'),undefined,false);
  try{
    const cid=crypto.randomUUID(),tid=crypto.randomUUID(),old='2026-08-01T00:00:00Z',owner=LEGACY_USER_ID;
    db.createConversation(cid,'legacy');db.sqlite.prepare('UPDATE conversations SET last_active_at=?,codex_thread_id=? WHERE id=?').run(old,tid,cid);
    const roots={dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),hostRootCodexHome:path.join(root,'host'),hostUserId:crypto.randomUUID()};
    const workspace=path.join(roots.tenantRoot,owner,'conversations',cid),stage=path.join(root,'stage'),cloud=path.join(root,'cloud');
    fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(stage);fs.mkdirSync(cloud);
    const smallId=crypto.randomUUID(),largeId=crypto.randomUUID();
    const files=[{id:smallId,relative:'outputs/plan.txt',body:Buffer.from('Keep this small plan independently recoverable.')},
      {id:largeId,relative:'outputs/large.bin',body:crypto.randomBytes(3*1024**2+100)}];
    const entries=files.map(f=>{
      const target=path.join(stage,'file',f.relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,f.body);
      db.addFiles([{id:f.id,conversation_id:cid,message_id:null,original_name:path.basename(f.relative),relative_path:f.relative,mime_type:'application/octet-stream',size:f.body.length,kind:'output',created_at:old}]);
      return {root:'conversation' as const,kind:'file' as const,relativePath:f.relative,size:f.body.length,sha256:sha256Path(target),mode:0o600,uid:process.getuid!(),gid:process.getgid!()};
    });
    const manifest=JSON.stringify({format:'conversation-cold-storage-v3',conversationId:cid,userId:owner,threadId:tid,generation:1,createdAt:old,plaintextBytes:entries.reduce((n,e)=>n+e.size,0),entries});
    const hash=crypto.createHash('sha256').update(manifest).digest('hex');fs.writeFileSync(path.join(stage,'manifest.json'),manifest);
    const key=path.join(root,'key'),recipient=path.join(root,'recipient'),plain=path.join(root,'legacy.tar'),encrypted=path.join(root,'legacy.age');
    execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));
    execFileSync('tar',['-cf',plain,'-C',stage,'.']);execFileSync('age',['-R',recipient,'-o',encrypted,plain]);
    db.sqlite.prepare(`UPDATE conversation_storage SET state='cold',generation=1,manifest_json=?,manifest_sha256=?,archive_sha256=?,archive_bytes=?,remote_path='/legacy/package.age',remote_drive_id='drive',verified_at=? WHERE conversation_id=?`)
      .run(manifest,hash,sha256Path(encrypted),fs.statSync(encrypted).size,old,cid);
    const catalog=new StorageCatalog(db.sqlite),policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'drive',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:key}),chunkBytes:1024**2,scratchBytes:16*1024**2};
    let downloads=0,downloadBytes=0,legacyReads=0;
    const chunks=new StorageChunkStore(catalog,policy,path.join(root,'scratch'),{
      put:async(file,remote)=>{const destination=path.join(cloud,path.basename(remote));if(!fs.existsSync(destination))fs.copyFileSync(file,destination);},
      get:async(remote,file)=>{const source=path.join(cloud,path.basename(remote));downloads++;downloadBytes+=fs.statSync(source).size;fs.copyFileSync(source,file);},
    });
    enrollRegisteredFiles(catalog,roots);
    const input={catalog,chunks,roots,conversationId:cid,legacyRoots:defaultColdStorageRoots({...roots,databasePath:path.join(roots.dataRoot,'codex-web.sqlite'),isolationRoot:path.join(root,'legacy-isolation')}),
      read:async()=>{legacyReads++;return fs.createReadStream(encrypted);}};
    assert.equal((await importLegacyConversation(input)).members,2);assert.equal(legacyReads,1);
    assert.equal((await importLegacyConversation(input)).alreadyImported,true);assert.equal(legacyReads,1);
    const item=itemForFile(catalog,owner,smallId)!;assert.equal(catalog.version(owner,item.current_version!).state,'cold');
    const before={downloads,downloadBytes};
    const lifecycle=new StorageFileLifecycle(catalog,chunks,path.join(root,'isolation'),(u,r)=>storageRoot(catalog,roots,u,r),()=>undefined);
    const restored=await lifecycle.restore(owner,item.id,'user-read');assert.deepEqual(fs.readFileSync(restored),files[0].body);
    assert.equal(downloads-before.downloads,1);assert.ok(downloadBytes-before.downloadBytes<1024);assert.equal(legacyReads,1);
    assert.equal(fs.existsSync(path.join(workspace,files[1].relative)),false);
    assert.equal(fs.readdirSync(chunks.scratch).length,0);
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
