import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AppDatabase, LEGACY_USER_ID } from '../server/db.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { VoiceLexiconService } from '../server/voice-lexicon.js';
import { isSqliteBusy, retrySqliteBusy, shortSqliteAttempt, startupSqliteRetry } from '../server/sqlite-contention.js';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../server/remote-worker-protocol.js';

async function writer(file:string, ms:number) {
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    setTimeout(()=>{db.exec('COMMIT');db.close();},Number(process.argv[2]));
  `,file,String(ms)],{stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',data=>output+=data);
  const exited=new Promise<void>((resolve,reject)=>child.once('exit',code=>code===0?resolve():reject(new Error(output))));
  await once(child.stdout,'data');return {exited};
}
function receive(socket:WebSocket,type:string) {
  return new Promise<Record<string,unknown>>((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.off('message',listener);reject(new Error('missing '+type));},12_000);
    const listener=(raw:Buffer)=>{const msg=JSON.parse(String(raw));if(msg.type===type){clearTimeout(timer);socket.off('message',listener);resolve(msg);}};
    socket.on('message',listener);
  });
}

test('real eight-second writer does not kill Worker heartbeats or lose quota, queued work or session writes', {timeout:30_000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-web-busy-'));
  const instance=createApp({projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),
    sessionSecret:'test-secret-'.repeat(5),queueAutoStart:false,remoteWorkerEnrollmentToken:'enroll-test'});
  const {db,remoteWorkers}=instance,server=http.createServer(instance.app);remoteWorkers.attach(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const socket=new WebSocket(`ws://127.0.0.1:${address.port}/api/remote-workers/connect`);
  try {
    db.createRemoteWorkerEnrollment(crypto.createHash('sha256').update('enroll-test').digest('hex'),new Date(Date.now()+60_000).toISOString());
    const authenticated=receive(socket,'authenticated');await once(socket,'open');
    const workerId=crypto.randomUUID(),accountId=crypto.randomUUID();
    socket.send(JSON.stringify({type:'hello',protocolVersion:REMOTE_WORKER_PROTOCOL_VERSION,workerId,machineName:'busy-test',enrollmentToken:'enroll-test',platform:'linux',workerVersion:'test',codexVersion:'test',capacity:1}));
    await authenticated;
    let ack=receive(socket,'heartbeat_ack');socket.send(JSON.stringify({type:'heartbeat',activeJobs:[]}));await ack;
    const cid=crypto.randomUUID(),jid=crypto.randomUUID();db.createConversation(cid,'busy-test');db.createJob(jid,cid);
    const unlocked=await writer(path.join(root,'data','codex-web.sqlite'),8000);
    ack=receive(socket,'heartbeat_ack');socket.send(JSON.stringify({type:'heartbeat',activeJobs:[]}));
    socket.send(JSON.stringify({type:'quota_usage',accountId,usage:{remainingPercent:72}}));
    await ack;
    assert.equal(socket.readyState,WebSocket.OPEN);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/health`)).status,200);
    // Rejected writes are bounded and explicit, not silently acknowledged.
    assert.throws(()=>shortSqliteAttempt(db.sqlite,()=>db.createConversation(crypto.randomUUID(),'must-retry')),isSqliteBusy);
    await unlocked.exited;
    // A fresh heartbeat/usage sample also recovers an exhausted telemetry budget.
    socket.send(JSON.stringify({type:'quota_usage',accountId,usage:{remainingPercent:71}}));
    const deadline=Date.now()+4000;
    while(db.getExecutorActiveCodexAccount(`remote:${workerId}`)!==accountId && Date.now()<deadline)await delay(50);
    assert.equal(db.getExecutorActiveCodexAccount(`remote:${workerId}`),accountId);
    assert.equal(db.getJob(jid)?.status,'queued');
    assert.equal(db.sqlite.prepare('SELECT count(*) n FROM jobs WHERE id=?').get(jid)!.n,1);
    const newId=crypto.randomUUID();db.createConversation(newId,'after-unlock');assert.ok(db.getConversation(newId));
  }finally{
    socket.terminate();instance.beginShutdown();await instance.waitForBackgroundTasks();remoteWorkers.close();
    await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();fs.rmSync(root,{recursive:true,force:true});
  }
});

test('startup migrations retry a real long writer, close failed connections and preserve job identity', {timeout:25_000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-startup-'));
  let db:AppDatabase|undefined=new AppDatabase(root,undefined,false);
  const cid=crypto.randomUUID(),jid=crypto.randomUUID();db.createConversation(cid,'startup');db.createJob(jid,cid);db.close();db=undefined;
  try {
    const unlocked=await writer(path.join(root,'codex-web.sqlite'),6500);
    db=await retrySqliteBusy(()=>new AppDatabase(root,undefined,false),{label:'test_startup',maxMs:15_000});
    await unlocked.exited;assert.equal(db.getJob(jid)?.status,'queued');
    assert.equal(db.sqlite.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
    let calls=0;
    await assert.rejects(retrySqliteBusy(()=>{calls++;throw new Error('not busy');},{label:'test'}),/not busy/);assert.equal(calls,1);
  }finally{db?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('contention retry stops at its attempt budget without replaying an external effect',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-budget-')),file=path.join(root,'db.sqlite');
  const db=new DatabaseSync(file),peer=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE writes(id INTEGER PRIMARY KEY)');
  peer.exec('BEGIN IMMEDIATE');let effects=0,attempts=0;
  try {
    effects++;
    await assert.rejects(retrySqliteBusy(()=>{attempts++;return shortSqliteAttempt(db,()=>db.prepare('INSERT INTO writes VALUES(1)').run());},{label:'test_budget',attempts:3,maxMs:2000}),isSqliteBusy);
    assert.equal(effects,1);assert.equal(attempts,3);assert.equal(db.prepare('SELECT count(*) n FROM writes').get()!.n,0);
    assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout,0);
  }finally{peer.exec('ROLLBACK');peer.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});


test('delayed quota samples cannot switch back to an older active account',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-stale-quota-')),db=new AppDatabase(root,undefined,false);
 try {
  const old=crypto.randomUUID(),current=crypto.randomUUID();
  db.setExecutorActiveCodexAccount('executor',current,'2026-11-10T00:00:02.000Z');
  db.setExecutorCodexQuota('executor',{remainingPercent:75},old,'2026-11-10T00:00:01.000Z');
  assert.equal(db.getExecutorActiveCodexAccount('executor'),current);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('a real lock acquired after database construction cannot crash application startup recovery', {timeout:25_000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-app-startup-'));
  const db=new AppDatabase(path.join(root,'data'),undefined,false);
  const cid=crypto.randomUUID(),jid=crypto.randomUUID();db.createConversation(cid,'startup continuation');db.createJob(jid,cid);
  let instance:ReturnType<typeof createApp>|undefined;
  try {
    const locked=await writer(path.join(root,'data','codex-web.sqlite'),6500);
    instance=createApp({projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),
      sessionSecret:'test-startup-secret-'.repeat(4),queueAutoStart:false,hostRootSocketPath:path.join(root,'missing.sock')},db);
    await locked.exited;
    assert.equal(db.getJob(jid)?.status,'queued');
    assert.equal(db.sqlite.prepare('SELECT count(*) n FROM jobs WHERE id=?').get(jid)!.n,1);
    assert.equal(db.sqlite.prepare('PRAGMA busy_timeout').get()!.timeout,5000);
    assert.ok(instance.voiceSubmissions);assert.ok(instance.opportunityVoice);
  }finally{
    if(instance){instance.beginShutdown();await instance.waitForBackgroundTasks();instance.remoteWorkers.close();}
    db.close();fs.rmSync(root,{recursive:true,force:true});
  }
});

test('voice lexicon timer survives a real eight-second writer and resumes one retained review', {timeout:25_000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-voice-timer-')),db=new AppDatabase(root,undefined,false);
  const cid=crypto.randomUUID(),mid=crypto.randomUUID(),vid=crypto.randomUUID();
  db.createConversation(cid,'retained voice',undefined,LEGACY_USER_ID);
  db.addMessage({id:mid,conversation_id:cid,role:'user',content:'Codex Web',created_at:new Date().toISOString()});
  db.createVoiceTranscription({id:vid,userId:LEGACY_USER_ID,conversationId:cid,rawText:'Codex Web',model:'fixture',promptVersion:'fixture'});
  db.attachVoiceTranscriptions({ids:[vid],userId:LEGACY_USER_ID,conversationId:cid,messageId:mid});
  let calls=0;
  const service=new VoiceLexiconService({...loadConfig({dataRoot:root}),voiceLexiconPollMs:1000,voiceLexiconBatchThreshold:1},db,async()=>{calls++;return '{"reviews":[]}';});
  try {
    const locked=await writer(path.join(root,'codex-web.sqlite'),8000);
    service.start();
    await delay(6000);
    assert.equal(calls,0);assert.equal(db.voiceReviewQueueStats(LEGACY_USER_ID,new Date().toISOString()).pending,1);
    await locked.exited;
    const deadline=Date.now()+3000;
    while(db.voiceReviewQueueStats(LEGACY_USER_ID,new Date().toISOString()).pending && Date.now()<deadline)await delay(50);
    assert.equal(calls,1);assert.equal(db.voiceReviewQueueStats(LEGACY_USER_ID,new Date().toISOString()).pending,0);
    await service.pump();assert.equal(calls,1);
  }finally{service.stop();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('startup metadata retry has a finite shared budget and leaves no transaction or duplicate effect',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-init-budget-')),file=path.join(root,'db.sqlite');
  const db=new DatabaseSync(file),peer=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE writes(id INTEGER PRIMARY KEY)');
  peer.exec('BEGIN IMMEDIATE');let effects=0;const initialize=startupSqliteRetry(db,200),started=performance.now();
  try {
    effects++;assert.throws(()=>initialize('startup_budget',()=>db.prepare('INSERT INTO writes VALUES(1)').run()),isSqliteBusy);
    assert.ok(performance.now()-started<1000);assert.equal(effects,1);assert.equal(db.isTransaction,false);
    assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout,0);
    peer.exec('COMMIT');initialize('startup_after_release',()=>db.prepare('INSERT INTO writes VALUES(1)').run());
    assert.equal(db.prepare('SELECT count(*) n FROM writes').get()!.n,1);
  }finally{if(peer.isTransaction)peer.exec('ROLLBACK');peer.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});
