import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppDatabase, LEGACY_USER_ID, type RemoteThreadSnapshotInput } from '../server/db.js';
import { remoteUserMessageMatchesJob } from '../server/remote-execution-prompt.js';
import { MODEL_CAPACITY_CONTINUATION_PROMPT, UPSTREAM_ROUTING_CONTINUATION_PROMPT } from '../server/internal-messages.js';
import { buildAskAgentDraft } from '../src/ask-agent-selection.js';
import { withTaskRecoveryPrompt, type TaskRecoveryCheckpoint } from '../server/task-recovery.js';

function fixture(t: test.TestContext, text='只读检查', quote?:string) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remote-ownership-'));
  const db=new AppDatabase(root);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=db.createProject(crypto.randomUUID(),LEGACY_USER_ID,'test','C:\\qa','remote:qa');
  const conversation=db.createConversation(crypto.randomUUID(),'test',undefined,LEGACY_USER_ID,project.id);
  db.updateConversation(conversation.id,{codexThreadId:'thread'});
  const now=new Date().toISOString(); const id=crypto.randomUUID();
  db.addMessage({id,conversation_id:conversation.id,role:'user',content:text,quote_excerpt:quote,created_at:now});
  const job=db.createJob(crypto.randomUUID(),conversation.id,id);db.updateJob(job.id,'running');
  const workflow=db.workflows.instructions(job.id);assert.match(workflow,/<pp_agent_complete_workflow>/);
  const snapshot=(content:string,turnId='turn'):RemoteThreadSnapshotInput=>({id:'thread',name:'test',createdAt:Date.now()/1000,updatedAt:Date.now()/1000,status:'running',messages:[
    {turnId,itemId:'user-'+turnId,role:'user',content,createdAt:now},
    {turnId,itemId:'stage-'+turnId,role:'assistant',content:'正在只读检查',createdAt:now},
  ],activities:[{turnId,itemId:'act-'+turnId,kind:'command',label:'检查',createdAt:now}]});
  const sync=(s:RemoteThreadSnapshotInput)=>db.importRemoteThread(LEGACY_USER_ID,project.id,project.executor_id,s,{model:'gpt-6-astra',reasoningEffort:'max'});
  return {root,db,project,conversation,now,id,job,workflow,snapshot,sync};
}

const personal='<pp_agent_personal_context>test-only-context</pp_agent_personal_context>';
const wait='<codex_web_wait_automation>test-only-wait</codex_web_wait_automation>';
const attachment='本轮附件：\n- sample.txt: C:\\qa\\uploads\\sample.txt';
const recovery:TaskRecoveryCheckpoint={version:1,jobId:'test',threadId:'thread',reason:'capacity',capturedAt:'2026-11-10T00:00:00Z',inputAccepted:true,goalExcerpt:'只读检查',lastEventSeq:0,updates:[],plan:[],files:[],actions:[],error:''};

test('real workflow instructions and mixed wrapper orders claim the original quoted message',t=>{
  const f=fixture(t,'只读检查','保留引用');
  const prompt=buildAskAgentDraft('只读检查','保留引用');
  for (const raw of [prompt+f.workflow, personal+'\n'+attachment+'\n\n'+withTaskRecoveryPrompt(prompt,recovery)+f.workflow+wait,
    f.workflow+wait+'\n'+prompt+'\n\n'+attachment+'\n'+personal]) {
    assert.equal(remoteUserMessageMatchesJob(raw,'只读检查','保留引用'),true);
    const result=f.sync(f.snapshot(raw));assert.equal(result.importedMessages,0);
    assert.deepEqual(f.db.listMessages(f.conversation.id).map(m=>[m.id,m.content,m.quote_excerpt]),[[f.id,'只读检查','保留引用']]);
    assert.deepEqual(f.db.listRemoteThreadActivities(f.conversation.id),[]);
  }
});

test('plain text needs no attachments; literal known/unknown/incomplete tags are not erased',t=>{
  const original='请分析 <pp_agent_complete_workflow>原文</pp_agent_complete_workflow>，保留 <unknown>和未闭合 <pp_agent_personal_context>';
  const f=fixture(t,original);assert.equal(remoteUserMessageMatchesJob(original+f.workflow,original),true);
  f.sync(f.snapshot(original+f.workflow));assert.equal(f.db.getMessage(f.id)?.content,original);
  assert.equal(remoteUserMessageMatchesJob('只读检查\n<unknown>新增要求</unknown>','只读检查'),false);
  assert.equal(remoteUserMessageMatchesJob('只读检查\n<pp_agent_complete_workflow>未闭合','只读检查'),false);
});

test('dispatch fingerprint recognizes future wrappers before accepted event without stripping display text',t=>{
  const f=fixture(t);const prompt='只读检查\n<future_execution>new context</future_execution>'+f.workflow;
  f.db.registerRemoteExecutionInput(f.job.id,prompt);
  const s=f.snapshot(attachment+'\n\n'+prompt);assert.equal(f.sync(s).importedMessages,0);
  assert.equal(f.db.listMessages(f.conversation.id).length,1);
});

test('accepted identity survives terminal cleanup and claims a completed first import',t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  f.db.updateJob(f.job.id,'completed');
  assert.equal(f.db.getJobAttemptState(f.job.id),undefined);
  assert.equal(f.sync({...f.snapshot('opaque future execution envelope'),status:'idle'}).importedMessages,0);
  assert.equal(f.db.listMessages(f.conversation.id).length,1);
});

test('late accepted identity repairs already-mapped copies atomically, preserves originals and audit, and refresh is idempotent',t=>{
  const f=fixture(t);const s=f.snapshot('opaque future execution envelope');
  assert.equal(f.sync(s).importedMessages,2);
  f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  assert.deepEqual(f.db.listMessages(f.conversation.id).map(m=>m.id),[f.id]);
  const audit=()=>f.db.sqlite.prepare('SELECT count(*) n FROM remote_import_repairs').get()!.n;
  const before=audit();assert.ok(Number(before)>=4);
  assert.equal(f.sync(s).importedMessages,0);assert.equal(f.sync(s).changed,false);assert.equal(audit(),before);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM messages WHERE is_internal=1').get()!.n,2);
});

test('completed history repair keeps canonical final, stage ownership, files and unchanged user data',t=>{
  const f=fixture(t);const s=f.snapshot('unrecognized for initial import');
  f.sync(s);
  const copied=f.db.listMessages(f.conversation.id).find(m=>m.content==='unrecognized for initial import')!;
  f.db.sqlite.prepare('UPDATE messages SET content=? WHERE id=?').run('只读检查'+f.workflow,copied.id);
  const finalId=crypto.randomUUID();f.db.addMessage({id:finalId,conversation_id:f.conversation.id,role:'assistant',content:'最终结果',created_at:new Date().toISOString()});
  f.db.appendEvent(f.job.id,'progress',{kind:'update',detail:'正在只读检查'});
  f.db.updateJob(f.job.id,'completed');
  f.sync({...s,status:'idle',messages:s.messages.map(i=>i.role==='user'?{...i,content:'只读检查'+f.workflow}:i)});
  assert.deepEqual(f.db.listMessages(f.conversation.id).map(m=>m.id),[f.id,finalId]);
  assert.equal(f.db.getMessage(copied.id)?.content,'只读检查'+f.workflow);
  assert.equal(f.db.getMessage(copied.id)?.is_internal,1);
});

for (const continuation of [MODEL_CAPACITY_CONTINUATION_PROMPT,UPSTREAM_ROUTING_CONTINUATION_PROMPT]) test('capacity/routing continuation with mixed wrappers stays internal: '+continuation.slice(0,18),t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','initial');
  const s=f.snapshot(personal+withTaskRecoveryPrompt(continuation,recovery,true)+f.workflow+wait,'retry');
  assert.equal(f.sync(s).importedMessages,0);assert.equal(f.db.listMessages(f.conversation.id).length,1);
});

test('independent desktop turns with identical text and literal wrappers remain two real sends',t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','original');
  f.sync(f.snapshot('只读检查'+f.workflow,'original'));
  const desktop=f.snapshot('只读检查','desktop');
  assert.equal(f.sync(desktop).importedMessages,2);
  const literal='<pp_agent_complete_workflow>这是用户引用的原文</pp_agent_complete_workflow>';
  const next=f.snapshot(literal,'desktop2');f.sync(next);f.sync(next);
  assert.equal(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').length,3);
  assert.ok(f.db.listMessages(f.conversation.id).some(m=>m.content===literal));
});

test('two real Jobs with identical requests are claimed only by their own accepted turns',t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','first');f.db.updateJob(f.job.id,'completed');f.db.workflows.settled(f.job.id);
  const second=crypto.randomUUID();f.db.addMessage({id:second,conversation_id:f.conversation.id,role:'user',content:'只读检查',created_at:f.now});
  const job=f.db.createJob(crypto.randomUUID(),f.conversation.id,second);f.db.updateJob(job.id,'running');f.db.recordRemoteControlledTurn(job.id,f.project.executor_id,'thread','second');
  f.sync({...f.snapshot('只读检查'),messages:[...f.snapshot('只读检查','first').messages,...f.snapshot('只读检查','second').messages]});
  assert.equal(f.db.listMessages(f.conversation.id).length,2);
  const rows=f.db.sqlite.prepare("SELECT turn_id,message_id FROM remote_thread_items WHERE role='user' ORDER BY turn_id").all();
  assert.deepEqual(rows.map(r=>[r.turn_id,r.message_id]),[['first',f.id],['second',second]]);
});

test('ambiguous historical identical turns and out-of-window desktop messages are not merged',t=>{
  const f=fixture(t);const a=f.snapshot('只读检查'+f.workflow,'a');const b=f.snapshot('只读检查'+f.workflow,'b');
  f.sync({...a,messages:[...a.messages,...b.messages],activities:[]});
  assert.equal(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').length,3);
  const old=f.snapshot('只读检查','old');old.messages.forEach(i=>i.createdAt='2020-01-01T00:00:00Z');f.sync(old);
  assert.equal(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').length,4);
});

test('startup backfills accepted turn, repairs historical wrapper, and reopening is idempotent',t=>{
  const f=fixture(t); const s=f.snapshot('initial unknown wrapper');f.sync(s);
  f.db.saveJobAttemptState(f.job.id,{retries:0,capacityStartedAt:null,nextAttemptAt:null,continuation:true,acceptedTurnId:'turn',contextRevision:null,outputs:[],images:[],imageThreadId:null});
  // Simulate a pre-upgrade database; migration must preserve the accepted ID.
  f.db.sqlite.exec("DELETE FROM schema_migrations WHERE version=2026111001; DROP TABLE remote_import_repairs; DROP TABLE remote_execution_inputs; DROP TABLE remote_steered_inputs; DROP TABLE remote_controlled_turns;");
  const upgraded=new AppDatabase(f.root,undefined,false);
  assert.equal(upgraded.listMessages(f.conversation.id).length,1);
  assert.equal(upgraded.sqlite.prepare('SELECT source FROM remote_controlled_turns').get()!.source,'accepted');
  const audits=upgraded.sqlite.prepare('SELECT count(*) n FROM remote_import_repairs').get()!.n;upgraded.close();
  const repeated=new AppDatabase(f.root,undefined,false);
  assert.equal(repeated.sqlite.prepare('SELECT count(*) n FROM remote_import_repairs').get()!.n,audits);repeated.close();
});

test('repair preserves attachment-bearing ambiguous copies and canonical attachments',t=>{
  const f=fixture(t);const s=f.snapshot('unknown wrapper');f.sync(s);
  const copy=f.db.listMessages(f.conversation.id).find(m=>m.content==='unknown wrapper')!;
  for (const mid of [copy.id,f.id]) f.db.sqlite.prepare(`INSERT INTO files(id,conversation_id,message_id,original_name,relative_path,mime_type,size,kind,created_at)
    VALUES(?,?,?,?,?,'text/plain',1,'upload',?)`).run(crypto.randomUUID(),f.conversation.id,mid,'sample.txt','uploads/'+mid+'.txt',f.now);
  f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  assert.equal(f.db.getMessage(copy.id)?.is_internal,0);
  assert.equal(f.db.listMessages(f.conversation.id).find(m=>m.id===f.id)?.files.length,1);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM files').get()!.n,2);
});

test('multiple real steering messages inside one controlled turn keep their original contents',t=>{
  const f=fixture(t);const s=f.snapshot('只读检查'+f.workflow);
  s.messages.push({turnId:'turn',itemId:'steer-1',role:'user',content:'补充要求',createdAt:f.now},{turnId:'turn',itemId:'steer-2',role:'user',content:'补充要求',createdAt:f.now});
  f.sync(s);f.sync(s);
  assert.deepEqual(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').map(m=>m.content).sort(),['只读检查','补充要求','补充要求'].sort());
  f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  assert.equal(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').length,3);
});

test('a historical canonical final mapped to a turn is not hidden just because it also has an update event',t=>{
  const f=fixture(t);f.sync(f.snapshot('只读检查'+f.workflow));
  const id=crypto.randomUUID();f.db.addMessage({id,conversation_id:f.conversation.id,role:'assistant',content:'唯一最终答复',created_at:new Date().toISOString()});
  f.db.sqlite.prepare(`INSERT INTO remote_thread_items(executor_id,thread_id,turn_id,item_id,conversation_id,message_id,role,created_at)
    VALUES(?,'thread','turn','canonical-final',?,?,'assistant',?)`).run(f.project.executor_id,f.conversation.id,id,f.now);
  f.db.appendEvent(f.job.id,'progress',{kind:'update',detail:'唯一最终答复'});f.db.updateJob(f.job.id,'completed');
  f.sync({...f.snapshot('只读检查'+f.workflow),status:'idle'});
  assert.equal(f.db.getMessage(id)?.is_internal,0);assert.ok(f.db.listMessages(f.conversation.id).some(m=>m.id===id));
});

test('acknowledged steer rebinds an early observer copy to its own quoted message, including attachments',t=>{
  const f=fixture(t);const quote='原文引用';const text='新的补充要求';
  const s=f.snapshot('只读检查'+f.workflow);s.messages.push({turnId:'turn',itemId:'steer',role:'user',content:'实时调整当前任务：'+buildAskAgentDraft(text,quote)+'\n\n补充附件：\n- sample.txt: C:\\qa\\sample.txt',createdAt:f.now});
  f.sync(s);
  const pending=f.db.createPendingPrompt(crypto.randomUUID(),f.conversation.id,text,{model:'gpt-6-astra',reasoningEffort:'max'},quote);
  const id=crypto.randomUUID();f.db.materializeSteeredPrompt(pending.id,id,{jobId:f.job.id,turnId:'turn'});
  f.sync(s);f.sync(s);
  const users=f.db.listMessages(f.conversation.id).filter(m=>m.role==='user');assert.equal(users.length,2);
  assert.equal(f.db.getMessage(id)?.content,text);assert.equal(f.db.getMessage(id)?.quote_excerpt,quote);
});

test('unique historical steering envelopes bind within the controlled Job but repeated ambiguous steers remain untouched',t=>{
  const f=fixture(t);const id=crypto.randomUUID();
  f.db.addMessage({id,conversation_id:f.conversation.id,role:'user',content:'历史补充',created_at:new Date().toISOString()});
  const s=f.snapshot('只读检查'+f.workflow);s.messages.push({turnId:'turn',itemId:'steer',role:'user',content:'实时调整当前任务：历史补充',createdAt:f.now});
  f.sync(s);f.sync(s);assert.equal(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').length,2);
  assert.equal(f.db.getMessage(id)?.content,'历史补充');
});

for (const initialPresent of [true,false]) test('a steer-only observer delta binds to its own acknowledged input and survives full replay: '+initialPresent,t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  const original=f.snapshot('只读检查'+f.workflow);if(initialPresent)f.sync(original);
  const pending=f.db.createPendingPrompt(crypto.randomUUID(),f.conversation.id,'增量补充',{model:'gpt-6-astra',reasoningEffort:'max'});
  const id=crypto.randomUUID();f.db.materializeSteeredPrompt(pending.id,id,{jobId:f.job.id,turnId:'turn'});
  const steer={turnId:'turn',itemId:'steer-delta',role:'user' as const,content:'实时调整当前任务：增量补充',createdAt:f.now};
  f.sync({...original,messages:[steer],activities:[]});
  const mapped=()=>f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE item_id='steer-delta'").get()?.message_id;
  assert.equal(mapped(),id);
  f.sync({...original,messages:[...original.messages,steer]});
  assert.equal(mapped(),id);assert.equal(f.db.getMessage(f.id)?.content,'只读检查');
});

test('a steer-only delta before acknowledgement keeps recoverable content and binds on acknowledgement',t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  const original=f.snapshot('只读检查'+f.workflow);f.sync(original);
  const steer={turnId:'turn',itemId:'early-steer',role:'user' as const,content:'实时调整当前任务：晚确认补充',createdAt:f.now};
  f.sync({...original,messages:[steer],activities:[]});
  const pending=f.db.createPendingPrompt(crypto.randomUUID(),f.conversation.id,'晚确认补充',{model:'gpt-6-astra',reasoningEffort:'max'});
  const id=crypto.randomUUID();f.db.materializeSteeredPrompt(pending.id,id,{jobId:f.job.id,turnId:'turn'});
  assert.equal(f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE item_id='early-steer'").get()?.message_id,id);
  assert.equal(f.db.getMessage(f.id)?.content,'只读检查');
  assert.equal(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').length,2);
});

for (const initialPresent of [true,false]) test('raw refresh repairs an existing steer alias without changing canonical input: '+initialPresent,t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  const original=f.snapshot('只读检查'+f.workflow);if(initialPresent)f.sync(original);
  const pending=f.db.createPendingPrompt(crypto.randomUUID(),f.conversation.id,'错绑补充',{model:'gpt-6-astra',reasoningEffort:'max'});
  const id=crypto.randomUUID();f.db.materializeSteeredPrompt(pending.id,id,{jobId:f.job.id,turnId:'turn'});
  f.db.sqlite.prepare(`INSERT INTO remote_thread_items(executor_id,thread_id,turn_id,item_id,conversation_id,message_id,role,created_at)
    VALUES(?,'thread','turn','old-steer',?,?,'user',?)`).run(f.project.executor_id,f.conversation.id,f.id,f.now);
  const steer={turnId:'turn',itemId:'old-steer',role:'user' as const,content:'实时调整当前任务：错绑补充',createdAt:f.now};
  const full={...original,messages:[...original.messages,steer]};f.sync(full);
  assert.equal(f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE item_id='old-steer'").get()?.message_id,id);
  assert.equal(f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE item_id='user-turn'").get()?.message_id,f.id);
  assert.equal(f.db.getMessage(f.id)?.content,'只读检查');assert.equal(f.db.getMessage(f.id)?.is_internal,0);
  assert.equal(f.db.getMessage(id)?.content,'错绑补充');assert.equal(f.sync(full).changed,false);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM remote_import_repairs WHERE reason='refresh_steer_mapping'").get()?.n,1);
});

test('a literal steering prefix in the original and genuine later identical deltas stay separate',t=>{
  const text='实时调整当前任务：这是原始用户文本';const f=fixture(t,text);
  f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');const original=f.snapshot(text+f.workflow);f.sync(original);
  for(const itemId of ['desktop-extra-1','desktop-extra-2'])f.sync({...original,messages:[{turnId:'turn',itemId,role:'user',content:'桌面补充',createdAt:f.now}],activities:[]});
  assert.equal(f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE item_id='user-turn'").get()?.message_id,f.id);
  assert.deepEqual(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').map(m=>m.content).sort(),[text,'桌面补充','桌面补充'].sort());
});

test('steering item IDs are scoped to their turn when two turns reuse fallback IDs',t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  f.db.updateJob(f.job.id,'completed');f.db.workflows.settled(f.job.id);
  const nextId=crypto.randomUUID();f.db.addMessage({id:nextId,conversation_id:f.conversation.id,role:'user',content:'第二轮原文',created_at:f.now});
  const next=f.db.createJob(crypto.randomUUID(),f.conversation.id,nextId);f.db.updateJob(next.id,'running');
  f.db.recordRemoteControlledTurn(next.id,f.project.executor_id,'thread','turn2');
  const steering=[] as Array<{turnId:string;id:string;text:string}>;
  for(const [turnId,jobId,text] of [['turn',f.job.id,'第一轮补充'],['turn2',next.id,'第二轮补充']]) {
    const pending=f.db.createPendingPrompt(crypto.randomUUID(),f.conversation.id,text,{model:'gpt-6-astra',reasoningEffort:'max'});
    const id=crypto.randomUUID();f.db.materializeSteeredPrompt(pending.id,id,{jobId,turnId});steering.push({turnId,id,text});
  }
  const base=f.snapshot('只读检查'+f.workflow);
  f.sync({...base,messages:[
    {turnId:'turn',itemId:'user-0',role:'user',content:'只读检查'+f.workflow,createdAt:f.now},
    {turnId:'turn2',itemId:'user-0',role:'user',content:'第二轮原文',createdAt:f.now},
    ...steering.map(s=>({turnId:s.turnId,itemId:'user-5',role:'user' as const,content:'实时调整当前任务：'+s.text,createdAt:f.now})),
  ]});
  for(const s of steering)assert.equal(f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE turn_id=? AND item_id='user-5'").get(s.turnId)?.message_id,s.id);
  assert.equal(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').length,4);
});

test('raw steer refresh leaves a different attachment-bearing mapped message intact',t=>{
  const f=fixture(t);f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  const original=f.snapshot('只读检查'+f.workflow);f.sync(original);
  const pending=f.db.createPendingPrompt(crypto.randomUUID(),f.conversation.id,'补充',{model:'gpt-6-astra',reasoningEffort:'max'});
  const id=crypto.randomUUID();f.db.materializeSteeredPrompt(pending.id,id,{jobId:f.job.id,turnId:'turn'});
  const protectedId=crypto.randomUUID();f.db.addMessage({id:protectedId,conversation_id:f.conversation.id,role:'user',content:'带附件待核实',created_at:f.now});
  f.db.sqlite.prepare(`INSERT INTO files(id,conversation_id,message_id,original_name,relative_path,mime_type,size,kind,created_at)
    VALUES(?,?,?,?,?,'text/plain',1,'upload',?)`).run(crypto.randomUUID(),f.conversation.id,protectedId,'sample.txt','uploads/protected.txt',f.now);
  f.db.sqlite.prepare(`INSERT INTO remote_thread_items(executor_id,thread_id,turn_id,item_id,conversation_id,message_id,role,created_at)
    VALUES(?,'thread','turn','protected-steer',?,?,'user',?)`).run(f.project.executor_id,f.conversation.id,protectedId,f.now);
  f.sync({...original,messages:[...original.messages,{turnId:'turn',itemId:'protected-steer',role:'user',content:'实时调整当前任务：补充',createdAt:f.now}]});
  assert.equal(f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE item_id='protected-steer'").get()?.message_id,protectedId);
  assert.equal(f.db.getMessage(protectedId)?.is_internal,0);
  assert.equal(f.db.getMessage(protectedId)?.content,'带附件待核实');
  assert.equal(f.db.sqlite.prepare('SELECT message_id FROM files').get()?.message_id,protectedId);
});

test('a concurrent identical desktop send cannot claim a newly dispatched wrapped input before acceptance',t=>{
  const f=fixture(t);f.db.registerRemoteExecutionInput(f.job.id,'只读检查'+f.workflow);
  const desktop=f.snapshot('只读检查','desktop');const controlled=f.snapshot('只读检查'+f.workflow,'owned');
  f.sync({...controlled,messages:[...desktop.messages,...controlled.messages]});
  assert.equal(f.db.listMessages(f.conversation.id).filter(m=>m.role==='user').length,2);
  const map=f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE turn_id='owned' AND role='user'").get();assert.equal(map?.message_id,f.id);
  assert.notEqual(f.db.sqlite.prepare("SELECT message_id FROM remote_thread_items WHERE turn_id='desktop' AND role='user'").get()?.message_id,f.id);
});

test('independent desktop thread quoting the continuation text is not an internal execution',t=>{
  const f=fixture(t);const s=f.snapshot(MODEL_CAPACITY_CONTINUATION_PROMPT);s.id='independent-desktop';
  const imported=f.sync(s);assert.equal(imported.importedMessages,2);
  assert.equal(f.db.listMessages(imported.conversation.id).find(m=>m.role==='user')?.content,MODEL_CAPACITY_CONTINUATION_PROMPT);
});

test('quarantining an observer copy rebinds its unread navigation anchor',t=>{
  const f=fixture(t);f.sync(f.snapshot('unknown envelope'));
  const copy=f.db.listMessages(f.conversation.id).find(m=>m.content==='unknown envelope')!;
  f.db.sqlite.prepare('UPDATE conversations SET unread_anchor_message_id=? WHERE id=?').run(copy.id,f.conversation.id);
  f.db.recordRemoteControlledTurn(f.job.id,f.project.executor_id,'thread','turn');
  assert.equal(f.db.getConversation(f.conversation.id)?.unread_anchor_message_id,f.id);
});

test('cancelled turn keeps a possibly final imported reply even when a separate cancellation notice exists',t=>{
  const f=fixture(t);f.sync(f.snapshot('只读检查'+f.workflow));
  const id=crypto.randomUUID();f.db.addMessage({id,conversation_id:f.conversation.id,role:'assistant',content:'已有执行结果',created_at:new Date().toISOString()});
  f.db.sqlite.prepare(`INSERT INTO remote_thread_items(executor_id,thread_id,turn_id,item_id,conversation_id,message_id,role,created_at)
    VALUES(?,'thread','turn','possible-final',?,?,'assistant',?)`).run(f.project.executor_id,f.conversation.id,id,f.now);
  f.db.addMessage({id:crypto.randomUUID(),conversation_id:f.conversation.id,role:'assistant',content:'用户已停止任务',created_at:new Date().toISOString()});
  f.db.appendEvent(f.job.id,'progress',{kind:'update',detail:'已有执行结果'});f.db.updateJob(f.job.id,'cancelled');
  f.sync({...f.snapshot('只读检查'+f.workflow),status:'idle'});assert.equal(f.db.getMessage(id)?.is_internal,0);
});
