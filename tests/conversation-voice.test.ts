import {VOICE_PROTOCOL_VERSION} from '../src/voice-protocol.js';
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
import {VoiceTranscripts} from '../server/voice-transcripts.js';
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
  for(const version of [undefined,null,1,'2',{},3])assert.throws(()=>gateway.ticket(session,true,f.c.id,version),/刷新/);
  assert.equal((gateway as any).tickets.size,0);
  const first=gateway.ticket(session,false,f.c.id,VOICE_PROTOCOL_VERSION);assert.equal(first.conversationId,f.c.id);assert.equal(await attempt(first.ticket,'http://wrong-origin.invalid'),401);assert.equal(await attempt(first.ticket),401);
  const expired=gateway.ticket(session,false,f.c.id,VOICE_PROTOCOL_VERSION);(gateway as any).tickets.get(expired.ticket).expires=0;assert.equal(await attempt(expired.ticket),401);
  const revoked=gateway.ticket(session,false,f.c.id,VOICE_PROTOCOL_VERSION);f.db.deleteSession(tokenHash);assert.equal(await attempt(revoked.ticket),401);
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
 const events=resumed.events(0).filter(e=>e.kind==='voice_fragment');assert.equal(events.length,2);assert.equal(JSON.parse(events[1]!.content).startMs,300);assert.equal(JSON.parse(events[1]!.content).delta,' go');assert.equal(f.db.listPendingPrompts(f.c.id).length,0);
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

test('late timed voice is preserved as context but cannot redispatch an older intent',async t=>{
 const f=fixture(t),base={callId:'one',startMs:2000,endMs:2200,timed:true,withheld:false};
 f.scope.record('user','latest green',id(),'2026-11-09T00:00:02.000Z',base);await f.scope.delegate('latest');
 f.scope.record('user','old blue',id(),'2026-11-09T00:00:01.000Z',{...base,startMs:1000,endMs:1200});
 assert.equal((await f.scope.delegate('late-old')).mode,'no_new_input');assert.equal(f.delivered.length,1);
 assert.deepEqual(f.db.listMessages(f.c.id).map(m=>m.content),['old blue','latest green']);
 assert.ok(f.scope.events(0).some(e=>e.kind==='voice_user_context'));assert.match(f.scope.checkpoint().text,/old blue/);
});
test('withheld speech is explicitly identified in both ordinary and Dot recovery context',t=>{
 const f=fixture(t),meta={callId:'test',startMs:1,endMs:100,timed:true,withheld:true};
 f.scope.record('assistant','not heard',id(),'2026-11-09T00:00:00.001Z',meta);
 assert.match(f.scope.checkpoint().text,/"withheld":true/);
 const dot=new ConversationVoiceScope(f.store,user,f.dot.id,f.hooks);dot.record('assistant','dot not heard',id(),'2026-11-09T00:00:00.001Z',meta);
 assert.match(dot.checkpoint().text,/"withheld":true/);assert.equal(f.db.listPendingPrompts(f.dot.id).length,0);
});

test('continuous voice updates one new display bubble while dispatch consumes immutable fragments once',async t=>{
 const f=fixture(t),birth=Date.now(),transcripts=new VoiceTranscripts(s=>f.scope.record(s.role,s.text,s.source,s.createdAt,s));
 for(let i=0;i<45;i++){
  const e={event_id:'voice-'+i,delta:i===0?'Please write ':' one',start_ms:i*1300,end_ms:i*1300+500};
  assert.ok(f.scope.fragment('user',e,'long-call',birth));transcripts.add('user',e,'long-call',birth);transcripts.flush();
 }
 const messages=f.db.listMessages(f.c.id);assert.equal(messages.length,1);assert.match(messages[0]!.content,/Please write/);
 assert.equal(f.scope.events(0).filter(e=>e.kind==='voice_input').length,45);
 await f.scope.delegate('request');await f.scope.delegate('repeat');assert.equal(f.delivered.length,1);
 const e={event_id:'new-correction',delta:' change to green',start_ms:59000,end_ms:60000};f.scope.fragment('user',e,'long-call',birth);transcripts.add('user',e,'long-call',birth);transcripts.flush();
 assert.equal(f.db.listMessages(f.c.id).length,1);
 await f.scope.delegate('correction');assert.equal(f.delivered.length,2);
 const second=f.db.listPendingPrompts(f.c.id).at(-1)!;assert.match(second.content,/change to green/);
 // Display updates must not become accepted_text or new message_user events.
 f.scope.reconcile();assert.equal(f.scope.events(0).filter(e=>e.kind==='message_user').length,0);
});
test('late earlier fragment updates the current bubble but never re-dispatches consumed input',async t=>{
 const f=fixture(t),birth=Date.now(),transcripts=new VoiceTranscripts(s=>f.scope.record(s.role,s.text,s.source,s.createdAt,s));
 const newer={event_id:'later',delta:'new request',start_ms:3000,end_ms:4000};f.scope.fragment('user',newer,'call',birth);transcripts.add('user',newer,'call',birth);transcripts.flush();await f.scope.delegate('one');
 const old={event_id:'late-old',delta:'earlier context ',start_ms:1000,end_ms:2000};f.scope.fragment('user',old,'call',birth);transcripts.add('user',old,'call',birth);transcripts.flush();await f.scope.delegate('two');
 assert.equal(f.delivered.length,1);assert.equal(f.db.listMessages(f.c.id).length,1);assert.match(f.db.listMessages(f.c.id)[0]!.content,/earlier context new request/);
});
test('pending delegation receipt survives scope recreation until a real outcome is persisted',t=>{
 const f=fixture(t);f.scope.event('voice_delegation_requested','pending',JSON.stringify({callId:'old'}));
 const resumed=new ConversationVoiceScope(f.store,user,f.c.id,f.hooks);assert.deepEqual(resumed.pendingDelegations().map(x=>x.id),['pending']);
 resumed.event('voice_delegation_resolved','pending',JSON.stringify({mode:'queued_next_turn'}));assert.deepEqual(resumed.pendingDelegations(),[]);
});

test('voice delegation is internal in new jobs and legacy history; typed JSON remains literal',async t=>{
 const f=fixture(t);f.scope.record('user','Please check weather.');await f.scope.delegate('weather');
 const pending=f.db.listPendingPrompts(f.c.id)[0],job=f.db.materializePendingPrompt(pending.id,id(),id())!;
 assert.equal(f.db.getMessage(job.message_id!)?.is_internal,1);
 assert.match(f.db.getMessage(job.message_id!)!.content,/本会话背景/);
 // This exact old bug is compatibility-projected, never edited or dispatched.
 f.db.sqlite.prepare('UPDATE messages SET is_internal=0 WHERE id=?').run(job.message_id!);
 const before=f.db.getMessage(job.message_id!)!.content;
 const text='User discussion {"callId":"literal-uuid","event_id":"example"}';f.scope.record('user',text);
 assert.deepEqual(f.db.listMessages(f.c.id).map(m=>m.content),['Please check weather.',text]);
 assert.equal(f.db.listMessagesPage(f.c.id,undefined,1)!.messages[0].content,text);
 assert.equal(f.db.getMessage(job.message_id!)!.content,before);assert.equal(f.delivered.length,1);
});

test('turn projection preserves long speech, true replies, late ordering and repeated events',t=>{
 const f=fixture(t),birth=Date.now(),call='long';
 const put=(role:'user'|'assistant',n:number,text:string,start:number,end:number,extra={})=>{
   f.scope.fragment(role,{event_id:String(n),delta:text,start_ms:start,end_ms:end,presentationVersion:1,...extra},call,birth);
 };
 put('user',1,'中文 first ',0,1000);put('user',2,'改口 ',5000,6000);put('user',3,'long '.repeat(2000),130000,131000);
 put('assistant',4,'tool-only generated',132000,133000,{withheld:true});
 put('user',5,'end',150000,151000);
 assert.equal(f.db.listMessages(f.c.id).length,1);assert.ok(f.db.listMessages(f.c.id)[0].content.length>8000);
 put('assistant',6,'A1',152000,153000);f.scope.playback(call,[[152000,153000]]);
 put('user',7,'U2',153010,154000);put('assistant',8,'A2',154010,155000);f.scope.playback(call,[[152000,153000],[154010,155000]]);
 put('user',9,'late ',2000,3000);put('user',9,'late ',2000,3000);
 const messages=f.db.listMessages(f.c.id);assert.deepEqual(messages.map(m=>m.role),['user','assistant','user','assistant']);
 assert.match(messages[0].content,/first late 改口/);assert.equal(messages[2].content,'U2');
 const next=f.db.listMessagesPage(f.c.id,undefined,2)!;assert.equal(next.hasMore,true);
 assert.equal(f.db.listMessagesPage(f.c.id,next.nextCursor!,2)!.messages.length,2);
 assert.equal(f.db.listPendingPrompts(f.c.id).length,0);
 const resumed=new ConversationVoiceScope(f.store,user,f.c.id,f.hooks);assert.deepEqual(resumed.db.listMessages(f.c.id),messages);
});

test('unplayed generation never splits input; real media epoch is a boundary with explicit word uncertainty',t=>{
 const f=fixture(t),birth=Date.now(),call='audible';
 const put=(role:'user'|'assistant',eid:string,text:string,start:number,end:number,epoch:number)=>f.scope.fragment(role,{event_id:eid,delta:text,start_ms:start,end_ms:end,presentationVersion:1,outputEpoch:epoch},call,birth);
 put('user','u1','first ',0,1000,1);put('assistant','unheard','never played',2000,3000,1);put('user','u1b','continued',5000,6000,2);
 assert.deepEqual(f.db.listMessages(f.c.id).map(m=>m.content),['first continued']);
 put('assistant','heard','actual response; exact tail unknown',7000,8000,2);f.scope.playback(call,[],[2]);put('user','u2','second turn',10000,11000,3);
 const shown=f.db.listMessages(f.c.id) as any[];assert.deepEqual(shown.map(m=>m.role),['user','assistant','user']);assert.equal(shown[1].voice_playback,'unconfirmed');assert.equal(shown[2].content,'second turn');
});
test('recovery within one dialogue can continue speech; another call cannot merge across history',()=>{
 const t=new VoiceTranscripts(()=>{}),birth=Date.now();
 t.add('user',{event_id:'one',delta:'before ',start_ms:0,end_ms:100,dialogue_id:'same'},'physical1',birth);
 t.add('user',{event_id:'two',delta:'after',start_ms:0,end_ms:100,dialogue_id:'same'},'physical2',birth+5000);
 t.add('user',{event_id:'three',delta:'new call',start_ms:0,end_ms:100},'new-call',birth+60000);
 assert.deepEqual(t.segments().map(s=>s.text),['before after','new call']);
});

test('a reply overlapping the final input token still separates the next interruption',()=>{
 const turns=new VoiceTranscripts(()=>{}),birth=Date.now();
 const put=(role:'user'|'assistant',id:string,text:string,start:number,end:number,withheld=false)=>turns.add(role,{event_id:id,delta:text,start_ms:start,end_ms:end,playback:'audible'},'overlap',birth,withheld);
 put('user','u1','Tell a story',60000,68000);
 put('assistant','a1','Sure!',68200,68400);
 // The final user token arrives late and shares the first response timestamp.
 put('user','u1-tail',' please.',68200,68400);
 put('assistant','a2',' A lighthouse',69000,69800);
 put('assistant','unplayed',' omitted',70200,70400,true);
 put('assistant','a3',' stood',70400,70600);
 put('user','u2','Stop; say green.',72600,78600);
 put('assistant','a4','green',78600,78800);
 const visible=turns.segments().filter(s=>!s.withheld);
 assert.deepEqual(visible.map(s=>[s.role,s.text]),[['user','Tell a story please.'],['assistant','Sure! A lighthouse stood'],['user','Stop; say green.'],['assistant','green']]);
});

test('approximate reply timing cannot detach a final token without a new caller onset',t=>{
 const f=fixture(t),birth=Date.now(),call='final-token';
 const put=(role:'user'|'assistant',id:string,text:string,start:number,end:number,epoch:number)=>f.scope.fragment(role,{event_id:id,delta:text,start_ms:start,end_ms:end,presentationVersion:1,outputEpoch:epoch},call,birth);
 put('user','u1','Only say green, no ',0,126000,1);
 put('assistant','a1','green',126400,126600,1);f.scope.playback(call,[],[1]);
 put('user','u1-tail','task',126600,126800,1);
 assert.deepEqual(f.db.listMessages(f.c.id).map(m=>m.content),['Only say green, no task','green']);
 put('user','u2','New request',128000,129000,2);
 assert.deepEqual(f.db.listMessages(f.c.id).map(m=>m.content),['Only say green, no task','green','New request']);
});

test('redacted 17-input historical fixture projects original speech without the 5211-character wrapper',async t=>{
 const f=fixture(t),birth=Date.UTC(2026,0,1);
 const fragments=JSON.parse(fs.readFileSync(new URL('./fixtures/voice-history-redacted.json',import.meta.url),'utf8'));
 assert.equal(fragments.filter((x:any)=>x.role==='user').length,17);
 for(const e of fragments)f.scope.fragment(e.role,e,'fixture-call',birth);
 await f.scope.delegate('fixture-operation');const p=f.db.listPendingPrompts(f.c.id)[0],job=f.db.materializePendingPrompt(p.id,id(),id())!;
 const wrapper=(f.db.getMessage(job.message_id!)!.content+'x'.repeat(5211)).slice(0,5211);
 f.db.sqlite.prepare('UPDATE messages SET is_internal=0,content=? WHERE id=?').run(wrapper,job.message_id!);
 const before=f.db.sqlite.prepare('SELECT count(*) n FROM jobs WHERE conversation_id=?').get(f.c.id)!.n;
 const messages=f.db.listMessages(f.c.id);
 for(const role of ['user','assistant'])assert.equal(messages.filter(m=>m.role===role).map(m=>m.content).join(''),fragments.filter((e:any)=>e.role===role).sort((a:any,b:any)=>a.start_ms-b.start_ms).map((e:any)=>e.delta).join(''));
 assert.ok(messages.every(m=>!m.content.includes('[本会话语音要求')&&!m.files.length));
 assert.equal(f.db.getMessage(job.message_id!)!.content,wrapper);
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM jobs WHERE conversation_id=?').get(f.c.id)!.n,before);
});

test('ticket keeps one owner-scoped dialogue across browser reconnects without mixing other calls',t=>{
 const f=fixture(t);const keys=['CODEX_WEB_LIVE_ENABLED','CODEX_WEB_LIVE_API_KEY_FILE','CODEX_WEB_LIVE_ENDPOINT','CODEX_WEB_LIVE_MODEL'];const previous=keys.map(k=>process.env[k]);
 t.after(()=>keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i]}));
 process.env.CODEX_WEB_LIVE_ENABLED='true';process.env.CODEX_WEB_LIVE_API_KEY_FILE=path.join(f.root,'fixture-key');process.env.CODEX_WEB_LIVE_ENDPOINT='wss://voice.example.invalid/live';process.env.CODEX_WEB_LIVE_MODEL='synthetic-live';fs.writeFileSync(process.env.CODEX_WEB_LIVE_API_KEY_FILE,'synthetic-no-network-credential');
 const gateway=new DotLiveGateway(f.store,{dataRoot:f.root,basePath:'',publicBaseUrl:'http://localhost'} as any,()=>{});gateway.hooks=f.hooks;
 const sid=id();f.db.createSession(sid,'csrf',new Date(Date.now()+300000).toISOString(),user);const session=f.db.getSession(sid)!,dialogue=id();
 const first=gateway.ticket(session,false,f.c.id,VOICE_PROTOCOL_VERSION,dialogue),second=gateway.ticket(session,false,f.c.id,VOICE_PROTOCOL_VERSION,dialogue),other=gateway.ticket(session,false,f.c.id,VOICE_PROTOCOL_VERSION,id());
 assert.equal((gateway as any).tickets.get(first.ticket).dialogueId,(gateway as any).tickets.get(second.ticket).dialogueId);
 assert.notEqual((gateway as any).tickets.get(first.ticket).dialogueId,(gateway as any).tickets.get(other.ticket).dialogueId);
 assert.throws(()=>gateway.ticket(session,false,f.c.id,VOICE_PROTOCOL_VERSION,'invalid'),/标识无效/);void gateway.close();
});
