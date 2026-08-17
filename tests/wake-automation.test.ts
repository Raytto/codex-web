import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { createJobAutomationToken, verifyJobAutomationToken } from "../server/wake-automation.js";

const selection = { model: "gpt-5", reasoningEffort: "high" };
const execFileAsync = promisify(execFile);

test("wake plans survive restart and enqueue exactly one continuation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-db-"));
  let db = new AppDatabase(root);
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "Durable wait", selection);
  const planId = crypto.randomUUID();
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  db.createWakePlan({
    id: planId, conversationId, mode: "event_or_deadline", label: "Wait for OCR", runId: "ocr-42", deadlineAt,
    successPrompt: "OCR completed; continue.", failurePrompt: "OCR failed; inspect it.", timeoutPrompt: "OCR timed out; inspect it.",
    selection, eventTokenHash: "hash",
  });
  assert.equal(db.getConversation(conversationId)?.active_wake_count, 1);
  db.close();

  db = new AppDatabase(root);
  assert.equal(db.getActiveWakePlan(conversationId)?.run_id, "ocr-42");
  const success = db.recordWakeEvent(planId, "ocr-complete", "success", "42 pages", crypto.randomUUID());
  assert.equal(success.status, "triggered");
  assert.equal(success.pendingPrompt?.content, "OCR completed; continue.");
  assert.equal(db.recordWakeEvent(planId, `deadline:${deadlineAt}`, "deadline", null, crypto.randomUUID()).status, "stale");
  assert.equal(db.recordWakeEvent(planId, "ocr-complete", "success", null, crypto.randomUUID()).status, "duplicate");
  assert.equal(db.listPendingPrompts(conversationId).length, 1);
  assert.equal(db.getConversation(conversationId)?.active_wake_count, 0);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("pending prompts stay queued during an armed wait and the continuation resumes first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-pending-"));
  const db = new AppDatabase(root);
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "Waiting queue", selection);
  const plan = db.createWakePlan({
    id: crypto.randomUUID(), conversationId, mode: "time", label: "Wait ten minutes",
    deadlineAt: new Date(Date.now() + 600_000).toISOString(), successPrompt: "resume first",
    failurePrompt: "resume first", timeoutPrompt: "resume first", selection,
  });
  const userPending = db.createPendingPrompt(crypto.randomUUID(), conversationId, "user queued", selection);
  assert.equal(db.getNextDispatchablePendingPrompt(), undefined);
  const triggered = db.recordWakeEvent(plan.id, "deadline", "deadline", null, crypto.randomUUID());
  assert.equal(triggered.status, "triggered");
  assert.deepEqual(db.listPendingPrompts(conversationId).map((pending) => [pending.content, pending.position]), [
    ["resume first", 1],
    ["user queued", 2],
  ]);
  assert.equal(db.getNextDispatchablePendingPrompt()?.content, "resume first");
  assert.equal(db.getPendingPrompt(userPending.id)?.content, "user queued");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("wake prompt edits use optimistic revisions and preserve event credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-edit-"));
  const db = new AppDatabase(root);
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "Prompt edit", selection);
  const plan = db.createWakePlan({
    id: crypto.randomUUID(), conversationId, mode: "event_or_deadline", label: "Pipeline", runId: "pipeline-7",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), successPrompt: "old success", failurePrompt: "old failure",
    timeoutPrompt: "old timeout", selection, eventTokenHash: "unchanged-hash",
  });
  const updated = db.updateWakePlanPrompts({
    id: plan.id, expectedRevision: 0, successPrompt: "new success", failurePrompt: "new failure", timeoutPrompt: "new timeout",
  });
  assert.equal(updated?.revision, 1);
  assert.equal(updated?.event_token_hash, "unchanged-hash");
  assert.equal(db.updateWakePlanPrompts({
    id: plan.id, expectedRevision: 0, successPrompt: "stale", failurePrompt: "stale", timeoutPrompt: "stale",
  }), undefined);
  assert.equal(db.recordWakeEvent(plan.id, "done", "success", null, crypto.randomUUID()).pendingPrompt?.content, "new success");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("job automation API hides secrets and accepts idempotent event receipts", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-api-"));
  const secret = "wake-test-session-secret-that-is-longer-than-thirty-two-characters";
  const password = "Wake-Test-Password-2026!";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    basePath: "",
    username: "owner", displayName: "Owner", passwordHash: bcrypt.hashSync(password, 8), sessionSecret: secret,
    publicBaseUrl: "https://codex-web.example", queueAutoStart: false,
  });
  const httpServer = instance.app.listen(0);
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "Event API", selection, LEGACY_USER_ID);
  instance.db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "Wait for OCR", created_at: new Date().toISOString() });
  instance.db.createJob(jobId, conversationId, messageId, selection);
  instance.db.updateJob(jobId, "running");
  const token = createJobAutomationToken(secret, jobId, conversationId);
  assert.equal(verifyJobAutomationToken(secret, token)?.jobId, jobId);
  assert.equal(verifyJobAutomationToken(`${secret}-wrong`, token), null);

  const armed = await request(instance.app).post(`/api/automation/jobs/${jobId}/wake-plans`)
    .set("Authorization", `Bearer ${token}`).send({
      mode: "event_or_deadline", delaySeconds: 3600, label: "Wait for OCR", runId: "ocr-api-1",
      successPrompt: "OCR done.", failurePrompt: "OCR failed.", timeoutPrompt: "OCR timed out.",
    }).expect(201);
  assert.equal(armed.body.wakePlan.event_token_hash, undefined);
  assert.ok(armed.body.signal.token);
  await request(instance.app).post(`/api/automation/jobs/${jobId}/wake-plans`)
    .set("Authorization", "Bearer invalid").send({ mode: "time", delaySeconds: 1, successPrompt: "no" }).expect(401);

  const browser = request.agent(instance.app);
  const login = await browser.post("/api/auth/login").send({ username: "owner", password }).expect(200);
  const csrf = login.body.csrfToken as string;
  const visible = await browser.get(`/api/conversations/${conversationId}/wake-plans/active`).expect(200);
  assert.equal(visible.body.wakePlan.id, armed.body.wakePlan.id);
  assert.equal(visible.body.wakePlan.event_token_hash, undefined);
  await browser.patch(`/api/conversations/${conversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .send({ revision: 0, successPrompt: "edited", failurePrompt: "failed", timeoutPrompt: "timeout" }).expect(403);
  const edited = await browser.patch(`/api/conversations/${conversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", csrf).send({ revision: 0, successPrompt: "edited", failurePrompt: "failed", timeoutPrompt: "timeout" }).expect(200);
  assert.equal(edited.body.wakePlan.revision, 1);

  const planId = armed.body.wakePlan.id as string;
  const eventToken = armed.body.signal.token as string;
  const event = { eventId: "ocr-event-1", kind: "success", summary: "42 pages" };
  const first = await request(instance.app).post(`/api/automation/wake-plans/${planId}/events`)
    .set("Authorization", `Bearer ${eventToken}`).send(event).expect(200);
  assert.equal(first.body.status, "triggered");
  const duplicate = await request(instance.app).post(`/api/automation/wake-plans/${planId}/events`)
    .set("Authorization", `Bearer ${eventToken}`).send(event).expect(200);
  assert.equal(duplicate.body.status, "duplicate");
  assert.equal(instance.db.listPendingPrompts(conversationId).map((prompt) => prompt.content).join(), "edited");

  const timePlan = await browser.post(`/api/conversations/${conversationId}/wake-plans`)
    .set("X-CSRF-Token", csrf).send({ delaySeconds: 3600, prompt: "continue later" }).expect(201);
  await browser.post(`/api/conversations/${conversationId}/wake-plans/${timePlan.body.wakePlan.id}/cancel`)
    .set("X-CSRF-Token", csrf).expect(200);
});

test("wait CLI writes event secrets only to a protected receipt", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-cli-"));
  const secret = "wake-cli-session-secret-that-is-longer-than-thirty-two-characters";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    basePath: "",
    username: "owner", passwordHash: bcrypt.hashSync("unused-password", 8), sessionSecret: secret, queueAutoStart: false,
  });
  const server = instance.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "CLI", selection, LEGACY_USER_ID);
  instance.db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "wait", created_at: new Date().toISOString() });
  instance.db.createJob(jobId, conversationId, messageId, selection);
  instance.db.updateJob(jobId, "running");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const environment = {
    ...process.env,
    CODEX_WEB_AUTOMATION_BASE_URL: `http://127.0.0.1:${address.port}`,
    CODEX_WEB_AUTOMATION_TOKEN: createJobAutomationToken(secret, jobId, conversationId),
    CODEX_WEB_AUTOMATION_JOB_ID: jobId,
  };
  const receipt = path.join(root, "supervisor", "receipt.json");
  const cli = path.join(process.cwd(), "dist-server", "server", "wait-cli.js");
  const armed = await execFileAsync(process.execPath, [cli, "event", "--deadline-seconds", "3600",
    "--success-prompt", "done", "--failure-prompt", "failed", "--timeout-prompt", "timeout", "--receipt", receipt,
  ], { env: environment });
  assert.match(armed.stdout, /signalCredentialStored/);
  assert.doesNotMatch(armed.stdout, /eventToken/);
  assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
  const body = JSON.parse(fs.readFileSync(receipt, "utf8")) as { wakePlanId: string; eventUrl: string; eventToken: string };
  body.eventUrl = `http://127.0.0.1:${address.port}/api/automation/wake-plans/${body.wakePlanId}/events`;
  fs.writeFileSync(receipt, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  const signalled = await execFileAsync(process.execPath, [cli, "signal", "--receipt", receipt, "--status", "success", "--retry-seconds", "0"], { env: environment });
  assert.match(signalled.stdout, /triggered/);
  assert.equal(instance.db.listPendingPrompts(conversationId)[0]?.content, "done");
});
