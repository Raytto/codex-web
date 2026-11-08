import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {AppDatabase,LEGACY_USER_ID} from '../server/db.js';
import {StorageCatalog} from '../server/storage-catalog.js';
import {StorageChunkStore} from '../server/storage-chunks.js';
import {storagePolicy,STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {StorageNativeLifecycle,nativeUnitSuccessor} from '../server/storage-native-lifecycle.js';
import {nativeHistoryDefinition,nativeHistoryDigests,snapshotNativeHistoryPage,removeNativeHistoryParts,restoreNativeHistoryPage} from '../server/storage-native-partitions.js';

test('installed native schema cleanup trigger preserves another thread and exact pages across removal and restore',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'pp-real-native-schema-')),db=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
 try{
  db.exec(fs.readFileSync(new URL('./fixtures/native-thread-history-0.167.0.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,?,?,?)').run(1,'fixture',1,Buffer.from([1,0,255]),10);
  const ids=[crypto.randomUUID(),crypto.randomUUID()];
  for(const id of ids){
   db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?,?)').run(id,4096,2);
   db.prepare('INSERT INTO thread_turns(thread_id,turn_id,rollout_ordinal,status) VALUES(?,?,?,?)').run(id,'turn',0,'completed');
   db.prepare('INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json) VALUES(?,?,?,?,?,?)').run(id,'turn','item',1,Date.now(),JSON.stringify({fixture:id}));
   db.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?,?)').run(id,'real',2,Date.now(),'realtime_session_started',JSON.stringify({fixture:id}));
  }
  const definition=nativeHistoryDefinition(home,{userId:'fixture',threadIds:[ids[0]],engineVersion:'0.167.0'})!,digests=nativeHistoryDigests(home,definition);
  const pages=definition.tables.map(table=>({file:path.join(home,table+'.jsonl'),page:snapshotNativeHistoryPage(home,definition,table,null,path.join(home,table+'.jsonl'))}));
  removeNativeHistoryParts(home,definition,digests);
  for(const table of definition.tables){assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE thread_id=?`).get(ids[0])!.n,0);assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE thread_id=?`).get(ids[1])!.n,1);}
  for(const entry of pages)await restoreNativeHistoryPage(home,definition,entry.page,entry.file);
  assert.deepEqual(nativeHistoryDigests(home,definition),digests);
  db.exec('DROP TRIGGER thread_realtime_items_projection_cleanup; CREATE TRIGGER thread_realtime_items_projection_cleanup AFTER DELETE ON thread_history_projection_state BEGIN DELETE FROM thread_realtime_items; END');
  assert.throws(()=>nativeHistoryDefinition(home,{userId:'fixture',threadIds:[ids[0]],engineVersion:'unknown'}),/schema_unsupported/);
  assert.equal(db.prepare('SELECT count(*) n FROM thread_items').get()!.n,2);
 }finally{db.close();fs.rmSync(home,{recursive:true,force:true});}
});

test('native units restore exact parent/child histories and indices, bounded pages, and keep each isolation generation',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-native-unit-')),dataRoot=path.join(root,'data'),tenantRoot=path.join(root,'tenants');
  const db=new AppDatabase(dataRoot,undefined,false),home=path.join(tenantRoot,LEGACY_USER_ID,'codex-home');fs.mkdirSync(path.join(home,'sessions'),{recursive:true});
  try{
    let now=Date.now();const old=new Date(now-100*STORAGE_DAY),cid=crypto.randomUUID(),parent=crypto.randomUUID(),child=crypto.randomUUID(),project=crypto.randomUUID();
    db.sqlite.prepare('INSERT INTO projects(id,user_id,name,root_path,executor_id,is_default,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?)').run(project,LEGACY_USER_ID,'test',root,'tenant-local',old.toISOString(),old.toISOString());
    db.createConversation(cid,'native');db.sqlite.prepare('UPDATE conversations SET project_id=?,codex_thread_id=?,last_active_at=? WHERE id=?').run(project,child,old.toISOString(),cid);
    const index=new DatabaseSync(path.join(home,'state_5.sqlite'));
    index.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,source TEXT,thread_section_id TEXT); CREATE TABLE thread_sections(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE guardian_review_feedback(id TEXT PRIMARY KEY,thread_id TEXT,record BLOB); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT PRIMARY KEY,status TEXT);');
    index.exec("INSERT INTO thread_sections VALUES('section','Original section')");
    index.prepare('INSERT INTO guardian_review_feedback VALUES(?,?,?)').run('feedback',parent,Buffer.from([0,255,11]));
    const history=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
    history.exec(`CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,checksum BLOB);INSERT INTO _sqlx_migrations VALUES(1,X'aa00ff');
      CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,payload TEXT,PRIMARY KEY(thread_id,item_id));
      CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER);
      CREATE TABLE thread_realtime_items(thread_id TEXT,item_id TEXT,payload BLOB,PRIMARY KEY(thread_id,item_id));`);
    const paths:string[]=[];
    for(const id of [parent,child]){
      const source=id===child?{subagent:{thread_spawn:{parent_thread_id:parent,depth:1,agent_path:'/root/child'}}}:'exec';
      const file=path.join(home,'sessions',`rollout-${id}.jsonl`);paths.push(file);
      fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,source}})+'\n');fs.utimesSync(file,old,old);
      index.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(id,file,typeof source==='string'?source:JSON.stringify(source),'section');
      history.prepare('INSERT INTO thread_turns VALUES(?,?)').run(id,'turn');
      for(let i=0;i<40;i++)history.prepare('INSERT INTO thread_items VALUES(?,?,?)').run(id,`${i}`.padStart(3,'0'),'history-'+i+'x'.repeat(8000));
      history.prepare('INSERT INTO thread_history_projection_state VALUES(?,?)').run(id,100);
      history.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?)').run(id,'r',Buffer.from([0,1,255]));
    }
    index.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)').run(parent,child,'open');index.close();history.close();
    const key=path.join(root,'key'),recipient=path.join(root,'recipient'),cloud=path.join(root,'cloud');fs.mkdirSync(cloud);
    execFileSync('age-keygen',['-o',key],{stdio:'ignore'});fs.writeFileSync(recipient,execFileSync('age-keygen',['-y',key]));
    const catalog=new StorageCatalog(db.sqlite,()=>now),policy={...storagePolicy({STORAGE_LIFECYCLE_ENABLED:'1',STORAGE_INSTANCE_ID:'test',STORAGE_REMOTE_ROOT:'/test',STORAGE_DRIVE_ID:'drive',STORAGE_AGE_RECIPIENT:recipient,STORAGE_AGE_IDENTITY:key}),chunkBytes:64*1024,scratchBytes:8*1024**2};
    const chunks=new StorageChunkStore(catalog,policy,path.join(root,'scratch'),{put:async(file,name)=>{fs.copyFileSync(file,path.join(cloud,path.basename(name)));},get:async(name,file)=>{fs.copyFileSync(path.join(cloud,path.basename(name)),file);}});
    const roots={dataRoot,tenantRoot,hostRootCodexHome:path.join(root,'host'),hostUserId:crypto.randomUUID(),lifecycleRoot:path.join(root,'lifecycle')};
    const native=new StorageNativeLifecycle(catalog,chunks,roots,path.join(root,'isolated'),()=>undefined);
    const id=await native.archive(cid,'test-engine');assert.ok(id);assert.ok(paths.every(p=>!fs.existsSync(p)));
    let unit=db.sqlite.prepare('SELECT * FROM storage_native_units WHERE id=?').get(id!) as any;
    const manifest=JSON.parse(unit.manifest_json);assert.ok(manifest.parts.length>10);assert.ok(manifest.parts.every((p:any)=>p.bytes<=64*1024));
    assert.equal(fs.readdirSync(chunks.scratch).length,0);
    native.purgeHistory(unit);assert.equal(db.sqlite.prepare('SELECT state FROM storage_native_units WHERE id=?').get(id!)!.state,'isolated');
    now+=3*STORAGE_DAY;native.purgeHistory(unit);
    let check=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));assert.equal(check.prepare('SELECT count(*) n FROM thread_items').get()!.n,0);check.close();
    for(const replica of catalog.isolationDue())native.files.purge(replica);
    assert.equal(await native.restore(LEGACY_USER_ID,cid),true);assert.ok(paths.every(p=>fs.existsSync(p)));
    check=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
    assert.equal(check.prepare('SELECT count(*) n FROM thread_items').get()!.n,80);
    assert.equal(check.prepare('SELECT hex(payload) p FROM thread_realtime_items LIMIT 1').get()!.p,'0001FF');check.close();
    check=new DatabaseSync(path.join(home,'state_5.sqlite'));assert.equal(check.prepare('SELECT child_thread_id FROM thread_spawn_edges').get()!.child_thread_id,child);assert.equal(check.prepare('SELECT hex(record) r FROM guardian_review_feedback').get()!.r,'00FF0B');check.close();
    assert.equal(await native.restore(LEGACY_USER_ID,cid),false);
    assert.equal(nativeUnitSuccessor(catalog,LEGACY_USER_ID,id!),null);
    // Pressure eviction may retire an unchanged restored copy early, but its
    // next generation still gets a complete three-day quarantine.
    now+=16*60_000;
    const pressure=await native.archive(cid,'test-engine',child,undefined,undefined,{cachePressure:true});assert.ok(pressure);
    assert.equal(nativeUnitSuccessor(catalog,LEGACY_USER_ID,id!),pressure);
    assert.equal(nativeUnitSuccessor(catalog,crypto.randomUUID(),id!),null);
    unit=db.sqlite.prepare('SELECT * FROM storage_native_units WHERE id=?').get(pressure!) as any;
    assert.equal(JSON.parse(unit.manifest_json).cachePressure,true);native.purgeHistory(unit);
    assert.equal(db.sqlite.prepare('SELECT state FROM storage_native_units WHERE id=?').get(pressure!)!.state,'isolated');
    assert.equal(await native.restore(LEGACY_USER_ID,cid,child,id!),false); // exact old unit cannot select the newer one
    assert.equal(await native.restore(LEGACY_USER_ID,cid,child,pressure!),true);
    now+=16*60_000;check=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
    check.prepare('UPDATE thread_items SET payload=? WHERE thread_id=? AND item_id=?').run('new unique work',parent,'000');check.close();
    await assert.rejects(native.archive(cid,'test-engine',child,undefined,undefined,{cachePressure:true}),/storage_native_cache_changed/);
    assert.ok(paths.every(p=>fs.existsSync(p)));
    // Remove the sole business reference: the original native family still
    // belongs to this account and must remain recoverable without a fake chat.
    db.sqlite.prepare('UPDATE conversations SET codex_thread_id=NULL WHERE id=?').run(cid);now+=100*STORAGE_DAY;
    const orphan=`orphan:${LEGACY_USER_ID}:${parent}`,beforeConversations=db.sqlite.prepare('SELECT count(*) n FROM conversations').get()!.n;
    const orphanId=await native.archive(orphan,'test-engine',parent,{userId:LEGACY_USER_ID,executor:'tenant-local'});assert.ok(orphanId);
    assert.equal(db.sqlite.prepare('SELECT count(*) n FROM conversations').get()!.n,beforeConversations);
    now+=3*STORAGE_DAY;unit=db.sqlite.prepare('SELECT * FROM storage_native_units WHERE id=?').get(orphanId!) as any;native.purgeHistory(unit);
    for(const replica of catalog.isolationDue())native.files.purge(replica);
    assert.equal(await native.restore(LEGACY_USER_ID,orphan,parent),true);assert.ok(paths.every(p=>fs.existsSync(p)));
    assert.equal(await native.restore(crypto.randomUUID(),orphan,parent),false);
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('a failed or altered native page rolls back that page; retries and newer engine schemas are safe',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pp-native-pages-')),thread=crypto.randomUUID(),file=path.join(home,'page');
  const db=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
  try{
    db.exec("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY);INSERT INTO _sqlx_migrations VALUES(1);CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,payload TEXT,PRIMARY KEY(thread_id,item_id));");
    for(let i=0;i<3;i++)db.prepare('INSERT INTO thread_items VALUES(?,?,?)').run(thread,String(i),'x'.repeat(1000));
    const m=nativeHistoryDefinition(home,{userId:'owner',threadIds:[thread],engineVersion:'test'})!;
    const digest=nativeHistoryDigests(home,m),page=snapshotNativeHistoryPage(home,m,'thread_items',null,file,8192),body=fs.readFileSync(file);
    removeNativeHistoryParts(home,m,digest);fs.writeFileSync(file,body.toString().replace('xxx','yyy'));
    await assert.rejects(restoreNativeHistoryPage(home,m,page,file),/checksum/);assert.equal(db.prepare('SELECT count(*) n FROM thread_items').get()!.n,0);
    fs.writeFileSync(file,body);await restoreNativeHistoryPage(home,m,page,file);await restoreNativeHistoryPage(home,m,page,file);
    assert.deepEqual(nativeHistoryDigests(home,m),digest);
    db.exec('ALTER TABLE thread_items ADD COLUMN future TEXT');
    assert.throws(()=>removeNativeHistoryParts(home,m,digest),/incompatible/);assert.equal(db.prepare('SELECT count(*) n FROM thread_items').get()!.n,3);
  }finally{db.close();fs.rmSync(home,{recursive:true,force:true});}
});
