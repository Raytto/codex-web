import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID, type RemoteThreadSnapshotInput } from "../server/db.js";
import { bindEngineSession, recordEngineNativeId } from "../server/agent-engine-sessions.js";
import { CodexRunner } from "../server/codex-runner.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { loadConfig } from "../server/config.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-db-integration-"));
  const db = new AppDatabase(path.join(root, "data"), undefined, false);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const executorId = `remote:${crypto.randomUUID()}`;
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "Shared project", path.join(root, "project"), executorId);
  const conversation = db.createConversation(crypto.randomUUID(), "Visible conversation", { model: "codex-test", reasoningEffort: "high" }, LEGACY_USER_ID, project.id);
  const oldCodex = crypto.randomUUID(); db.updateConversation(conversation.id, { codexThreadId: oldCodex });
  function bind(engine: "codex" | "antigravity", accountId = engine === "codex" ? "codex-default" : "google-one") {
    const jobId = crypto.randomUUID(), messageId = crypto.randomUUID();
    db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: `Run ${engine}`, created_at: new Date().toISOString() });
    db.createJob(jobId, conversation.id, messageId, { model: engine === "codex" ? "codex-test" : "antigravity:gemini-test", reasoningEffort: "high" });
    const result = bindEngineSession(db.sqlite, { conversationId: conversation.id, jobId, engine, accountId, executorId, legacyCodexThreadId: db.getConversation(conversation.id)!.codex_thread_id });
    db.updateJob(jobId, "completed");
    return { ...result, jobId };
  }
  const usage = (threadId: string, inputTokens: number) => db.setConversationContextUsage(conversation.id, { threadId, inputTokens, modelContextWindow: 100_000 });
  const thread = (id: string, suffix: string): RemoteThreadSnapshotInput => ({ id, name: `Observer ${suffix}`, nameSource: "explicit", createdAt: 1_800_000_000, updatedAt: 1_800_000_100, status: "running", messages: [{ turnId: `turn-${suffix}`, itemId: `item-${suffix}`, role: "assistant", content: `Observed ${suffix}`, createdAt: "2027-01-15T08:00:00.000Z" }], activities: [{ turnId: `turn-${suffix}`, itemId: `activity-${suffix}`, kind: "command", label: `Command ${suffix}`, createdAt: "2027-01-15T08:00:00.000Z" }] });
  return { root, db, project, conversation, executorId, oldCodex, bind, usage, thread };
}

test("real schema keeps existing Codex resume/context behavior and binds job foreign keys", t => {
  const f = fixture(t);
  assert.equal(f.usage(f.oldCodex, 10), true);
  const first = f.bind("codex");
  assert.equal(first.session.native_id, f.oldCodex); assert.equal(first.handoff, false);
  assert.equal(f.db.getConversation(f.conversation.id)!.context_input_tokens, 10);
  const second = f.bind("codex"); assert.equal(second.session.id, first.session.id);
  assert.equal(f.usage(f.oldCodex, 25), true); assert.equal(f.usage(crypto.randomUUID(), 999), false);
  assert.equal(f.db.getConversation(f.conversation.id)!.context_input_tokens, 25);
  assert.equal((f.db.sqlite.prepare("SELECT count(*) AS n FROM agent_job_sessions").get() as { n: number }).n, 2);
  assert.deepEqual(f.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("legacy Codex conversations in different projects can resume their shared native thread", t => {
  const f = fixture(t), first = f.bind("codex");
  const project = f.db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "Other project", path.join(f.root, "other"), f.executorId);
  const conversation = f.db.createConversation(crypto.randomUUID(), "Other visible reference", undefined, LEGACY_USER_ID, project.id);
  f.db.updateConversation(conversation.id, { codexThreadId: f.oldCodex });
  const bindSibling = () => {
    const jobId = crypto.randomUUID();
    f.db.createJob(jobId, conversation.id, undefined, { model: "codex-test", reasoningEffort: "high" });
    const result = bindEngineSession(f.db.sqlite, { conversationId: conversation.id, jobId, engine: "codex", accountId: "codex-default", executorId: f.executorId, legacyCodexThreadId: f.oldCodex });
    f.db.updateJob(jobId, "completed");
    return result;
  };
  const second = bindSibling();
  assert.equal(second.session.native_id, f.oldCodex); assert.equal(second.handoff, false);
  assert.notEqual(second.session.id, first.session.id);
  assert.equal(bindSibling().session.id, second.session.id);
  assert.equal(f.bind("codex").session.id, first.session.id);
  assert.equal(f.db.getConversationByCodexThread(f.project.id, f.oldCodex)!.id, f.conversation.id);
  assert.equal(f.db.getConversationByCodexThread(project.id, f.oldCodex)!.id, conversation.id);
  assert.equal(f.db.isCodexThreadUsedByAnotherActiveConversation(f.oldCodex, f.conversation.id), true);
  assert.deepEqual(f.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("context usage belongs only to the current engine segment, even before its native ID arrives", t => {
  const f = fixture(t); f.bind("codex");
  const gemini = f.bind("antigravity"); assert.equal(gemini.handoff, true);
  assert.equal(f.usage(f.oldCodex, 100), false);
  const googleNative = crypto.randomUUID(); recordEngineNativeId(f.db.sqlite, gemini.session.id, googleNative);
  assert.equal(f.usage(googleNative, 37), true);
  assert.equal(f.db.getConversation(f.conversation.id)!.codex_thread_id, f.oldCodex, "Gemini cannot overwrite the legacy Codex identifier");
  const next = f.bind("codex"); assert.equal(next.session.native_id, null); assert.equal(next.handoff, true);
  assert.equal(f.usage(googleNative, 999), false); assert.equal(f.usage(f.oldCodex, 999), false);
  const newCodex = crypto.randomUUID(); recordEngineNativeId(f.db.sqlite, next.session.id, newCodex); f.db.claimCodexThreadForConversation(f.conversation.id, newCodex);
  assert.equal(f.db.getConversation(f.conversation.id)!.context_input_tokens, null);
  assert.equal(f.usage(newCodex, 42), true); assert.equal(f.usage(googleNative, 999), false);
  assert.equal(f.db.getConversation(f.conversation.id)!.context_input_tokens, 42);
});

test("retired remote Codex observers cannot replay into Gemini or an unstarted replacement Codex segment", t => {
  const f = fixture(t); f.bind("codex");
  const gemini = f.bind("antigravity"); recordEngineNativeId(f.db.sqlite, gemini.session.id, crypto.randomUUID());
  const assertIgnored = (suffix: string) => {
    const before = f.db.getConversation(f.conversation.id), messages = f.db.listMessages(f.conversation.id), activities = f.db.listRemoteThreadActivities(f.conversation.id);
    const result = f.db.importRemoteThread(LEGACY_USER_ID, f.project.id, f.executorId, f.thread(f.oldCodex, suffix), { model: "codex-test", reasoningEffort: "high" });
    assert.equal(result.conversation.id, f.conversation.id); assert.equal(result.created, false); assert.equal(result.changed, false);
    assert.equal(result.importedMessages, 0); assert.equal(result.importedActivities, 0);
    assert.deepEqual(f.db.getConversation(f.conversation.id), before); assert.deepEqual(f.db.listMessages(f.conversation.id), messages); assert.deepEqual(f.db.listRemoteThreadActivities(f.conversation.id), activities);
  };
  assertIgnored("while-gemini");
  const next = f.bind("codex"); assert.equal(next.session.native_id, null);
  assertIgnored("before-new-native-id");
  const current = crypto.randomUUID(); recordEngineNativeId(f.db.sqlite, next.session.id, current); f.db.claimCodexThreadForConversation(f.conversation.id, current);
  assertIgnored("after-new-native-id");
  const result = f.db.importRemoteThread(LEGACY_USER_ID, f.project.id, f.executorId, f.thread(current, "current"), { model: "codex-test", reasoningEffort: "high" });
  assert.equal(result.conversation.id, f.conversation.id); assert.equal(result.created, false); assert.equal(result.importedMessages, 1);
});

test("observer-created new Codex placeholder is merged into the existing multi-engine conversation", t => {
  const f = fixture(t); f.bind("codex");
  const google = f.bind("antigravity"); recordEngineNativeId(f.db.sqlite, google.session.id, crypto.randomUUID());
  const next = f.bind("codex"), native = crypto.randomUUID();
  const observed = f.db.importRemoteThread(LEGACY_USER_ID, f.project.id, f.executorId, f.thread(native, "fresh"), { model: "codex-test", reasoningEffort: "high" });
  assert.equal(observed.created, true); assert.notEqual(observed.conversation.id, f.conversation.id);
  recordEngineNativeId(f.db.sqlite, next.session.id, native);
  const claim = f.db.claimCodexThreadForConversation(f.conversation.id, native);
  assert.deepEqual(claim!.mergedConversationIds, [observed.conversation.id]);
  assert.equal(f.db.getConversation(observed.conversation.id), undefined);
  assert.equal(f.db.getConversationByCodexThread(f.project.id, native)!.id, f.conversation.id);
  assert.equal(f.db.getConversationByCodexThread(f.project.id, f.oldCodex)!.id, f.conversation.id);
  assert.equal(f.db.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("Codex cleanup references include retired native segments and exclude Gemini profiles and other nodes", t => {
  const f = fixture(t); f.bind("codex");
  const google = f.bind("antigravity"), googleNative = crypto.randomUUID(); recordEngineNativeId(f.db.sqlite, google.session.id, googleNative);
  const next = f.bind("codex"), current = crypto.randomUUID(); recordEngineNativeId(f.db.sqlite, next.session.id, current); f.db.claimCodexThreadForConversation(f.conversation.id, current);
  const foreign = crypto.randomUUID(); f.db.sqlite.prepare("INSERT INTO agent_engine_sessions VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(), f.conversation.id, "codex", `remote:${crypto.randomUUID()}`, "codex-default", foreign, new Date().toISOString());
  const home = path.join(f.root, "codex-home"); fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  for (const id of [f.oldCodex, current, googleNative, foreign]) fs.writeFileSync(path.join(home, "sessions", `${id}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`);
  const refs = f.db.sqlite.prepare("SELECT native_id FROM agent_engine_sessions WHERE conversation_id=? AND engine_id='codex' AND executor_id=? AND native_id IS NOT NULL").all(f.conversation.id, f.executorId) as Array<{native_id:string}>;
  assert.deepEqual(refs.map(row => row.native_id).sort(), [f.oldCodex, current].sort());
  assert.ok(!refs.some(row => row.native_id === googleNative || row.native_id === foreign));
  assert.ok(f.db.beginConversationDeletion(f.conversation.id, LEGACY_USER_ID)); assert.equal(f.db.completeConversationDeletion(f.conversation.id), true);
  assert.equal((f.db.sqlite.prepare("SELECT count(*) AS n FROM agent_engine_sessions").get() as { n: number }).n, 0);
  assert.equal((f.db.sqlite.prepare("SELECT count(*) AS n FROM agent_job_sessions").get() as { n: number }).n, 0);
  assert.deepEqual(f.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("remote deletion archives every owned Codex segment, preserves shared historical roots, and never sends Gemini IDs", async t => {
  const f = fixture(t); f.bind("codex");
  const google = f.bind("antigravity"), googleNative = crypto.randomUUID(); recordEngineNativeId(f.db.sqlite, google.session.id, googleNative);
  const last = f.bind("codex"), current = crypto.randomUUID(); recordEngineNativeId(f.db.sqlite, last.session.id, current); f.db.claimCodexThreadForConversation(f.conversation.id, current);
  const foreign = crypto.randomUUID(); f.db.sqlite.prepare("INSERT INTO agent_engine_sessions VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(), f.conversation.id, "codex", `remote:${crypto.randomUUID()}`, "codex-default", foreign, new Date().toISOString());
  const config = loadConfig({ projectRoot: f.root, dataRoot: path.join(f.root, "data"), tenantRoot: path.join(f.root, "tenants"), containerized: false });
  const gateway = new RemoteWorkerGateway(config, f.db); t.after(() => gateway.close());
  const runner = new CodexRunner(config, f.db, () => {}, gateway);
  const archived: string[] = [];
  t.mock.method(gateway, "archiveThread", async (workerId: string, threadId: string) => {
    assert.equal(`remote:${workerId}`, f.executorId); archived.push(threadId);
    if (threadId === f.oldCodex) throw new Error(`No rollout found for thread id ${threadId}`);
  });
  assert.equal(await runner.deleteCodexThread(LEGACY_USER_ID, f.conversation.id, current), 1);
  assert.deepEqual(new Set(archived), new Set([f.oldCodex, current]));
  const sibling = f.db.createConversation(crypto.randomUUID(), "Other visible owner", undefined, LEGACY_USER_ID, f.project.id);
  f.db.sqlite.prepare("INSERT INTO agent_engine_sessions VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(), sibling.id, "codex", f.executorId, "legacy", f.oldCodex, new Date().toISOString());
  assert.equal(f.db.isCodexThreadUsedByAnotherActiveConversation(f.oldCodex, f.conversation.id), true);
  archived.length = 0;
  assert.equal(await runner.deleteCodexThread(LEGACY_USER_ID, f.conversation.id, current), 1);
  assert.deepEqual(archived, [current]);
});
