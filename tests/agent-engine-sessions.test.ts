import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bindEngineSession, recordEngineNativeId, engineHandoffContext } from "../server/agent-engine-sessions.js";
import { mergeEngineOptions, repairAgentSelection, resolveAgentSelection, type AgentOptions } from "../server/model-options.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agent_engine_sessions(id TEXT PRIMARY KEY,conversation_id TEXT,engine_id TEXT,executor_id TEXT,account_id TEXT,native_id TEXT,created_at TEXT);
    CREATE TABLE agent_job_sessions(job_id TEXT PRIMARY KEY,session_id TEXT);
    CREATE TABLE messages(id TEXT,conversation_id TEXT,role TEXT,content TEXT,is_internal INTEGER,created_at TEXT);
    CREATE TABLE jobs(id TEXT,message_id TEXT);`);
  return db;
}

test("Codex legacy resume and retries retain one native thread; cross-engine turns get distinct segments", () => {
  const db = fixture();
  try {
    const input = { conversationId: "conversation", jobId: "c1", engine: "codex" as const, executorId: "node1", accountId: "codex-default", legacyCodexThreadId: "legacy-thread" };
    const c1 = bindEngineSession(db, input);
    assert.equal(c1.session.native_id, "legacy-thread"); assert.equal(c1.handoff, false);
    assert.equal(bindEngineSession(db, input).session.id, c1.session.id);
    assert.equal(bindEngineSession(db, { ...input, jobId: "c2" }).session.id, c1.session.id);
    const g1 = bindEngineSession(db, { ...input, jobId: "g1", engine: "antigravity", accountId: "google1" });
    assert.equal(g1.session.native_id, null); assert.equal(g1.handoff, true);
    recordEngineNativeId(db, g1.session.id, "gemini-native");
    assert.equal(bindEngineSession(db, { ...input, jobId: "g2", engine: "antigravity", accountId: "google1" }).session.native_id, "gemini-native");
    assert.throws(() => bindEngineSession(db, { ...input, jobId: "g1", engine: "antigravity", accountId: "google2" }), /账号已变化/);
    const c3 = bindEngineSession(db, { ...input, jobId: "c3" });
    assert.notEqual(c3.session.id, c1.session.id); assert.equal(c3.session.native_id, null); assert.equal(c3.handoff, true);
    recordEngineNativeId(db, c3.session.id, "codex-new");
    assert.throws(() => recordEngineNativeId(db, c3.session.id, "gemini-native"), /不一致/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM agent_engine_sessions").get() as { n: number }).n, 3);
  } finally { db.close(); }
});

test("first Gemini turn preserves existing Codex lineage and node/account changes require a new segment", () => {
  const db = fixture();
  try {
    const input = { conversationId: "conversation", jobId: "g1", engine: "antigravity" as const, executorId: "node1", accountId: "google1", legacyCodexThreadId: "codex-old" };
    const first = bindEngineSession(db, input);
    assert.equal(first.handoff, true);
    assert.equal((db.prepare("SELECT native_id FROM agent_engine_sessions WHERE engine_id='codex'").get() as { native_id: string }).native_id, "codex-old");
    recordEngineNativeId(db, first.session.id, "google-old");
    assert.equal(bindEngineSession(db, { ...input, jobId: "g2", executorId: "node2" }).session.native_id, null);
  } finally { db.close(); }
});

test("handoff uses bounded original messages and excludes current request and internal metadata", () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO jobs VALUES('job','current');
      INSERT INTO messages VALUES('old','c','user','先完成测试',0,'1');
      INSERT INTO messages VALUES('private','c','assistant','internal secret',1,'2');
      INSERT INTO messages VALUES('current','c','user','current request',0,'3');
      INSERT INTO messages VALUES('future','c','user','future queued request',0,'4');`);
    const text = engineHandoffContext(db, "c", "job");
    assert.match(text, /先完成测试/); assert.doesNotMatch(text, /internal secret|current request|future queued request/);
    db.prepare("INSERT INTO messages VALUES('big','c','assistant',?,0,'4')").run("x".repeat(100_000));
    db.exec("DELETE FROM messages WHERE id='current'; INSERT INTO messages VALUES('current','c','user','current request',0,'5')");
    assert.ok(engineHandoffContext(db, "c", "job").length < 25_000);
  } finally { db.close(); }
});

test("catalog merge retains Codex defaults and never replaces unavailable Gemini with Codex", () => {
  const codex: AgentOptions = { models: [{ id: "codex-model", label: "Codex", description: "", reasoningEfforts: ["high", "ultra"] }], reasoningEfforts: [{ id: "high", label: "高" }, { id: "ultra", label: "最高" }], defaults: { model: "codex-model", reasoningEffort: "high" } };
  const gemini: AgentOptions = { models: [{ id: "antigravity:gemini-model", label: "Gemini", description: "", engineId: "antigravity", reasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium" }], reasoningEfforts: [{ id: "low", label: "低" }, { id: "medium", label: "中" }], defaults: { model: "antigravity:gemini-model", reasoningEffort: "medium" } };
  const merged = mergeEngineOptions(codex, gemini);
  assert.deepEqual(merged.defaults, codex.defaults);
  assert.equal(resolveAgentSelection(merged, gemini.defaults.model, undefined).reasoningEffort, "medium");
  assert.throws(() => resolveAgentSelection(merged, gemini.defaults.model, "ultra"), /不受/);
  const unavailable = mergeEngineOptions(merged, null);
  assert.equal(unavailable.models.length, 1);
  assert.deepEqual(repairAgentSelection(unavailable, gemini.defaults.model, "medium"), gemini.defaults);
  assert.throws(() => resolveAgentSelection(unavailable, gemini.defaults.model, "medium"), /不可用/);
});
