import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';

test('real kernel file reads advance only the addressed task object; maintenance and unrelated jobs do not heat it',async t=>{
  const capability=/^CapEff:\s*([0-9a-f]+)/m.exec(fs.readFileSync('/proc/self/status','utf8'))?.[1];
  if(!capability || !(BigInt('0x'+capability)&(1n<<21n))){t.skip('Real fanotify acceptance requires the host CAP_SYS_ADMIN; isolated image builds do not have it.');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-access-test-')),file=path.join(root,'source'),markers=path.join(root,'markers');fs.writeFileSync(file,'actual content');
  const item=crypto.randomUUID(),job=crypto.randomUUID(),owner=crypto.randomUUID();
  const child=spawn('python3',['-u',path.join(process.cwd(),'deploy/storage-access-monitor.py'),markers],{stdio:['pipe','pipe','pipe']});
  const lines=readline.createInterface({input:child.stdout});let error='';child.stderr.on('data',data=>error+=String(data));
  try{
    const ready=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('monitor_start_timeout:'+error)),5000);
      lines.on('line',line=>{if(JSON.parse(line).event==='ready'){clearTimeout(timer);resolve();}});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('monitor_exited:'+error));});
    });
    child.stdin.write(JSON.stringify({files:[{id:item,userId:owner,path:file}],jobs:{[job]:owner}})+'\n');await ready;
    const read=(env:NodeJS.ProcessEnv)=>new Promise<void>((resolve,reject)=>{
      const reader=spawn(process.execPath,['-e','require("node:fs").readFileSync(process.argv[1])',file],{env:{...process.env,...env},stdio:'ignore'});
      reader.once('exit',code=>code===0?resolve():reject(new Error('reader_failed')));
    });
    await read({CODEX_WEB_AUTOMATION_JOB_ID:crypto.randomUUID()});assert.equal(fs.existsSync(path.join(markers,item+'.json')),false);
    await read({CODEX_WEB_AUTOMATION_JOB_ID:job,PPAGENT_STORAGE_MAINTENANCE:'1'});assert.equal(fs.existsSync(path.join(markers,item+'.json')),false);
    await read({CODEX_WEB_AUTOMATION_JOB_ID:job,PPAGENT_STORAGE_MAINTENANCE:'0'});
    const used=JSON.parse(fs.readFileSync(path.join(markers,item+'.json'),'utf8'));
    assert.equal(used.itemId,item);assert.equal(used.jobId,job);assert.equal(used.evidence,'tool-read');assert.match(used.processIdentity,/^.+:\d+:\d+$/);
  }finally{
    if(child.exitCode===null && child.signalCode===null){const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.stdin.end();await stopped;}
    lines.close();fs.rmSync(root,{recursive:true,force:true});
  }
});

import {DatabaseSync} from 'node:sqlite';
import {StorageCatalog} from '../server/storage-catalog.js';
import {migrateStorageLifecycle} from '../server/storage-lifecycle-schema.js';
import {StorageAccessMonitor,openStorageUsageGap,closeStorageUsageGap,recordStorageUsage} from '../server/storage-access-monitor.js';

test('replayed durable usage markers remain read-only under another real SQLite writer',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-marker-replay-')),file=path.join(root,'db.sqlite');
 const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1');migrateStorageLifecycle(db);
 const peer=new DatabaseSync(file);let now=Date.now();const catalog=new StorageCatalog(db,()=>now);
 const item=catalog.enroll({userId:'owner',scope:'test',sourceKey:'used',kind:'file',name:'used',locator:{path:'used'},trustedUsedAt:now-60*STORAGE_DAY});
 const usage={itemId:item.id,userId:'owner',at:now,evidence:'tool-read' as const,processIdentity:crypto.randomUUID()+':123:456',jobId:null};
 try {
  recordStorageUsage(catalog,usage);
  const before=db.prepare('SELECT last_used_at,usage_not_before FROM storage_items WHERE id=?').get(item.id);
  const lease=db.prepare('SELECT * FROM storage_leases WHERE item_id=?').get(item.id);
  const changes=db.prepare('SELECT total_changes() n').get()!.n;
  peer.exec('BEGIN IMMEDIATE');
  for(let i=0;i<100;i++)recordStorageUsage(catalog,usage);
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);
  assert.deepEqual(db.prepare('SELECT last_used_at,usage_not_before FROM storage_items WHERE id=?').get(item.id),before);
  assert.deepEqual(db.prepare('SELECT * FROM storage_leases WHERE item_id=?').get(item.id),lease);
  now+=10*60_000;
  assert.throws(()=>recordStorageUsage(catalog,{...usage,at:now}),/locked/);
  assert.deepEqual(db.prepare('SELECT last_used_at,usage_not_before FROM storage_items WHERE id=?').get(item.id),before);
  peer.exec('COMMIT');recordStorageUsage(catalog,{...usage,at:now});
  assert.equal(catalog.item('owner',item.id).last_used_at,now);
  assert.equal(db.prepare('SELECT count(*) n FROM storage_leases WHERE item_id=?').get(item.id)!.n,1);
  assert.equal(db.prepare('SELECT expires_at FROM storage_leases WHERE item_id=?').get(item.id)!.expires_at,now+5*60_000);
 }finally{if(peer.isTransaction)peer.exec('ROLLBACK');peer.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});
import {STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {reconcileStorageObjectLease,storageProcessIdentity} from '../server/storage-host.js';

test('fanotify notification backpressure cannot hold a real SQLite writer behind a file permission request',{timeout:20_000},async t=>{
 const capability=/^CapEff:\s*([0-9a-f]+)/m.exec(fs.readFileSync('/proc/self/status','utf8'))?.[1];
 if(!capability || !(BigInt('0x'+capability)&(1n<<21n))){t.skip('Real fanotify contention requires host CAP_SYS_ADMIN');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-pipe-lock-')),database=path.join(root,'db.sqlite');
 const db=new DatabaseSync(database);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50; CREATE TABLE probe(n INTEGER)');
 const files=Array.from({length:4096},(_,i)=>{const file=path.join(root,'watch-'+i);fs.writeFileSync(file,'x');return {id:crypto.randomUUID(),userId:crypto.randomUUID(),path:file};});
 const helper=spawn('python3',['-u','-c',"import socket,sys,runpy;s=socket.socket(fileno=1);s.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,4096);s.detach();sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')",path.join(process.cwd(),'deploy/storage-access-monitor.py'),path.join(root,'markers')],{stdio:['pipe','pipe','pipe']});
 let writer:ReturnType<typeof spawn>|undefined;
 // Deliberately never consume helper.stdout: the parent's DB callback is
 // blocked. The ready notification is larger than the actual pipe capacity.
 let helperError='';helper.stderr.on('data',data=>{helperError=(helperError+String(data)).slice(-2000);});
 // Large configuration writes are asynchronous. Observe pipe failures instead
 // of letting teardown emit an unhandled EPIPE after a failed readiness probe.
 helper.stdin.on('error',()=>undefined);
 try{
  await new Promise<void>((resolve,reject)=>helper.stdin.write(JSON.stringify({files,jobs:{}})+'\n',error=>error?reject(error):resolve()));
  const deadline=Date.now()+8000;let marked=false;
  while(Date.now()<deadline){
   assert.equal(helper.exitCode,null,'monitor exited: '+helperError);
   for(const fd of fs.readdirSync(`/proc/${helper.pid}/fdinfo`)){
    let info:string;
    try{info=fs.readFileSync(`/proc/${helper.pid}/fdinfo/${fd}`,'utf8');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if((info.match(/fanotify ino:/g)??[]).length===files.length)marked=true;
   }
   if(marked)break;await delay(20);
  }
  assert.ok(marked,'all real inode marks installed');
  writer=spawn(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');
    fs.readFileSync(process.argv[2]);db.exec('INSERT INTO probe VALUES(1); COMMIT');db.close();
  `,database,files[0].path],{stdio:['ignore','pipe','ignore']});
  const exited=new Promise<boolean>(resolve=>writer!.once('exit',code=>resolve(code===0)));
  await once(writer.stdout!,'data');
  const finished=await Promise.race([exited,delay(3000).then(()=>false)]);
  let writerBlocked=false;try{db.prepare('INSERT INTO probe VALUES(0)').run();}catch(error){writerBlocked=(error as {errcode?:number}).errcode===5;}
  console.info(JSON.stringify({event:'fanotify_backpressure_probe',writerFinished:finished,sqliteWriterBlocked:writerBlocked}));
  assert.equal(finished,true,'reader holding SQLite must finish even while the observer pipe is full');
  db.prepare('INSERT INTO probe VALUES(2)').run();assert.equal(db.prepare('SELECT count(*) n FROM probe').get()!.n,3);
 }finally{
  const stopped=new Promise<void>(resolve=>{if(helper.exitCode!==null||helper.signalCode!==null)resolve();else{helper.once('exit',()=>resolve());helper.kill('SIGTERM');}});await stopped;
  if(writer&&writer.exitCode===null&&writer.signalCode===null)await new Promise<void>(resolve=>{writer!.once('exit',()=>resolve());writer!.kill('SIGTERM');});
  db.close();fs.rmSync(root,{recursive:true,force:true});
 }
});

test('large observation gaps commit bounded pages and never change last-used timestamps',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-gap-pages-')),file=path.join(root,'db.sqlite');
 const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL');migrateStorageLifecycle(db);
 const peer=new DatabaseSync(file);peer.exec('PRAGMA busy_timeout=1');
 const catalog=new StorageCatalog(db),ids:string[]=[];
 try{
  for(let i=0;i<600;i++)ids.push(catalog.enroll({userId:'owner',scope:'test',sourceKey:String(i),kind:'file',name:'test',locator:{path:String(i)},trustedUsedAt:Date.now()-60*STORAGE_DAY}).id);
  const before=db.prepare('SELECT id,last_used_at FROM storage_items ORDER BY id').all();openStorageUsageGap(catalog,ids);
  const original=db.exec.bind(db);let previous=0,commits=0;
  db.exec=(sql:string)=>{original(sql);if(sql==='COMMIT'){
    const count=Number(peer.prepare('SELECT count(*) n FROM storage_items WHERE usage_not_before>0').get()!.n);
    assert.ok(count-previous<=128);previous=count;commits++;
    peer.prepare("INSERT OR REPLACE INTO storage_scan_state VALUES('peer','{}',1)").run();
  }};
  closeStorageUsageGap(catalog);assert.equal(previous,600);assert.ok(commits>=5);
  assert.deepEqual(db.prepare('SELECT id,last_used_at FROM storage_items ORDER BY id').all(),before);
  assert.equal(db.prepare("SELECT 1 FROM storage_scan_state WHERE name='access-gap'").get(),undefined);
 }finally{peer.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('a successful observer restart resolves its stopped-process issue after the helper becomes ready',async()=>{
 const db=new DatabaseSync(':memory:');migrateStorageLifecycle(db);db.exec('CREATE TABLE jobs(id TEXT,conversation_id TEXT); CREATE TABLE conversations(id TEXT,user_id TEXT)');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-monitor-restart-')),helper=path.join(root,'helper.py');
 fs.writeFileSync(helper,"import sys,json\nfor line in sys.stdin:\n json.loads(line)\n print(json.dumps(dict(event='ready',watched=0,items=[])),flush=True)\n");
 const catalog=new StorageCatalog(db),roots={dataRoot:root,tenantRoot:root,hostRootCodexHome:root,hostUserId:crypto.randomUUID()};
 let monitor:StorageAccessMonitor|undefined;
 try{
  for(let i=0;i<2;i++){
   monitor=new StorageAccessMonitor(catalog,roots,path.join(root,'markers'),helper);monitor.start();
   const until=Date.now()+5000;
   while(!JSON.parse(String(db.prepare("SELECT value_json FROM storage_scan_state WHERE name='access-monitor'").get()?.value_json??'{}')).ready){
    if(Date.now()>until)throw new Error('observer_ready_timeout');await new Promise(r=>setTimeout(r,10));
   }
   assert.equal(db.prepare("SELECT 1 FROM storage_issues WHERE scope='access-monitor' AND source_key='process' AND resolved_at IS NULL").get(),undefined);
   await monitor.stop();monitor=undefined;
   assert.ok(db.prepare("SELECT 1 FROM storage_issues WHERE scope='access-monitor' AND source_key='process' AND resolved_at IS NULL").get());
  }
 }finally{await monitor?.stop();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('monitor gaps defer only the affected objects once, preserve true use dates, and reconcile expired live-shell leases',()=>{
 const db=new DatabaseSync(':memory:');migrateStorageLifecycle(db);db.exec('CREATE TABLE jobs(id TEXT,status TEXT)');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-lease-')),file=path.join(root,'file');fs.writeFileSync(file,'sample');
 try{
  let now=Date.now();const c=new StorageCatalog(db,()=>now);
  const item=c.enroll({userId:'owner',scope:'test',sourceKey:'x',kind:'file',locator:{root:'test',path:'file'},name:'file',trustedUsedAt:now-100*STORAGE_DAY});
  const other=c.enroll({userId:'owner',scope:'test',sourceKey:'y',kind:'file',locator:{root:'test',path:'other'},name:'other',trustedUsedAt:now-100*STORAGE_DAY});
  openStorageUsageGap(c,[item.id]);now+=5000;closeStorageUsageGap(c);
  assert.equal(c.item('owner',item.id).last_used_at,item.last_used_at);assert.equal(c.due(c.item('owner',item.id)),false);assert.equal(c.due(other),true);
  const until=c.item('owner',item.id).usage_not_before;now+=STORAGE_DAY;closeStorageUsageGap(c);assert.equal(c.item('owner',item.id).usage_not_before,until);
  now+=15*STORAGE_DAY;assert.equal(c.due(c.item('owner',item.id)),true);
  const identity=storageProcessIdentity(),lease=c.acquireLease('owner',item.id,{processIdentity:identity,purpose:'read',ttlMs:1000});now+=2000;
  const fd=fs.openSync(file,'r');assert.equal(reconcileStorageObjectLease(lease,db,file,now),'live');fs.closeSync(fd);
  assert.equal(reconcileStorageObjectLease(lease,db,file,now),'dead');c.releaseLease('owner',lease.id);
  now+=1000;recordStorageUsage(c,{itemId:item.id,userId:'owner',at:now,evidence:'tool-read',processIdentity:identity,jobId:null});
  assert.equal(db.prepare('SELECT count(*) n FROM storage_leases WHERE released_at IS NULL').get()!.n,1);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
