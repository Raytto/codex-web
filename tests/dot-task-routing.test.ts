import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID as id } from 'node:crypto';
import { routeDotTask, loadDotRoutingPolicy, DOT_ROUTING_INSTRUCTIONS, type DotRoutingCatalog } from '../server/dot-task-routing.js';
import type { AgentModelOption } from '../server/model-options.js';
import { AppDatabase, LEGACY_USER_ID } from '../server/db.js';
import { HOST_ROOT_USER_ID as user } from '../server/host-root-user.js';
import { DOT_TOOL_SPEC } from '../server/dot-tool.js';
import { DotStore, DOT_INSTRUCTIONS } from '../server/dot-store.js';
import { dotAction } from '../server/dot-routes.js';
import { ConversationVoiceScope } from '../server/conversation-voice.js';
const model = (id: string, reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']): AgentModelOption => ({id, label:id, description:'fixture', reasoningEfforts, defaultReasoningEffort:'medium'});
const catalog: DotRoutingCatalog = {status:'online', models:[model('gpt-6-astra'), model('gpt-6.1-sol'), model('gpt-6-sol'), model('gpt-6-luna'), model('antigravity:gemini-4-argon',['low','medium','high']), model('antigravity:gemini-3.8-flash',['low','medium','high']), model('antigravity:claude-opus-5',['high'])]};
const policy = {youtube:{model:'antigravity:gemini-4-argon',reasoningEffort:'high'},gemini_specialist:{model:'antigravity:gemini-4-argon',reasoningEffort:'high'}};
catalog.defaultSelection={model:'gpt-6-luna',reasoningEffort:'medium'};
test('default uses the actual node selection for every intent, never a private engine ranking',()=>{
 for(const taskType of ['general','youtube','web_research'] as const) assert.deepEqual(routeDotTask({taskType},catalog,{}).selection,catalog.defaultSelection);
 assert.deepEqual(routeDotTask({taskType:'youtube'},catalog,policy).selection,policy.youtube);
});
test('explicit user selection wins; unavailable model/effort/offline node fail without fallback',()=>{
 assert.equal(routeDotTask({model:'gpt-6-astra',reasoningEffort:'max'},catalog,policy).selection.reasoningEffort,'max');
 assert.throws(()=>routeDotTask({model:'missing'},catalog,{}),/不可用/);
 assert.throws(()=>routeDotTask({model:'antigravity:gemini-4-argon',reasoningEffort:'ultra'},catalog,{}),/深度/);
 assert.throws(()=>routeDotTask({}, {...catalog,status:'offline'},{}),/不在线/);
 assert.throws(()=>routeDotTask({}, {...catalog,defaultSelection:undefined},{}),/不可用/);
});
function fixture(t: test.TestContext) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dot-routing-')), db=new AppDatabase(root);
 db.createUser({id:user,username:'test-host',display_name:'fixture',password_hash:'fixture',role:'owner',status:'active',created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
 const project=db.createProject(id(),user,'manage',root,'local-host');
 const original={model:'gpt-6-astra',reasoningEffort:'max'},store=new DotStore(db,()=>original);
 const dot=store.init(user),source=id();db.addMessage({id:source,conversation_id:dot.id,role:'user',content:'authorized routing fixture',created_at:new Date().toISOString()});
 const hooks={changed:()=>{},cancel:()=>false};let refreshes=0;
 store.refreshTaskCatalog=async()=>{refreshes++;};store.routeTask=(_u,_e,i)=>routeDotTask(i,catalog,policy);
 const body={requestKey:id(),projectId:project.id,title:'fixture',prompt:'只检查路由',sourceId:source,taskType:'youtube',difficulty:'standard'};
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});return {db,store,project,dot,source,body,original,hooks,refreshes:()=>refreshes};
}
test('API creation refreshes target catalog without UI, persists exact selection/reason, repeat after offline returns original once',async t=>{
 const f=fixture(t);const first=await dotAction(f.store,user,'task_create','',f.body,f.hooks) as any;
 assert.equal(f.refreshes(),1);assert.equal(first.task.routing.selection.model,'antigravity:gemini-4-argon');
 const c=f.db.getConversation(first.task.conversation_id)!;assert.equal(c.project_id,f.project.id);assert.equal(c.agent_model,'antigravity:gemini-4-argon');
 assert.equal(f.db.listPendingPrompts(c.id)[0]!.reasoning_effort,'high');
 assert.match(f.db.listPendingPrompts(c.id)[0]!.content,/仅字幕不得声称观看/);
 f.store.refreshTaskCatalog=async()=>{throw Error('offline');};f.store.routeTask=()=>{throw Error('catalog changed');};
 const again=await dotAction(f.store,user,'task_create','',f.body,f.hooks);assert.deepEqual(again,first);
 assert.equal(f.store.tasks(user).length,1);assert.equal(f.db.listPendingPrompts(c.id).length,1);
 await assert.rejects(dotAction(f.store,user,'task_create','',{...f.body,prompt:'different'},f.hooks),/重复请求内容/);
 assert.match(String(f.store.sql.prepare("SELECT content FROM dot_events WHERE kind='task_created'").get()!.content),/codex-web-task-routing-v1/);
});
test('unavailable/explicit-invalid selection rolls back all writes; owner and user source remain required',async t=>{
 const f=fixture(t);f.store.routeTask=(_u,_e,i)=>routeDotTask(i,{...catalog,status:'offline'});
 await assert.rejects(dotAction(f.store,user,'task_create','',f.body,f.hooks),/不在线/);assert.equal(f.store.tasks(user).length,0);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM dot_operations').get()!.n,0);
 await assert.rejects(dotAction(f.store,LEGACY_USER_ID,'task_create','',f.body,f.hooks),/仅对/);
 await assert.rejects(dotAction(f.store,user,'task_create','',{...f.body,sourceId:id()},f.hooks),/真实用户/);
});
test('text and voice Dot sources use identical policy; coordinator and ordinary explicit selection/thread remain unchanged',async t=>{
 const f=fixture(t);const before=f.db.getConversation(f.dot.id);const voiceSource=id();f.store.event(user,'voice_user',voiceSource,'research fixture');
 const a=f.store.createTask(user,f.body),b=f.store.createTask(user,{...f.body,requestKey:id(),sourceId:voiceSource});
 assert.deepEqual(a.routing,b.routing);assert.deepEqual(f.db.getConversation(f.dot.id),before);
 assert.ok(DOT_INSTRUCTIONS.includes(DOT_ROUTING_INSTRUCTIONS));assert.ok(f.store.context(user).instructions.includes(DOT_ROUTING_INSTRUCTIONS));
 const ordinary=f.db.createConversation(id(),'same project explicit model',f.original,user,f.project.id);
 f.db.sqlite.prepare('UPDATE conversations SET codex_thread_id=? WHERE id=?').run('original-native',ordinary.id);
 const scope=new ConversationVoiceScope(f.store,user,ordinary.id,{eligibility:()=>null,selection:()=>f.original,steer:async()=>({mode:'queued_next_turn',message:'queued'}),cancel:()=>false,changed:()=>{}});
 scope.record('user','研究 YouTube');await scope.delegate('request');await scope.delegate('request');
 const pending=f.db.listPendingPrompts(ordinary.id);assert.equal(pending.length,1);assert.equal(pending[0]!.agent_model,f.original.model);assert.equal(pending[0]!.reasoning_effort,'max');assert.equal(f.db.getConversation(ordinary.id)?.codex_thread_id,'original-native');
});
test('other Gemini specialist work requires an actual capability rationale',()=>{
 assert.throws(()=>routeDotTask({taskType:'gemini_specialist'},catalog),/能力依据/);
 const result=routeDotTask({taskType:'gemini_specialist',capabilityReason:'fixture: selected-node tool has verified media access'},catalog,policy);
 assert.equal(result.selection.model,'antigravity:gemini-4-argon');assert.match(result.reason,/verified media access/);
});
test('read-only preview uses the same fresh selection as creation without mutation',async t=>{
 const f=fixture(t);const body={projectId:f.project.id,taskType:'youtube',difficulty:'standard'};
 const preview=await dotAction(f.store,user,'task_preview','',body,f.hooks) as any;
 assert.equal(preview.dispatched,false);assert.equal(preview.executorId,'local-host');assert.equal(f.store.tasks(user).length,0);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM dot_operations').get()!.n,0);
 const result=await dotAction(f.store,user,'task_create','',f.body,f.hooks) as any;assert.deepEqual(result.task.routing,preview.routing);
});
test('project relocation during catalog refresh refuses new writes instead of routing with stale node data',async t=>{
 const f=fixture(t);f.store.refreshTaskCatalog=async()=>{f.db.sqlite.prepare("UPDATE projects SET executor_id='other-node' WHERE id=?").run(f.project.id);};
 await assert.rejects(dotAction(f.store,user,'task_create','',f.body,f.hooks),/执行位置已变化/);assert.equal(f.store.tasks(user).length,0);
});

test('coordinator tool exposes the read-only preview advertised by context',()=>{
 assert.ok(DOT_TOOL_SPEC.inputSchema.properties.action.enum.includes('task_preview'));
});

test('operator routing configuration rejects malformed and unsupported entries',()=>{
 assert.deepEqual(loadDotRoutingPolicy('{}'),{});
 assert.throws(()=>loadDotRoutingPolicy('[]'));
 assert.throws(()=>loadDotRoutingPolicy('{"unknown":{"model":"x","reasoningEffort":"low"}}'));
 assert.throws(()=>loadDotRoutingPolicy('{"general":{"model":"x"}}'));
 assert.equal(loadDotRoutingPolicy('{"general:simple":{"model":"fixture","reasoningEffort":"low"}}')['general:simple']!.model,'fixture');
});
