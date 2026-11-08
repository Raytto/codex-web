import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import { AppDatabase, LEGACY_USER_ID } from '../server/db.js';
import { StorageCatalog } from '../server/storage-catalog.js';
import { enrollRegisteredFiles,enrollVoiceFiles,enrollTree,storageRoot,itemForFile } from '../server/storage-inventory.js';
import {StorageHost} from '../server/storage-host.js';

test('persisted dotfiles repair an unversioned legacy locator once without renewing its age',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-hidden-deliverable-')),dataRoot=path.join(root,'data'),db=new AppDatabase(dataRoot,undefined,false);
 try{
  const roots={dataRoot,tenantRoot:path.join(root,'tenants'),hostRootCodexHome:path.join(root,'host'),hostUserId:crypto.randomUUID()},cid=crypto.randomUUID(),id=crypto.randomUUID();
  db.createConversation(cid,'hidden fixture');const relative=`deliverables/${id}/.gitignore`,body='node_modules/\n',old=Date.parse('2026-01-01T00:00:00Z');
  fs.mkdirSync(path.join(dataRoot,'deliverables',id),{recursive:true});fs.writeFileSync(path.join(dataRoot,relative),body);
  db.addFile({id,conversation_id:cid,message_id:null,original_name:'.gitignore',relative_path:relative,mime_type:'text/plain',size:Buffer.byteLength(body),kind:'output',created_at:new Date(old).toISOString()});
  const catalog=new StorageCatalog(db.sqlite),item=catalog.enroll({userId:LEGACY_USER_ID,scope:'file',sourceKey:id,kind:'file',locator:{root:`conversation:${cid}`,path:relative},name:'.gitignore',trustedUsedAt:old});
  assert.deepEqual(enrollRegisteredFiles(catalog,roots,id),{items:1,issues:0});
  const repaired=catalog.item(LEGACY_USER_ID,item.id);assert.deepEqual(JSON.parse(repaired.locator_json),{root:`deliverable:${id}`,path:'.gitignore'});assert.equal(repaired.last_used_at,old);
  assert.deepEqual(enrollRegisteredFiles(catalog,roots,id),{items:1,issues:0});assert.equal(catalog.item(LEGACY_USER_ID,item.id).revision,repaired.revision);
  assert.throws(()=>storageRoot(catalog,roots,crypto.randomUUID(),`deliverable:${id}`),/owner/);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('paged production inventory tolerates observer writes between every file without retaining a WAL read cursor',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-inventory-wal-')),dataRoot=path.join(root,'data'),db=new AppDatabase(dataRoot,undefined,false);
  const peer=new DatabaseSync(path.join(dataRoot,'codex-web.sqlite'));
  try{
    peer.exec('PRAGMA busy_timeout=20');
    const cid=crypto.randomUUID(),old='2026-09-01T00:00:00Z';db.createConversation(cid,'isolated concurrent inventory');
    const roots={dataRoot,tenantRoot:path.join(root,'tenants'),hostRootCodexHome:path.join(root,'host'),hostUserId:crypto.randomUUID()};
    for(let i=0;i<300;i++)db.addFile({id:crypto.randomUUID(),conversation_id:cid,message_id:null,original_name:`fixture-${i}.bin`,relative_path:`uploads/fixture-${i}.bin`,mime_type:'application/octet-stream',size:1,kind:'upload',created_at:old});
    const catalog=new StorageCatalog(db.sqlite),enroll=catalog.enroll.bind(catalog);let writes=0;
    catalog.enroll=input=>{
      peer.prepare("INSERT INTO storage_scan_state VALUES('concurrent-observer','{}',?) ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at").run(++writes);
      return enroll(input);
    };
    const result=StorageHost.prototype.inventory.call({db:db.sqlite,catalog,roots} as unknown as StorageHost,true);
    assert.deepEqual(result.files,{items:300,issues:0});assert.equal(writes,300);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM storage_item_links WHERE kind='file'").get()!.n,300);
    assert.equal(db.sqlite.isTransaction,false);
    // Reconciliation and retry do not duplicate catalog records.
    assert.deepEqual(enrollRegisteredFiles(catalog,roots),{items:300,issues:0});
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM storage_items').get()!.n,300);
  }finally{peer.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('real application schema migration preserves legacy ages, aliases, unknown access T0 and tenant boundary',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-storage-inventory-')),db=new AppDatabase(path.join(root,'data'),undefined,false);
  try{
    let now=Date.parse('2026-11-07T00:00:00Z');const catalog=new StorageCatalog(db.sqlite,()=>now);
    const cid=crypto.randomUUID(),old='2026-09-01T00:00:00Z',roots={dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),hostRootCodexHome:path.join(root,'host'),hostUserId:crypto.randomUUID()};
    db.createConversation(cid,'storage test');db.sqlite.prepare('UPDATE conversations SET last_active_at=? WHERE id=?').run(old,cid);
    const workspace=path.join(roots.tenantRoot,LEGACY_USER_ID,'conversations',cid);fs.mkdirSync(path.join(workspace,'uploads'),{recursive:true});
    fs.writeFileSync(path.join(workspace,'uploads','one.bin'),Buffer.alloc(100_000));
    const ids=[crypto.randomUUID(),crypto.randomUUID()];
    for(const id of ids)db.addFiles([{id,conversation_id:cid,message_id:null,original_name:'one.bin',relative_path:'uploads/one.bin',mime_type:'application/octet-stream',size:100_000,kind:'upload',created_at:old}]);
    assert.deepEqual(enrollRegisteredFiles(catalog,roots),{items:2,issues:0});
    const a=itemForFile(catalog,LEGACY_USER_ID,ids[0])!,b=itemForFile(catalog,LEGACY_USER_ID,ids[1])!;
    assert.equal(a.id,b.id);assert.equal(a.last_used_at,Date.parse(old));assert.equal(catalog.due(a),true);
    db.touchConversationActivity(cid);enrollRegisteredFiles(catalog,roots);
    assert.equal(catalog.item(LEGACY_USER_ID,a.id).last_used_at,Date.parse(old));
    assert.throws(()=>storageRoot(catalog,roots,roots.hostUserId,`conversation:${cid}`),/owner/);
    const library=path.join(roots.tenantRoot,LEGACY_USER_ID,'library');fs.mkdirSync(library);fs.writeFileSync(path.join(library,'source.pdf'),Buffer.alloc(100_000));
    assert.equal(enrollTree(catalog,roots,{userId:LEGACY_USER_ID,root:'library',kind:'library'}).enrolled,1);
    const unknown=catalog.linked(LEGACY_USER_ID,'path','library/source.pdf')[0];assert.equal(unknown.time_basis,'migration-t0-unknown-access');
    now+=86400_000;enrollTree(catalog,roots,{userId:LEGACY_USER_ID,root:'library',kind:'library'});
    assert.equal(catalog.item(LEGACY_USER_ID,unknown.id).last_used_at,unknown.last_used_at);
    assert.equal(enrollVoiceFiles(catalog),0);
    const images=storageRoot(catalog,roots,LEGACY_USER_ID,'native-images');fs.mkdirSync(images,{recursive:true});fs.writeFileSync(path.join(images,'original.png'),Buffer.alloc(100_000));
    enrollTree(catalog,roots,{userId:LEGACY_USER_ID,root:'native-images',kind:'image'});
    const generated=catalog.linked(LEGACY_USER_ID,'path','native-images/original.png')[0];assert.equal(generated.retention_days,15);
    assert.equal(generated.last_used_at,now);now+=86400_000;enrollTree(catalog,roots,{userId:LEGACY_USER_ID,root:'native-images',kind:'image'});
    assert.equal(catalog.item(LEGACY_USER_ID,generated.id).last_used_at,now-86400_000);
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
