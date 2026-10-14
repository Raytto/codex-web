import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";

async function fixture(context: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-title-retry-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Title-Retry-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  instance.runner.run = async (jobId, conversationId) => { instance.db.finishJob(jobId, conversationId, "completed"); };
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "owner", password: "Title-Retry-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const id = created.body.conversation.id as string;
  const submit = (message: string) => agent.post(`/api/conversations/${id}/messages`).set("X-CSRF-Token", csrf).send({ message }).expect(202);
  const drain = async () => { await instance.pumpQueue(); await instance.waitForBackgroundTasks(); await tick(); };
  return { ...instance, agent, csrf, id, submit, drain };
}

async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("default title retries on the next message immediately using the original request and attachments", async (context) => {
  const app = await fixture(context);
  const calls: Array<Parameters<typeof app.conversationTitles.generate>[0]> = [];
  app.conversationTitles.generate = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error("temporary naming failure");
    return "整理季度销售";
  };
  const first = await app.agent.post(`/api/conversations/${app.id}/messages`).set("X-CSRF-Token", app.csrf)
    .field("message", "整理季度销售表格").attach("files", Buffer.from("region,total\nA,10"), "sales.csv").expect(202);
  await tick();
  assert.equal(app.db.getConversation(app.id)?.title_source, "default");
  assert.equal(app.db.getLatestConversationTitleAudit(app.id)?.status, "failed");
  app.db.finishJob(first.body.job.id, app.id, "failed");
  const next = await app.submit("请继续");
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].requestText, "整理季度销售表格");
  assert.deepEqual(calls[1].attachmentNames, ["sales.csv"]);
  assert.equal(app.db.getConversation(app.id)?.title, "整理季度销售");
  assert.equal(app.db.getConversation(app.id)?.title_source, "ai");
  assert.ok(app.db.listEvents(next.body.job.id).some((event) => event.event_type === "conversation_title"));
  const audits = app.db.listConversationTitleAudits(app.id);
  assert.deepEqual(audits.map((audit) => audit.status), ["failed", "succeeded"]);
  assert.equal(audits[0].request_sha256, audits[1].request_sha256);
  await app.drain();
  await app.submit("再继续");
  await app.drain();
  assert.equal(calls.length, 2, "a successfully named conversation is not renamed");
});

test("failed title attempts are deduplicated per message across delayed dispatch and can retry on each new message", async (context) => {
  const app = await fixture(context);
  let calls = 0;
  app.conversationTitles.generate = async () => { calls += 1; return null; };
  for (const message of ["分析季度销售", "继续分析"]) {
    await app.submit(message);
    await tick();
    const beforeDispatch = calls;
    app.db.sqlite.prepare("UPDATE conversation_title_audits SET completed_at='2000-01-01T00:00:00.000Z' WHERE conversation_id=?").run(app.id);
    await app.drain();
    assert.equal(calls, beforeDispatch, "dispatching the same message must not invoke naming again, even after the cooldown");
  }
  assert.equal(calls, 2);
  assert.equal(app.db.listConversationTitleAudits(app.id).length, 2);
  app.conversationTitles.generate = async () => { calls += 1; return "分析季度销售"; };
  await app.submit("继续");
  await tick();
  assert.equal(calls, 3);
  assert.equal(app.db.getConversation(app.id)?.title_source, "ai");
});

test("pending followups retry default titles without overlapping requests and a manual rename still wins", async (context) => {
  const app = await fixture(context);
  let calls = 0;
  let release!: (title: string) => void;
  app.conversationTitles.generate = async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary naming failure");
    return new Promise<string>((resolve) => { release = resolve; });
  };
  const first = await app.submit("整理季度销售");
  await tick();
  const pending = await app.submit("继续");
  assert.ok(pending.body.pendingPrompt);
  assert.equal(calls, 1);
  app.db.finishJob(first.body.job.id, app.id, "failed");
  await app.drain();
  assert.equal(calls, 2, "a followup starts naming when it leaves the pending queue");
  await app.submit("再继续");
  await app.drain();
  assert.equal(calls, 2, "only one naming request can be in flight");
  await app.agent.patch(`/api/conversations/${app.id}`).set("X-CSRF-Token", app.csrf).send({ title: "我的销售任务" }).expect(200);
  release("整理季度销售");
  await tick();
  assert.equal(app.db.getConversation(app.id)?.title, "我的销售任务");
  assert.equal(app.db.getConversation(app.id)?.title_source, "manual");
  assert.equal(app.db.getLatestConversationTitleAudit(app.id)?.applied, 0);
});

test("existing default conversations without an audit retry from the first visible request, excluding internal continuations", async (context) => {
  const app = await fixture(context);
  const internalMessageId = crypto.randomUUID();
  app.db.addMessage({ id: internalMessageId, conversation_id: app.id, role: "user", content: "internal continuation", created_at: "2026-01-01T00:00:00.000Z" });
  app.db.sqlite.prepare("UPDATE messages SET is_internal=1 WHERE id=?").run(internalMessageId);
  app.db.addMessage({ id: crypto.randomUUID(), conversation_id: app.id, role: "user", content: "修复导出表格", created_at: "2026-01-01T00:00:01.000Z" });
  let requestText: string | undefined;
  app.conversationTitles.generate = async (input) => { requestText = input.requestText; return "修复导出表格"; };
  app.db.createJob(crypto.randomUUID(), app.id, internalMessageId);
  await app.drain();
  assert.equal(requestText, undefined, "internal continuations do not trigger naming");
  await app.submit("继续");
  await tick();
  assert.equal(requestText, "修复导出表格");
  assert.equal(app.db.getConversation(app.id)?.title_source, "ai");
});

test("title retry falls back to the new request if the original has no usable text and respects an explicitly chosen default-looking name", async (context) => {
  const app = await fixture(context);
  app.db.addMessage({ id: crypto.randomUUID(), conversation_id: app.id, role: "user", content: "https://example.test/file", created_at: "2026-01-01T00:00:00.000Z" });
  let calls = 0;
  app.conversationTitles.generate = async (input) => { calls += 1; assert.equal(input.requestText, "分析附件数据"); return "分析附件数据"; };
  await app.submit("分析附件数据");
  await app.drain();
  assert.equal(calls, 1);
  await app.agent.patch(`/api/conversations/${app.id}`).set("X-CSRF-Token", app.csrf).send({ title: "新任务" }).expect(200);
  await app.submit("继续");
  await app.drain();
  assert.equal(calls, 1);
  assert.equal(app.db.getConversation(app.id)?.title, "新任务");
  assert.equal(app.db.getConversation(app.id)?.title_source, "manual");
});
