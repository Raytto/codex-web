import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
process.env.CWW_ANTIGRAVITY_TITLE_MODEL = "antigravity:gemini-title-fixture";
process.env.CWW_ANTIGRAVITY_TITLE_EFFORT = "low";
const { createApp } = await import("../server/app.js");
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { HOST_EXECUTOR_ID } from "../server/remote-worker-protocol.js";
import type { GeminiAccountRequest } from "../remote-worker/src/gemini-account-types.js";
import type { AgentOptions } from "../server/model-options.js";
import { ensureTenantWorkspace } from "../server/paths.js";

test("Gemini account routes retain owner-only authorization, CSRF, node scope and no-store", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-api-"));
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "tenant", passwordHash: bcrypt.hashSync("Tenant-Test-2026!", 8), sessionSecret: "fixture-session-secret-longer-than-thirty-two-characters" });
  t.after(() => { instance.remoteWorkers.close(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({ id: HOST_ROOT_USER_ID, username: "host", display_name: "Host", password_hash: bcrypt.hashSync("Host-Test-2026!", 8), role: "owner", status: "active", created_at: now, updated_at: now });
  const calls: Array<{ userId: string; request: GeminiAccountRequest; executorId: string }> = [];
  const state = { accounts: [], activeAccountId: null, runtimeAvailable: false, loginAvailable: true };
  const usage = { accountId: null, state: "unavailable", checkedAt: now, quotaUpdatedAt: null, creditsUpdatedAt: null, groups: [], remainingCredits: null, error: "No account" };
  t.mock.method(instance.runner, "geminiAccounts", async (userId: string, operation: GeminiAccountRequest, executorId: string) => { calls.push({ userId, request: operation, executorId }); return operation.action === "usage" ? { usage } : { state }; });
  await request(instance.app).get("/api/gemini-accounts").expect(401);
  await request(instance.app).get("/api/gemini-accounts/usage").expect(401);
  const tenant = request.agent(instance.app);
  const tenantSession = await tenant.post("/api/auth/login").send({ username: "tenant", password: "Tenant-Test-2026!" }).expect(200);
  await tenant.get("/api/gemini-accounts").expect(403);
  await tenant.get("/api/gemini-accounts/usage").expect(403);
  await tenant.post("/api/gemini-accounts/logins").set("X-CSRF-Token", tenantSession.body.csrfToken).send({ label: "test" }).expect(403);
  assert.equal(calls.length, 0);
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login").send({ username: "host", password: "Host-Test-2026!" }).expect(200);
  const list = await owner.get("/api/gemini-accounts").expect(200);
  assert.deepEqual(list.body, state); assert.match(list.headers["cache-control"], /no-store/);
  assert.deepEqual(calls[0], { userId: HOST_ROOT_USER_ID, request: { action: "list" }, executorId: HOST_EXECUTOR_ID });
  await owner.post("/api/gemini-accounts/logins").send({ label: "test" }).expect(403);
  await owner.get("/api/gemini-accounts?executorId=nonexistent").expect(404);
  const id = crypto.randomUUID();
  await owner.post(`/api/gemini-accounts/logins/${id}/code`).set("X-CSRF-Token", login.body.csrfToken).send({ code: "bad\ncode" }).expect(400);
  assert.equal(calls.length, 1);
  await owner.post(`/api/gemini-accounts/logins/${id}/code`).set("X-CSRF-Token", login.body.csrfToken).send({ code: "fixture-code" }).expect(200);
  assert.equal(calls[1]!.request.action, "login_code"); assert.equal(calls[1]!.request.loginId, id);
  await owner.get("/api/gemini-accounts/usage?accountId=invalid").expect(400);
  await owner.get("/api/gemini-accounts/usage?refresh=true").expect(400);
  await owner.get("/api/gemini-accounts/usage?executorId=nonexistent").expect(404);
  const current = await owner.get("/api/gemini-accounts/usage").expect(200);
  assert.deepEqual(current.body, usage); assert.match(current.headers["cache-control"], /no-store/);
  await owner.get(`/api/gemini-accounts/usage?accountId=${id}&refresh=1`).expect(200);
  assert.deepEqual(calls.at(-1), { userId: HOST_ROOT_USER_ID, executorId: HOST_EXECUTOR_ID, request: { action: "usage", accountId: id, refresh: true } });
});

test("first queued Gemini and Codex requests use the same Codex title engine", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-title-api-"));
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "tenant", passwordHash: bcrypt.hashSync("Tenant-Test-2026!", 8), sessionSecret: "fixture-session-secret-longer-than-thirty-two-characters" });
  t.after(async () => { instance.beginShutdown(); instance.remoteWorkers.close(); await instance.waitForBackgroundTasks(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({ id: HOST_ROOT_USER_ID, username: "host", display_name: "Host", password_hash: bcrypt.hashSync("Host-Test-2026!", 8), role: "owner", status: "active", created_at: now, updated_at: now });
  const model = "antigravity:gemini-title-fixture";
  const catalog: AgentOptions = {
    models: [{ id: model, label: "Gemini fixture", description: "Authenticated node fixture", engineId: "antigravity", reasoningEfforts: ["high"] }],
    reasoningEfforts: [{ id: "high", label: "High" }], defaults: { model, reasoningEffort: "high" },
  };
  const catalogCalls = t.mock.method(instance.runner, "geminiAccounts", async (userId: string, operation: GeminiAccountRequest, executorId: string) => {
    assert.equal(userId, HOST_ROOT_USER_ID);
    assert.equal(executorId, HOST_EXECUTOR_ID);
    assert.equal(operation.action, "catalog");
    return { catalog };
  });
  const titleCalls = t.mock.method(instance.runner, "generateConversationTitle", async () => JSON.stringify({ title: "整理季度销售" }));
  const executionCalls = t.mock.method(instance.runner, "run", async () => { throw new Error("Queue must remain paused"); });
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login").send({ username: "host", password: "Host-Test-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const available = await owner.get(`/api/agent-options?executorId=${HOST_EXECUTOR_ID}`).expect(200);
  assert.equal(catalogCalls.mock.callCount(), 1);
  assert.ok(available.body.models.some((option: { id: string }) => option.id === model));
  const codexModel = available.body.defaults.model as string;
  const codexEffort = available.body.defaults.reasoningEffort as string;
  assert.ok(!codexModel.startsWith("antigravity:"));

  const geminiConversation = await owner.post("/api/conversations").set("X-CSRF-Token", csrf).send({ reuseEmpty: false }).expect(201);
  const geminiId = geminiConversation.body.conversation.id as string;
  assert.equal(geminiConversation.body.conversation.agent_model, codexModel, "the per-request engine takes precedence over the saved Codex selection");
  const gemini = await owner.post(`/api/conversations/${geminiId}/messages`).set("X-CSRF-Token", csrf)
    .send({ message: "整理季度销售记录", model, reasoningEffort: "high" }).expect(202);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(gemini.body.job.status, "queued");
  assert.equal(instance.db.getJob(gemini.body.job.id)?.agent_model, model);
  const geminiAudit = instance.db.listConversationTitleAudits(geminiId);
  assert.equal(geminiAudit.length, 1);
  assert.equal(geminiAudit[0].model, "gpt-5.6-luna");
  assert.equal(geminiAudit[0].reasoning_effort, "low");
  assert.equal(instance.db.getConversation(geminiId)?.title_source, "ai");
  assert.equal(titleCalls.mock.callCount(), 1);
  assert.equal(titleCalls.mock.calls[0].arguments[4], "codex");

  const codexConversation = await owner.post("/api/conversations").set("X-CSRF-Token", csrf).send({ reuseEmpty: false }).expect(201);
  const codexId = codexConversation.body.conversation.id as string;
  const codex = await owner.post(`/api/conversations/${codexId}/messages`).set("X-CSRF-Token", csrf)
    .send({ message: "整理季度销售记录", model: codexModel, reasoningEffort: codexEffort }).expect(202);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(codex.body.job.status, "queued");
  assert.equal(titleCalls.mock.callCount(), 2);
  assert.equal(titleCalls.mock.calls[1].arguments[4], "codex");
  assert.deepEqual(instance.db.listConversationTitleAudits(codexId).map(audit => audit.status), ["succeeded"]);
  assert.equal(instance.db.getConversation(codexId)?.title, "整理季度销售");
  assert.equal(instance.db.getConversation(codexId)?.title_source, "ai");
  assert.equal(executionCalls.mock.callCount(), 0);

  await t.test("a Gemini pending request cannot steer running Codex and keeps its attachment", async () => {
    instance.db.updateJob(codex.body.job.id, "running");
    const steerCalls = t.mock.method(instance.runner, "steer", async () => "fixture-turn-id");
    const pending = await owner.post(`/api/conversations/${codexId}/messages`).set("X-CSRF-Token", csrf)
      .field("message", "使用 Gemini 分析附件").field("model", model).field("reasoningEffort", "high")
      .attach("files", Buffer.from("region,total\nA,10"), { filename: "sales.csv", contentType: "text/csv" }).expect(202);
    const pendingId = pending.body.pendingPrompt.id as string;
    const saved = instance.db.getPendingPrompt(pendingId)!;
    assert.equal(saved.agent_model, model);
    assert.equal(saved.files.length, 1);
    const attachment = path.join(ensureTenantWorkspace(instance.config.tenantRoot, HOST_ROOT_USER_ID, codexId), saved.files[0]!.relative_path);
    assert.equal(fs.existsSync(attachment), true);
    await owner.post(`/api/conversations/${codexId}/pending-prompts/${pendingId}/steer`).set("X-CSRF-Token", csrf).expect(409);
    assert.equal(steerCalls.mock.callCount(), 0);
    assert.deepEqual(instance.db.getPendingPrompt(pendingId), saved);
    assert.equal(fs.readFileSync(attachment, "utf8"), "region,total\nA,10");
    assert.deepEqual(instance.db.listMessages(codexId).map(message => message.content), ["整理季度销售记录"]);

    const sameModel = await owner.post(`/api/conversations/${codexId}/messages`).set("X-CSRF-Token", csrf)
      .send({ message: "继续整理销售记录", model: codexModel, reasoningEffort: codexEffort }).expect(202);
    const sameModelId = sameModel.body.pendingPrompt.id as string;
    const steered = await owner.post(`/api/conversations/${codexId}/pending-prompts/${sameModelId}/steer`).set("X-CSRF-Token", csrf).expect(200);
    assert.equal(steered.body.mode, "steer");
    assert.equal(steerCalls.mock.callCount(), 1);
    assert.equal(instance.db.getPendingPrompt(sameModelId), undefined);
    assert.deepEqual(instance.db.listMessages(codexId).map(message => message.content), ["整理季度销售记录", "继续整理销售记录"]);
    assert.deepEqual(instance.db.getPendingPrompt(pendingId), saved, "steering Codex leaves the Gemini request queued");
  });
  await t.test("AGY steering is rejected before dispatch and preserves its queued message and attachment", async () => {
    instance.db.updateJob(gemini.body.job.id, "running");
    const steerCalls = t.mock.method(instance.runner, "steer", async () => "must-not-dispatch");
    const pending = await owner.post(`/api/conversations/${geminiId}/messages`).set("X-CSRF-Token", csrf)
      .field("message", "下一轮读取附件").field("model", model).field("reasoningEffort", "high")
      .attach("files", Buffer.from("preserve-me"), { filename: "context.txt", contentType: "text/plain" }).expect(202);
    const saved = instance.db.getPendingPrompt(pending.body.pendingPrompt.id)!;
    const response = await owner.post(`/api/conversations/${geminiId}/pending-prompts/${saved.id}/steer`).set("X-CSRF-Token", csrf).expect(409);
    assert.equal(response.body.code, "LIVE_STEERING_UNAVAILABLE");
    assert.match(response.body.error, /Antigravity.*不支持运行中引导/);
    assert.equal(steerCalls.mock.callCount(), 0);
    assert.deepEqual(instance.db.getPendingPrompt(saved.id), saved);
    assert.equal(saved.files.length, 1);
  });
  await t.test("a changed effort remains queued instead of being silently ignored by live steering", async () => {
    const effort = available.body.models.find((entry: { id: string }) => entry.id === codexModel).reasoningEfforts.find((entry: string) => entry !== codexEffort);
    assert.ok(effort);
    const steerCalls = t.mock.method(instance.runner, "steer", async () => "must-not-dispatch");
    const pending = await owner.post(`/api/conversations/${codexId}/messages`).set("X-CSRF-Token", csrf)
      .send({ message: "用不同深度继续", model: codexModel, reasoningEffort: effort }).expect(202);
    const saved = instance.db.getPendingPrompt(pending.body.pendingPrompt.id)!;
    const response = await owner.post(`/api/conversations/${codexId}/pending-prompts/${saved.id}/steer`).set("X-CSRF-Token", csrf).expect(409);
    assert.match(response.body.error, /思考深度/);
    assert.equal(steerCalls.mock.callCount(), 0);
    assert.deepEqual(instance.db.getPendingPrompt(saved.id), saved);
  });

});
