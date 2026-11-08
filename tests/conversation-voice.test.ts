import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import WebSocket from 'ws';
import {AppDatabase,LEGACY_USER_ID} from '../server/db.js';
import {HOST_ROOT_USER_ID as user} from '../server/host-root-user.js';
import {DotStore} from '../server/dot-store.js';
import {ConversationVoiceScope,isExplicitVoiceCancellation,type VoiceHooks} from '../server/conversation-voice.js';
import {migrateConversationVoice} from '../server/conversation-voice-schema.js';
import {DotLiveGateway} from '../server/dot-live.js';
const id=()=>crypto.randomUUID(),selection={model:'gpt-6-astra',reasoningEffort:'xhigh'};
function fixture(t:test.TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-voice-')),db=new AppDatabase(root);
 db.createUser({id:user,username:'test-host',display_name:'test',password_hash:'test',role:'owner',status:'active',created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
 const project=db.createProject(id(),user,'coordinator-project','/example/coordinator','local-host'),store=new DotStore(db,()=>selection),dot=store.init(user),c=db.createConversation(id(),'ordinary',selection,user,project.id);
 const delivered:string[]=[],cancelled:string[]=[];
 const hooks:VoiceHooks={eligibility:()=>null,selection:()=>selection,steer:async p=>{delivered.push(p);return {mode:'queued_next_turn',message:'queued'};},cancel:j=>{cancelled.push(j);return true;},changed:()=>{}};
 const scope=new ConversationVoiceScope(store,user,c.id,hooks);
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});return {root,db,project,store,dot,c,scope,hooks,delivered,cancelled};
}
test('conversation scope never initializes or reads global Dot memories, tasks or checkpoints',t=>{
 const f=fixture(t);f.store.event(user,'private','source','global private fact');
 f.scope.record('user','ordinary-only');const cp=f.scope.checkpoint();
 assert.match(cp.text,/ordinary-only/);assert.doesNotMatch(cp.text,/global private fact/);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM dot_checkpoints').get()!.n,0);
 assert.equal(f.db.listMessages(f.dot.id).length,0);
 assert.equal(f.db.listMessages(f.c.id).length,1);
 assert.equal(f.db.getConversation(f.c.id)?.project_id,f.project.id);
});
test('same delegation or another delegation without new source cannot create duplicate side effects',async t=>{
 const f=fixture(t);f.scope.record('user','Create one test artifact.');await f.scope.delegate('one');await f.scope.delegate('one');await f.scope.delegate('another');
 assert.equal(f.db.listPendingPrompts(f.c.id).length,1);assert.equal(f.delivered.length,1);assert.equal(f.db.listPendingPrompts(f.dot.id).length,0);
 const p=f.db.listPendingPrompts(f.c.id)[0]!;assert.equal(p.agent_model,selection.model);assert.equal(p.reasoning_effort,selection.reasoningEffort);
});
test('consumed source watermarks survive scope recreation and replacement call checkpoints',async t=>{
 const f=fixture(t);f.scope.record('user','first');await f.scope.delegate('first');f.scope.checkpoint();
 const resumed=new ConversationVoiceScope(f.store,user,f.c.id,f.hooks);await resumed.delegate('new-upstream-id');assert.equal(f.delivered.length,1);
 resumed.record('user','change to green');await resumed.delegate('correction');assert.equal(f.delivered.length,2);
 for(let i=0;i<5;i++)resumed.checkpoint();assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM conversation_voice_checkpoints WHERE conversation_id=?').get(f.c.id)!.n,3);
 assert.match(resumed.checkpoint().text,/change to green/);
});
test('Dot scope uses new-source watermarks too, while preserving coordinator routing',async t=>{
 const f=fixture(t);f.store.event(user,'voice_user',id(),'old already handled');
 const scope=new ConversationVoiceScope(f.store,user,f.dot.id,f.hooks);scope.record('user','new task');await scope.delegate('dot-one');await scope.delegate('dot-two');
 const queued=f.db.listPendingPrompts(f.dot.id);assert.equal(queued.length,1);assert.match(queued[0]!.content,/pp_dot context/);assert.doesNotMatch(queued[0]!.content,/old already handled/);assert.equal(f.db.listPendingPrompts(f.c.id).length,0);
});
test('queued voice work materializes onto the original native thread and records its exact job',async t=>{
 const f=fixture(t);f.db.sqlite.prepare('UPDATE conversations SET codex_thread_id=? WHERE id=?').run('native-original',f.c.id);
 f.scope.record('user','work');await f.scope.delegate('work');const pending=f.db.listPendingPrompts(f.c.id)[0]!;
 const job=f.db.materializePendingPrompt(pending.id,id(),id())!;assert.ok(job);
 assert.equal(f.db.sqlite.prepare('SELECT job_id FROM conversation_voice_operations WHERE request_key=?').get('work')!.job_id,job.id);
 assert.equal(f.db.getConversation(f.c.id)?.codex_thread_id,'native-original');
 f.scope.reconcile();assert.ok(f.scope.events(0).some(e=>e.kind==='job_state'));
});
test('exact cancellation is pinned to existing jobs, and retry leaves a new job alone',async t=>{
 const f=fixture(t),job=f.db.createJob(id(),f.c.id,undefined,selection);f.db.updateJob(job.id,'running');
 f.scope.record('user','取消当前任务。');await f.scope.delegate('cancel');assert.deepEqual(f.cancelled,[job.id]);
 f.db.updateJob(job.id,'cancelled');f.db.workflows.settled(job.id);const next=f.db.createJob(id(),f.c.id,undefined,selection);f.db.updateJob(next.id,'running');await f.scope.delegate('cancel');await f.scope.delegate('cancel-again');assert.deepEqual(f.cancelled,[job.id]);
});
test('ambiguous stop and acknowledgement never request task cancellation',()=>{
 for(const text of ['停一下','先别说','好','嗯','不要取消当前任务','请解释取消当前任务的含义','取消其他会话任务'])assert.equal(isExplicitVoiceCancellation(text),false,text);
 for(const text of ['取消当前任务。','请停止这个任务','Please cancel the current task.'])assert.equal(isExplicitVoiceCancellation(text),true,text);
});
test('owner, archived, cold and project changes fail closed without cross-scope writes',t=>{
 const f=fixture(t);assert.throws(()=>new ConversationVoiceScope(f.store,LEGACY_USER_ID,f.c.id,f.hooks));
 f.db.sqlite.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(new Date().toISOString(),f.c.id);assert.throws(()=>f.scope.validate(),/恢复/);
 f.db.sqlite.prepare('UPDATE conversations SET archived_at=NULL WHERE id=?').run(f.c.id);f.db.sqlite.prepare("UPDATE projects SET executor_id='remote:changed' WHERE id=?").run(f.project.id);assert.throws(()=>f.scope.validate(),/位置/);
 assert.equal(f.db.listMessages(f.c.id).length,0);
});
test('unavailable execution selection cannot silently fall back or enqueue',async t=>{
 const f=fixture(t);f.scope.record('user','do work');f.hooks.eligibility=()=> '原模型不可用';await assert.rejects(f.scope.delegate('no'),/原模型/);assert.equal(f.db.listPendingPrompts(f.c.id).length,0);
});
test('delivery uncertainty is durable and never replayed as a next turn',async t=>{
 const f=fixture(t);f.hooks.steer=async p=>{f.db.deletePendingPrompt(p);return {mode:'delivery_uncertain',message:'uncertain'};};
 f.scope.record('user','correct work');const first=await f.scope.delegate('uncertain');assert.equal(first.mode,'delivery_uncertain');
 assert.equal((await f.scope.delegate('uncertain')).mode,'delivery_uncertain');assert.equal((await f.scope.delegate('new-id')).mode,'no_new_input');assert.equal(f.db.listPendingPrompts(f.c.id).length,0);
});
test('migration is additive and repeatable, deletion removes only its own voice data',t=>{
 const f=fixture(t);migrateConversationVoice(f.db);migrateConversationVoice(f.db);f.scope.record('user','mine');f.scope.checkpoint();
 f.db.sqlite.prepare('DELETE FROM conversations WHERE id=?').run(f.c.id);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM conversation_voice_events').get()!.n,0);assert.equal(f.db.getConversation(f.dot.id)?.id,f.dot.id);
});
test('bounded long context keeps early anchors and latest correction, not another conversation',t=>{
 const f=fixture(t);f.scope.record('user','EARLY_BLUE_ANCHOR');for(let i=0;i<60;i++)f.scope.record(i%2?'user':'assistant','filler '.repeat(1500));f.scope.record('user','CORRECT_TO_GREEN');
 const cp=f.scope.checkpoint();assert.ok(cp.tokens<=6000);assert.match(cp.text,/CORRECT_TO_GREEN/);assert.match(cp.text,/EARLY_BLUE_ANCHOR/);
});
test('late completion is tied to its exact job and stays historical after a newer correction',async t=>{
 const f=fixture(t);f.scope.record('user','old request');await f.scope.delegate('old');const p=f.db.listPendingPrompts(f.c.id)[0]!;
 const job=f.db.materializePendingPrompt(p.id,id(),id())!;f.db.updateJob(job.id,'running');
 f.scope.record('user','new requirement');await f.scope.delegate('new');
 // Simulate a queued, unsupported steer: the correction belongs to its next job, not the old one.
 assert.equal(f.db.sqlite.prepare("SELECT job_id FROM conversation_voice_operations WHERE request_key='new'").get()!.job_id,null);
 const message={id:id(),conversation_id:f.c.id,role:'assistant' as const,content:'old result only',created_at:new Date().toISOString()},payload={message,files:[]};
 f.db.stageJobFinalization(job.id,payload);f.db.markJobFilesReady(job.id,payload);f.db.finalizeJob(job.id,f.c.id,payload);f.db.publishJobFinalization(job.id);
 f.scope.reconcile();const event=f.scope.events(0).find(e=>e.source_id===message.id)!;
 assert.equal(JSON.parse(event.content).historical,true);const cp=JSON.parse(f.scope.checkpoint().text);assert.equal(cp.recent.find((m:any)=>m.id===message.id).historical,true);assert.equal(f.db.sqlite.prepare('SELECT job_id FROM conversation_voice_results WHERE message_id=?').get(message.id)!.job_id,job.id);
});
test('ordinary text sent during a call is synchronized without a second delegated job',async t=>{
 const f=fixture(t),message={id:id(),conversation_id:f.c.id,role:'user' as const,content:'normal typed request',created_at:new Date().toISOString()};
 f.db.addMessage(message);const job=f.db.createJob(id(),f.c.id,message.id,selection);f.scope.reconcile();
 assert.ok(f.scope.events(0).some(e=>e.source_id===message.id));assert.equal((await f.scope.delegate('unrelated')).mode,'no_new_input');
 assert.equal(f.db.listActiveJobsForConversation(f.c.id).length,1);assert.equal(f.db.getJob(job.id)?.message_id,message.id);
});
test('voice tickets bind account/session/conversation and reject foreign origin, replay and expiration before any upstream',async t=>{
 const f=fixture(t),origin='http://127.0.0.1:37999';fs.mkdirSync(path.join(f.root,'.pp-dot-secret'));fs.writeFileSync(path.join(f.root,'.pp-dot-secret','openai-api-key'),'isolated-not-a-key');
 const liveValues={CODEX_WEB_LIVE_ENABLED:'true',CODEX_WEB_LIVE_API_KEY_FILE:path.join(f.root,'.pp-dot-secret','openai-api-key'),CODEX_WEB_LIVE_ENDPOINT:'wss://voice.example.invalid/live',CODEX_WEB_LIVE_MODEL:'fixture-live'};
 const previous=Object.fromEntries(Object.keys(liveValues).map(k=>[k,process.env[k]]));Object.assign(process.env,liveValues);
 t.after(()=>{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const gateway=new DotLiveGateway(f.store,{dataRoot:f.root,basePath:'',publicBaseUrl:origin} as any,()=>{});gateway.hooks=f.hooks;
 const tokenHash=id();f.db.createSession(tokenHash,'csrf',new Date(Date.now()+300000).toISOString(),user);const session=f.db.getSession(tokenHash)!;
 const server=http.createServer();gateway.attach(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 const attempt=(token:string,requestOrigin=origin)=>new Promise<number>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/api/dot/live`,['pp-dot',token],{origin:requestOrigin});ws.on('unexpected-response',(_q,res)=>{res.resume();ws.terminate();resolve(res.statusCode!);});ws.on('open',()=>{ws.close();reject(Error('must reject before upstream'));});ws.on('error',()=>{});});
 try{
  const first=gateway.ticket(session,false,f.c.id);assert.equal(first.conversationId,f.c.id);assert.equal(await attempt(first.ticket,'http://wrong-origin.invalid'),401);assert.equal(await attempt(first.ticket),401);
  const expired=gateway.ticket(session,false,f.c.id);(gateway as any).tickets.get(expired.ticket).expires=0;assert.equal(await attempt(expired.ticket),401);
  const revoked=gateway.ticket(session,false,f.c.id);f.db.deleteSession(tokenHash);assert.equal(await attempt(revoked.ticket),401);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM conversation_voice_calls').get()!.n,0);
 }finally{await gateway.close();await new Promise<void>(r=>server.close(()=>r()));}
});

test('transcript and source event commit together and a foreign source cannot write',t=>{
 const f=fixture(t),source=id();f.db.addMessage({id:source,conversation_id:f.dot.id,role:'user',content:'other',created_at:new Date().toISOString()});
 assert.throws(()=>f.scope.record('user','wrong',source),/不属于/);assert.equal(f.scope.events(0).length,0);
 const own=id();f.scope.record('user','once',own);f.scope.record('user','once',own);assert.equal(f.db.listMessages(f.c.id).length,1);assert.equal(f.scope.events(0).length,1);
});

test('transcript identity and timing survive recreation without collapsing repeated words',t=>{
 const f=fixture(t),a={delta:' go',start_ms:100,end_ms:200};assert.equal(f.scope.fragment('user',a,'call'),true);assert.equal(f.scope.fragment('user',a,'call'),false);
 const resumed=new ConversationVoiceScope(f.store,user,f.c.id,f.hooks);assert.equal(resumed.fragment('user',a,'call'),false);assert.equal(resumed.fragment('user',{...a,start_ms:300,end_ms:400},'call'),true);
 const events=resumed.events(0);assert.equal(events.length,2);assert.equal(JSON.parse(events[1]!.content).startMs,300);assert.equal(JSON.parse(events[1]!.content).delta,' go');assert.equal(f.db.listPendingPrompts(f.c.id).length,0);
});

// A cold native thread no longer means the local conversation text is unavailable.
test('lifecycle metadata can continue voice while native work stays queued for its original thread', async t => {
 const f=fixture(t),at=new Date().toISOString();
 assert.ok(f.db.transitionConversationStorage(f.c.id,['local'],'cold','isolated-voice-test'));
 assert.throws(()=>f.scope.validate(),/恢复/);
 f.hooks.coldMetadataAvailable=true;
 f.db.sqlite.prepare('UPDATE conversations SET codex_thread_id=? WHERE id=?').run('cold-original-thread',f.c.id);
 f.scope.record('user','Continue my current work using the original files.');
 await f.scope.delegate('cold-metadata');
 assert.equal(f.db.listPendingPrompts(f.c.id).length,1);
 assert.equal(f.db.listActiveJobsForConversation(f.c.id).length,0);
 assert.equal(f.db.getConversation(f.c.id)?.codex_thread_id,'cold-original-thread');
 assert.equal(f.db.getConversationStorage(f.c.id)?.state,'cold');
 assert.match(f.scope.checkpoint().text,/Continue my current work/);
 f.db.sqlite.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(at,f.c.id);
 assert.throws(()=>f.scope.validate(),/恢复/);
 assert.equal(f.db.listPendingPrompts(f.dot.id).length,0);
});
