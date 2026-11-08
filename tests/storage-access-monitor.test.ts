import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import test from 'node:test';

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
import {STORAGE_DAY} from '../server/storage-lifecycle-policy.js';
import {reconcileStorageObjectLease,storageProcessIdentity} from '../server/storage-host.js';

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
