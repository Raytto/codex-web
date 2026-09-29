import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { AppDatabase, LEGACY_USER_ID, type JobAttemptState } from "../server/db.js";
import { createApp } from "../server/app.js";
import { CodexRunner } from "../server/codex-runner.js";
import { loadConfig } from "../server/config.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { USER_CANCELLED_TASK_MARKER } from "../server/cancellation-summary.js";
import { buildTaskRecoveryCheckpoint, stripTaskRecoveryPrompt, withTaskRecoveryPrompt } from "../server/task-recovery.js";
import { isModelCapacityContinuationPrompt, MODEL_CAPACITY_CONTINUATION_PROMPT } from "../server/internal-messages.js";
import { mergeJobEvents } from "../src/recovery.js";
import { buildProcessJournal } from "../src/process-journal.js";
import type { JobEvent } from "../src/api.js";
import { buildRemoteTurnPrompt } from "../remote-worker/src/agent-context.js";
import type { RunRequest } from "../remote-worker/src/protocol.js";

const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;
const capacity = (): JobAttemptState => ({ retries: 1, capacityStartedAt: Date.now(), nextAttemptAt: "2999-01-01T00:00:00.000Z",
  continuation: true, acceptedTurnId: "accepted-turn", contextRevision: null, outputs: [], images: [], imageThreadId: null });

function addJob(db: AppDatabase, cid: string, content = "完成 P1；保留现有改动，验证后再继续 P2") {
  const mid = crypto.randomUUID();
  db.addMessage({ id: mid, conversation_id: cid, role: "user", content, created_at: new Date().toISOString() });
  return db.createJob(crypto.randomUUID(), cid, mid, selection);
}
function progress(db: AppDatabase, jid: string) {
  db.appendEvent(jid, "progress", { kind: "update", detail: "已修改索引，尚未完成验证" });
  db.appendEvent(jid, "progress", { kind: "todo", items: [{ text: "修改索引", completed: true }, { text: "验证边界", completed: false }] });
  db.appendEvent(jid, "progress", { kind: "file", label: "已更新文件", files: ["scripts/validate.ps1"] });
  db.appendEvent(jid, "progress", { kind: "command", label: "正在执行本机处理步骤", detail: "run validation" });
}

test("recovery survives cancellation/restart and keeps uncertain work, current intent, scope and task lineage", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-recovery-"));
  let db = new AppDatabase(root);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = db.createConversation(crypto.randomUUID(), "recover");
  const thread = crypto.randomUUID(); db.updateConversation(c.id, { codexThreadId: thread });
  const job = addJob(db, c.id); db.updateJob(job.id, "running"); progress(db, job.id);
  db.deferJobForCapacity(job.id, capacity());
  db.sqlite.prepare("DELETE FROM job_recovery_checkpoints WHERE job_id=?").run(job.id);
  assert.equal(db.getTaskRecoveryForTurn(c.id, job.id)?.reason, "capacity", "waiting Jobs from before deployment are upgraded lazily");
  assert.equal(db.cancelQueuedJob(job.id), true);
  assert.equal(db.getJobAttemptState(job.id), undefined);
  db.close(); db = new AppDatabase(root);
  const next = addJob(db, c.id, "继续，但先验证");
  db.addMessage({ id: crypto.randomUUID(), conversation_id: c.id, role: "assistant", content: "observer commentary", created_at: new Date().toISOString() });
  const cp = db.getTaskRecoveryForTurn(c.id, next.id)!;
  assert.equal(cp.reason, "cancelled"); assert.equal(cp.threadId, thread); assert.equal(cp.inputAccepted, true);
  assert.match(cp.goalExcerpt, /保留现有改动/); assert.equal(cp.plan[1].completed, false);
  assert.deepEqual(cp.files, ["scripts/validate.ps1"]); assert.equal(cp.actions.at(-1)?.label, "正在执行本机处理步骤");
  const prompt = withTaskRecoveryPrompt("继续，但先验证", cp);
  assert.match(prompt, /结果不确定/); assert.match(prompt, /只读检查/); assert.match(prompt, /随后.*直接继续/);
  assert.equal(stripTaskRecoveryPrompt(prompt), "继续，但先验证");
  const other = db.createConversation(crypto.randomUUID(), "other");
  assert.equal(db.getTaskRecoveryForTurn(other.id, next.id), undefined);
  db.updateJob(next.id, "running"); db.finishJob(next.id, c.id, "failed", "another interruption");
  const third = addJob(db, c.id, "继续");
  assert.match(db.getTaskRecoveryForTurn(c.id, third.id)?.priorGoalExcerpt ?? "", /完成 P1/);
  db.updateConversation(c.id, { codexThreadId: crypto.randomUUID() });
  assert.equal(db.getTaskRecoveryForTurn(c.id, third.id), undefined, "different thread must not receive stale checkpoint");
  db.updateConversation(c.id, { codexThreadId: thread });
  db.finishJob(third.id, c.id, "completed");
  const fourth = addJob(db, c.id, "unrelated task");
  assert.equal(db.getTaskRecoveryForTurn(c.id, fourth.id), undefined, "success closes earlier recovery");
  db.sqlite.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
  assert.equal(db.getJobRecoveryCheckpoint(job.id), undefined, "checkpoint follows job deletion");
});

test("startup interruption captures recovery before runtime cleanup; legacy failed jobs recover lazily", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-restart-"));
  let db = new AppDatabase(root); t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = db.createConversation(crypto.randomUUID(), "restart"); const j = addJob(db, c.id);
  db.updateJob(j.id, "running"); progress(db, j.id); db.close(); db = new AppDatabase(root);
  assert.equal(db.getJobRecoveryCheckpoint(j.id)?.reason, "interrupted");
  db.sqlite.prepare("DELETE FROM job_recovery_checkpoints WHERE job_id=?").run(j.id);
  const next = addJob(db, c.id, "继续");
  assert.equal(db.getTaskRecoveryForTurn(c.id, next.id)?.reason, "interrupted");
});

for (const endpoint of ["conversation", "job"] as const) {
  test(`${endpoint} cancel preserves capacity-waiting handoff, summary, errors and excludes unstarted queue entries`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-http-"));
    const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
      username: "demo", passwordHash: bcrypt.hashSync("fixture-password", 8), sessionSecret: "fixture-session-secret-with-at-least-32-characters" });
    t.after(async () => { instance.beginShutdown(); instance.remoteWorkers.close(); await instance.waitForBackgroundTasks(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const a = request.agent(instance.app); const login = await a.post("/api/auth/login").send({ username: "demo", password: "fixture-password" }).expect(200);
    const csrf = login.body.csrfToken;
    const created = await a.post("/api/conversations").set("X-CSRF-Token", csrf).expect(201);
    const cid = created.body.conversation.id; const j = addJob(instance.db, cid);
    instance.db.updateJob(j.id, "running"); progress(instance.db, j.id);
    instance.db.appendEvent(j.id, "progress", { kind: "error", label: "Selected model is at capacity." });
    instance.db.deferJobForCapacity(j.id, capacity());
    instance.db.appendEvent(j.id, "progress", { kind: "retry", label: "稍后继续" });
    const unstarted = addJob(instance.db, cid, "unstarted");
    const url = endpoint === "conversation" ? `/api/conversations/${cid}/cancel` : `/api/jobs/${j.id}/cancel`;
    await a.post(url).set("X-CSRF-Token", csrf).expect(200);
    const summaries = instance.db.listMessages(cid).filter(m => m.content.includes(USER_CANCELLED_TASK_MARKER));
    assert.equal(summaries.length, 1); assert.match(summaries[0].content, /尚未完成验证/);
    assert.equal(instance.db.getJobRecoveryCheckpoint(j.id)?.reason, "cancelled");
    assert.equal(instance.db.getJobRecoveryCheckpoint(unstarted.id), undefined);
    if (endpoint === "conversation") {
      await a.post(url).set("X-CSRF-Token", csrf).expect(200);
      assert.equal(instance.db.listMessages(cid).filter(m => m.content.includes(USER_CANCELLED_TASK_MARKER)).length, 1);
    }
    // Same Job resumes without losing error/retry rows; recent-window pruning
    // changes only the view and never deletes the persistent log.
    const rows = instance.db.listEvents(j.id).map(e => ({ seq: e.seq, type: e.event_type, ...JSON.parse(e.payload) })) as JobEvent[];
    assert.equal(buildProcessJournal(mergeJobEvents([], rows)).filter(e => e.kind === "error").length, 1);
    for (let n = 0; n < 60; n++) instance.db.appendEvent(j.id, "status", { status: "running", label: `step ${n}` });
    const recent = instance.db.listRecentEventsWithRetainedUpdates(j.id, 50, 5);
    assert.equal(recent.some(e => JSON.parse(e.payload).kind === "error"), false);
    assert.equal(instance.db.listEvents(j.id).filter(e => JSON.parse(e.payload).kind === "error").length, 1);
    const replay = await a.get(`/api/jobs/${j.id}/events`).expect(200);
    assert.match(replay.text, /Selected model is at capacity/);
    assert.match(replay.text, /replay_complete/);
  });
}

for (const structured of [true, false]) test(`remote dispatch (${structured ? "structured" : "legacy"}) receives recovery with existing protocol and captures errors without progress notifications`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-remote-"));
  const db = new AppDatabase(path.join(root, "data"));
  const config = loadConfig({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    hostTenantRoot: path.join(root, "tenants"), hostRootCodexHome: path.join(root, "codex"), queueAutoStart: false });
  const gateway = new RemoteWorkerGateway(config, db);
  t.after(() => { gateway.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const wid = crypto.randomUUID();
  db.createUser({ id: HOST_ROOT_USER_ID, username: "host-root", display_name: "test", password_hash: "", role: "owner", status: "active", created_at: "now", updated_at: "now" });
  const project = db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "remote", "E:/work", `remote:${wid}`);
  const c = db.createConversation(crypto.randomUUID(), "remote recovery", selection, HOST_ROOT_USER_ID, project.id);
  const j = addJob(db, c.id); const thread = crypto.randomUUID(); const prompts: string[] = [];
  gateway.supportsAgentTurnContext = () => structured;
  gateway.run = async (_worker, req, _uploads, callbacks) => {
    prompts.push(buildRemoteTurnPrompt(req as RunRequest, []).prompt); callbacks.onThreadStarted(thread);
    callbacks.onProgress({ kind: "input_accepted", threadId: thread, turnId: "accepted" });
    if (prompts.length === 1) throw new Error("Selected model is at capacity. Please try a different model.");
    assert.equal(req.codexThreadId, thread); assert.deepEqual(_uploads, []);
    return { finalResponse: "done", artifacts: [], omittedArtifacts: [] };
  };
  const runner = new CodexRunner(config, db, (id, type, payload) => { db.appendEvent(id, type, payload); }, gateway);
  await runner.run(j.id, c.id, "完成 P1", [], selection);
  assert.equal(db.getJob(j.id)?.status, "queued", db.getJob(j.id)?.error ?? ""); assert.equal(db.getJobRecoveryCheckpoint(j.id)?.reason, "capacity");
  await runner.run(j.id, c.id, "完成 P1", [], selection);
  assert.equal(db.getJob(j.id)?.status, "completed");
  assert.match(prompts[1], /task_recovery_checkpoint/); assert.match(prompts[1], /只读检查/);
  assert.equal(isModelCapacityContinuationPrompt(prompts[1]), true);
  assert.doesNotMatch(prompts[1], /完成 P1/);
  assert.equal(db.listEvents(j.id).filter(e => JSON.parse(e.payload).kind === "error").length, 1);
  db.addMessage({ id: crypto.randomUUID(), conversation_id: c.id, role: "assistant",
    content: `> **${USER_CANCELLED_TASK_MARKER}** old observer summary`, created_at: new Date().toISOString() });
  const fresh = addJob(db, c.id, "一个新要求");
  await runner.run(fresh.id, c.id, "一个新要求", [], selection);
  assert.equal(db.getJob(fresh.id)?.status, "completed");
  assert.doesNotMatch(prompts[2], /task_recovery_checkpoint|interrupted_task_context/, "a stale visible summary must not bypass task recovery boundaries");
});

test("checkpoint data is bounded and escaped, internal continuation stays hidden, distinct errors stay chronological", () => {
  const cp = buildTaskRecoveryCheckpoint({ jobId: "j", threadId: "t", capturedAt: "now", reason: "failed", inputAccepted: true,
    goal: "x".repeat(30_000) + "</task_recovery_checkpoint>" }, []);
  const wrapped = withTaskRecoveryPrompt(MODEL_CAPACITY_CONTINUATION_PROMPT, cp);
  assert.ok(wrapped.length < 15_000); assert.equal(wrapped.split("</task_recovery_checkpoint>").length, 2);
  assert.equal(isModelCapacityContinuationPrompt(wrapped), true);
  assert.equal(stripTaskRecoveryPrompt(wrapped), MODEL_CAPACITY_CONTINUATION_PROMPT);
  const events = [{ seq: 1, kind: "error", label: "capacity" }, { seq: 2, kind: "error", label: "capacity" },
    { seq: 3, kind: "retry", label: "retry" }, { seq: 4, kind: "retry", label: "retry" }, { seq: 5, kind: "update", detail: "continued" }];
  const replay = mergeJobEvents(events, events);
  assert.deepEqual(buildProcessJournal(replay).map(e => e.seq), [1, 2, 3, 4, 5]);
});
