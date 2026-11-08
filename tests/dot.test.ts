import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { AppDatabase, LEGACY_USER_ID } from '../server/db.js';
import { HOST_ROOT_USER_ID as user } from '../server/host-root-user.js';
import { DotStore } from '../server/dot-store.js';
import { dotAction } from '../server/dot-routes.js';
import { projectDot } from '../server/dot-projection.js';
import { selectCodexEgress, probeOpenAIConnect } from '../server/codex-egress.js';
import { retainSelectedConversation } from '../src/conversation-search.js';
import type { Conversation } from '../src/api.js';
const id = () => crypto.randomUUID(), selection = { model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
function fixture(t: test.TestContext) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-test-')), db = new AppDatabase(root); db.createUser({ id: user, username: 'test-host', display_name: 'test', password_hash: 'test', role: 'owner', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); const p = db.createProject(id(), user, 'coordinator-project', '/example/coordinator', 'local-host'), target = db.createProject(id(), user, 'test-target', root, 'worker:test'); const store = new DotStore(db, () => selection); const c = store.init(user); const source = id(); db.addMessage({ id: source, conversation_id: c.id, role: 'user', content: '记住测试色是蓝色；在目标项目生成隔离测试文件。', created_at: new Date().toISOString() }); t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); }); return { root, db, store, p, target, c, source }; }
test('project pages omit only the bound Dot coordinator, with consistent counts and pagination', t => {
    const f = fixture(t);
    const original = f.db.getConversation(f.c.id);
    assert.equal(original?.is_dot_coordinator, 1);
    assert.equal(f.db.listConversationPage(user, { projectId: f.p.id }).total, 0);
    assert.equal(f.db.listProjects(user).find(p => p.id === f.p.id)?.conversation_count, 0);
    const sameName = f.db.createConversation(id(), 'PP Dot', selection, user, f.p.id);
    const other = f.db.createConversation(id(), 'Other task', selection, user, f.p.id);
    const otherProject = f.db.createConversation(id(), 'PP Dot', selection, user, f.target.id);
    const first = f.db.listConversationPage(user, { projectId: f.p.id, limit: 1 });
    const second = f.db.listConversationPage(user, { projectId: f.p.id, limit: 1, offset: first.nextOffset! });
    assert.equal(first.total, 2);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
    assert.deepEqual(new Set([...first.conversations, ...second.conversations].map(c => c.id)), new Set([sameName.id, other.id]));
    assert.equal(sameName.is_dot_coordinator, 0);
    assert.equal(f.db.listProjects(user).find(p => p.id === f.p.id)?.conversation_count, 2);
    assert.deepEqual(f.db.listConversationPage(user, { projectId: f.target.id }).conversations.map(c => c.id), [otherProject.id]);
    assert.equal(f.db.listConversationPage(user, { projectId: f.p.id, query: 'PP Dot' }).total, 2);
    assert.ok(f.db.listConversationPage(user).conversations.some(c => c.id === f.c.id));
    assert.deepEqual(f.db.getConversation(f.c.id), original);
    assert.equal(f.store.init(user).id, f.c.id);
    assert.equal(f.db.getProject(f.p.id)?.root_path, '/example/coordinator');
});
test('selected Dot detail cannot repopulate a normal project page, while search and same-title selection remain', () => {
    const dot = { id: 'bound-dot', project_id: 'manage', title: 'PP Dot', is_dot_coordinator: 1 } as Conversation;
    const ordinary = { ...dot, id: 'ordinary-dot', is_dot_coordinator: 0 };
    const page = { conversations: [], total: 0, hasMore: false, nextOffset: null };
    assert.equal(retainSelectedConversation(page, dot, 'manage', { excludeDotCoordinator: true }), page);
    assert.deepEqual(retainSelectedConversation(page, ordinary, 'manage', { excludeDotCoordinator: true }).conversations, [ordinary]);
    assert.deepEqual(retainSelectedConversation(page, dot, 'manage').conversations, [dot]);
});
test('Dot singleton and foreign owner/coordinator isolation', t => { const f = fixture(t); assert.equal(f.store.init(user).id, f.c.id); assert.throws(() => f.store.init(LEGACY_USER_ID), /仅对/); const second = new AppDatabase(f.root, undefined, false); try {
    assert.equal(new DotStore(second, () => selection).init(user).id, f.c.id);
}
finally {
    second.close();
} assert.throws(() => f.store.requireCoordinator(user, id()), /只有/); assert.throws(() => f.store.source(user, id()), /真实用户/); });
test('task creation atomically queues target executor, retries do not duplicate, conflicting key rejected', t => { const f = fixture(t); const body = { requestKey: id(), projectId: f.target.id, title: 'fixture', prompt: '只在目标目录生成测试文件', sourceId: f.source }; const a = f.store.createTask(user, body), b = f.store.createTask(user, body); assert.equal(a.id, b.id); assert.equal(f.db.getConversation(a.conversation_id)?.project_id, f.target.id); assert.equal(a.executor_id, 'worker:test'); assert.equal(f.db.listPendingPrompts(a.conversation_id).length, 1); assert.throws(() => f.store.createTask(user, { ...body, prompt: 'different' }), /重复请求/); const old = f.db.createPendingPrompt; f.db.createPendingPrompt = () => { throw Error('injected disk failure'); }; assert.throws(() => f.store.createTask(user, { ...body, requestKey: id() }), /injected/); f.db.createPendingPrompt = old; assert.equal(f.store.tasks(user).length, 1); });
test('correction revision and actual Job status, cancellation before materialization', async t => { const f = fixture(t); const task = f.store.createTask(user, { requestKey: id(), projectId: f.target.id, title: 'fixture', prompt: 'test', sourceId: f.source }); const b = { requestKey: id(), revision: 1, content: '改成只读', sourceId: f.source }; const changed = f.store.correctTask(user, task.id, b); assert.equal(changed.mode, 'queued_next_turn'); assert.equal(changed.task.revision, 2); assert.equal(f.store.correctTask(user, task.id, b).pendingId, changed.pendingId); assert.throws(() => f.store.correctTask(user, task.id, { ...b, requestKey: id() }), /版本/); await dotAction(f.store, user, 'task_cancel', task.id, { requestKey: id(), revision: 2 }, { changed: () => { }, cancel: () => false }); assert.equal(f.store.task(user, task.id).state, 'cancelled'); assert.equal(f.db.listPendingPrompts(task.conversation_id).length, 0); });
test('memory correction survives checkpoints, forget removes memory/summary but not raw history', t => { const f = fixture(t); const a = f.store.memory(user, { requestKey: id(), content: '测试色为蓝色', sourceId: f.source, state: 'confirmed' }); const source = id(); f.db.addMessage({ id: source, conversation_id: f.c.id, role: 'user', content: '改成绿色', created_at: new Date().toISOString() }); const b = f.store.memory(user, { requestKey: id(), id: a.id, revision: a.revision, content: '测试色为绿色', sourceId: source, state: 'confirmed' }); for (let i = 0; i < 3; i++)
    assert.match(f.store.checkpoint(user).text, /绿色/); assert.throws(() => f.store.memory(user, { requestKey: id(), id: a.id, revision: a.revision, content: 'stale', sourceId: source }), /版本/); f.store.memory(user, { requestKey: id(), id: a.id, revision: b.revision, sourceId: source }, true); assert.equal(f.store.memories(user).length, 0); assert.doesNotMatch(f.store.checkpoint(user).text, /蓝色|绿色/); assert.ok(f.db.getMessage(f.source)); assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM dot_checkpoints').get()?.n, 1); });
test('projection preserves manual edits and contains only coordination data', t => { const f = fixture(t); const old = process.env.PP_DOT_PROJECTION_DIR; process.env.PP_DOT_PROJECTION_DIR = f.root; t.after(() => { if (old === undefined)
    delete process.env.PP_DOT_PROJECTION_DIR;
else
    process.env.PP_DOT_PROJECTION_DIR = old; }); assert.equal(projectDot(f.store, user).ok, true); fs.writeFileSync(path.join(f.root, 'tasks.md'), 'manual note'); f.store.createTask(user, { requestKey: id(), projectId: f.target.id, title: 'fixture', prompt: 'test', sourceId: f.source }); assert.equal(projectDot(f.store, user).ok, false); assert.equal(fs.readFileSync(path.join(f.root, 'tasks.md'), 'utf8'), 'manual note'); });
test('isolated proxy failure never selects direct fallback', async () => { let count = 0; const server = http.createServer(); server.on('connect', (_r, s) => { count++; s.end('HTTP/1.1 502 Test Failure\r\nConnection: close\r\n\r\n'); }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); try {
    const port = (server.address() as {
        port: number;
    }).port, url = `http://127.0.0.1:${port}`, signal = AbortSignal.timeout(5000);
    const choice = await selectCodexEgress({ primaryProxyUrl: url, backupProxyUrl: url, signal });
    assert.equal(choice.kind, 'backup');
    await assert.rejects(probeOpenAIConnect(choice.proxyUrl!, 1000, signal), /HTTP 502/);
    assert.equal(count, 2);
}
finally {
    await new Promise<void>(r => server.close(() => r()));
} });

test('duplicate cancellation is pinned to original jobs and leaves a later turn alone',async t=>{
 const f=fixture(t),task=f.store.createTask(user,{requestKey:id(),projectId:f.target.id,title:'cancel',prompt:'fixture',sourceId:f.source});
 const pending=f.db.listPendingPrompts(task.conversation_id)[0]!;
 const job=f.db.materializePendingPrompt(pending.id,id(),id())!;
 f.db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
 const stopped:string[]=[],hooks={changed:()=>{},cancel:(j:string)=>{stopped.push(j);return true}};
 const body={requestKey:id(),revision:1};await dotAction(f.store,user,'task_cancel',task.id,body,hooks);
 assert.equal(f.store.task(user,task.id).state,'cancel_requested');
 f.db.sqlite.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);f.db.workflows.settled(job.id);
 const newer=f.db.createJob(id(),task.conversation_id,undefined,selection);f.db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(newer.id);
 await dotAction(f.store,user,'task_cancel',task.id,body,hooks);assert.deepEqual(stopped,[job.id]);
});

test('real Job completion queues one coordinator review, stale review rejected and waiting remains in context',t=>{
 const f=fixture(t),task=f.store.createTask(user,{requestKey:id(),projectId:f.target.id,title:'review',prompt:'test',sourceId:f.source}),pending=f.db.listPendingPrompts(task.conversation_id)[0]!;
 const job=f.db.materializePendingPrompt(pending.id,id(),id())!,source=id();
 f.db.addMessage({id:source,conversation_id:task.conversation_id,role:'assistant',content:'需要用户指定要读的文件，尚未完成。',created_at:new Date().toISOString()});f.db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id);
 f.store.reconcile(user);f.store.reconcile(user);assert.equal(f.db.listPendingPrompts(f.c.id).length,1);
 const reviewed=f.store.reviewTask(user,task.id,{requestKey:id(),revision:1,jobId:job.id,sourceId:source,state:'waiting_user',summary:'等待明确文件'});
 assert.equal(reviewed.review_state,'waiting_user');assert.match(f.store.checkpoint(user).text,/waiting_user/);
 f.store.correctTask(user,task.id,{requestKey:id(),revision:1,sourceId:f.source,content:'补充具体文件'});
 assert.throws(()=>f.store.reviewTask(user,task.id,{requestKey:id(),revision:1,jobId:job.id,sourceId:source,state:'completed',summary:'旧版回报'}),/取代/);
});

test('Dot preference preserves explicit false across old-client writes, conflicts, restart and singleton entry', t => {
    const f = fixture(t), original = f.db.getConversation(f.c.id);
    const initial = f.db.getFeatureSelection(user);
    assert.equal(initial.ppDot, true);
    const hidden = f.db.setFeatureSelection(user, { ...initial, ppDot: false })!;
    assert.equal(hidden.ppDot, false);
    const oldClient = f.db.setFeatureSelection(user, { paraBoard: true, revision: hidden.revision })!;
    assert.equal(oldClient.ppDot, false);
    assert.equal(f.db.setFeatureSelection(user, { ...initial, ppDot: true }), null);
    const reopened = new AppDatabase(f.root, undefined, false);
    try { assert.equal(reopened.getFeatureSelection(user).ppDot, false); }
    finally { reopened.close(); }
    assert.equal(f.store.init(user).id, f.c.id);
    assert.equal(f.db.getFeatureSelection(user).ppDot, false);
    assert.equal(f.db.getFeatureSelection(LEGACY_USER_ID).ppDot, undefined);
    assert.equal(f.db.setFeatureSelection(user, { ...oldClient, ppDot: true })?.ppDot, true);
    assert.deepEqual(f.db.getConversation(f.c.id), original);
});

test('fixed Dot cannot be archived or reused as an ordinary empty task, while same-title conversations stay manageable', t => {
    const f = fixture(t), before = f.db.getConversation(f.c.id), project = f.db.getProject(f.p.id);
    assert.equal(f.db.projectHasDotCoordinator(f.p.id, user), true);
    assert.equal(f.db.projectHasDotCoordinator(f.p.id, LEGACY_USER_ID), false);
    assert.equal(f.db.archiveConversationForUser(f.c.id, user), undefined);
    assert.equal(f.db.archiveProjectForUser(f.p.id, user), undefined);
    assert.deepEqual(f.db.getConversation(f.c.id), before);
    assert.deepEqual(f.db.getProject(f.p.id), project);
    const same = f.db.createConversation(id(), 'PP Dot', selection, user, f.p.id);
    assert.ok(f.db.archiveConversationForUser(same.id, user)?.archived_at);
    assert.ok(f.db.archiveProjectForUser(f.target.id, user)?.archived_at);
    f.db.sqlite.prepare('DELETE FROM messages WHERE conversation_id=?').run(f.c.id);
    f.db.sqlite.prepare("UPDATE conversations SET title='新任务',title_source='default' WHERE id=?").run(f.c.id);
    assert.equal(f.db.findReusableEmptyConversation(user, f.p.id), undefined);
    const ordinary = f.db.createConversation(id(), '新任务', selection, user, f.p.id);
    assert.equal(f.db.findReusableEmptyConversation(user, f.p.id)?.id, ordinary.id);
});
