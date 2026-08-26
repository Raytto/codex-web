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

const selection = { model: "gpt-5.4", reasoningEffort: "high" };
const execFileAsync = promisify(execFile);

test("wake plans persist across restart and only one terminal event enqueues a continuation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-db-"));
  let db = new AppDatabase(root);
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "持久等待测试", selection);
  const planId = crypto.randomUUID();
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  db.createWakePlan({
    id: planId,
    conversationId,
    mode: "event_or_deadline",
    label: "等待 OCR",
    runId: "ocr-42",
    deadlineAt,
    successPrompt: "OCR 已完成，请继续。",
    failurePrompt: "OCR 失败，请检查。",
    timeoutPrompt: "OCR 等待超时，请检查状态。",
    selection,
    eventTokenHash: "hash",
  });
  assert.equal(db.getConversation(conversationId)?.active_wake_count, 1);
  assert.equal(db.getConversation(conversationId)?.active_wake_mode, "event_or_deadline");
  assert.equal(db.getConversation(conversationId)?.active_wake_label, "等待 OCR");
  db.close();

  db = new AppDatabase(root);
  assert.equal(db.getActiveWakePlan(conversationId)?.run_id, "ocr-42");
  const success = db.recordWakeEvent(planId, "ocr-complete", "success", "42 pages", crypto.randomUUID());
  assert.equal(success.status, "triggered");
  assert.equal(success.pendingPrompt?.content, "OCR 已完成，请继续。");
  const deadline = db.recordWakeEvent(planId, `deadline:${deadlineAt}`, "deadline", null, crypto.randomUUID());
  assert.equal(deadline.status, "stale");
  assert.equal(db.listPendingPrompts(conversationId).length, 1);
  assert.equal(db.recordWakeEvent(planId, "ocr-complete", "success", null, crypto.randomUUID()).status, "duplicate");
  assert.equal(db.getConversation(conversationId)?.active_wake_count, 0);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("armed waits hold ordinary pending prompts and put their continuation first when triggered", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-pending-barrier-"));
  const db = new AppDatabase(root);
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "等待期间待发送测试", selection);
  const firstPending = db.createPendingPrompt(crypto.randomUUID(), conversationId, "用户等待期间追加的任务", selection);
  assert.equal(db.getNextDispatchablePendingPrompt()?.id, firstPending.id);

  const plan = db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId,
    mode: "time",
    label: "十分钟后继续",
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    successPrompt: "继续原来的等待任务。",
    failurePrompt: "继续原来的等待任务。",
    timeoutPrompt: "继续原来的等待任务。",
    selection,
  });
  assert.equal(db.getNextDispatchablePendingPrompt(), undefined);
  assert.deepEqual(db.listDispatchablePendingPrompts(), []);

  const triggered = db.recordWakeEvent(plan.id, `deadline:${plan.deadline_at}`, "deadline", null, crypto.randomUUID());
  assert.equal(triggered.status, "triggered");
  assert.deepEqual(db.listPendingPrompts(conversationId).map((prompt) => [prompt.content, prompt.position]), [
    ["继续原来的等待任务。", 1],
    ["用户等待期间追加的任务", 2],
  ]);
  assert.equal(db.getNextDispatchablePendingPrompt()?.id, triggered.pendingPrompt?.id);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("manual insert materializes a selected pending prompt without cancelling an armed wait", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-manual-insert-"));
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "demo-owner",
    passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "wake-insert-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const browser = request.agent(instance.app);
  const login = await browser.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const created = await browser.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;
  const plan = instance.db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId,
    mode: "event_or_deadline",
    label: "等待外部事件",
    runId: "manual-insert-test",
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    successPrompt: "外部事件完成后继续。",
    failurePrompt: "外部事件失败后检查。",
    timeoutPrompt: "等待超时后检查。",
    selection,
    eventTokenHash: "test-hash",
  });

  const submitted = await browser.post(`/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ message: "现在插入执行" })
    .expect(202);
  const pending = submitted.body.pendingPrompt;
  assert.equal(submitted.body.queued, true);
  assert.ok(pending?.id);

  await instance.pumpQueue();
  assert.equal(instance.db.listMessages(conversationId).length, 0);
  assert.equal(instance.db.listActiveJobsForConversation(conversationId).length, 0);
  assert.equal(instance.db.listPendingPrompts(conversationId)[0]?.id, pending.id);

  const inserted = await browser.post(`/api/conversations/${conversationId}/pending-prompts/${pending.id}/steer`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .expect(200);
  assert.equal(inserted.body.mode, "insert");
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["现在插入执行"]);
  assert.equal(instance.db.listMessages(conversationId)[0]?.is_scheduled, 0);
  assert.equal(instance.db.listActiveJobsForConversation(conversationId)[0]?.status, "queued");
  assert.equal(instance.db.getWakePlan(plan.id)?.state, "armed");
});

test("absolute wake reschedule accepts future times and immediately triggers past times", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-reschedule-"));
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "wake-reschedule",
    passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "wake-reschedule-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const browser = request.agent(instance.app);
  const login = await browser.post("/api/auth/login").send({ username: "wake-reschedule", password: "fixture" }).expect(200);
  const created = await browser.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;
  const plan = instance.db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId,
    mode: "time",
    label: "可调整的时间",
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    successPrompt: "时间到了继续检查。",
    failurePrompt: "时间到了继续检查。",
    timeoutPrompt: "时间到了继续检查。",
    selection,
  });
  const futureAt = new Date(Date.now() + 7_200_000).toISOString();
  const future = await browser.post(`/api/conversations/${conversationId}/wake-plans/${plan.id}/reschedule`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ deadlineAt: futureAt })
    .expect(200);
  assert.equal(future.body.triggered, false);
  assert.equal(future.body.wakePlan.state, "armed");
  assert.equal(future.body.wakePlan.deadline_at, futureAt);
  await browser.post(`/api/conversations/${conversationId}/wake-plans/${plan.id}/reschedule`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ deadlineAt: futureAt, delaySeconds: 60 })
    .expect(400);

  const pastAt = new Date(Date.now() - 1_000).toISOString();
  const past = await browser.post(`/api/conversations/${conversationId}/wake-plans/${plan.id}/reschedule`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ deadlineAt: pastAt })
    .expect(200);
  assert.equal(past.body.triggered, true);
  assert.equal(past.body.wakePlan.state, "triggered");
  assert.equal(instance.db.getWakePlan(plan.id)?.trigger_cause, "deadline");
  assert.deepEqual(instance.db.listPendingPrompts(conversationId).map((prompt) => prompt.content), ["时间到了继续检查。"]);
});

test("relative wake reschedule adds each delay to the existing deadline", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-relative-wake-reschedule-"));
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "relative-wake-reschedule",
    passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "relative-wake-reschedule-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const browser = request.agent(instance.app);
  const login = await browser.post("/api/auth/login").send({ username: "relative-wake-reschedule", password: "fixture" }).expect(200);
  const created = await browser.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;
  const initialDeadline = new Date(Date.now() + 3_600_000).toISOString();
  const plan = instance.db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId,
    mode: "time",
    label: "按现有时间推迟",
    deadlineAt: initialDeadline,
    successPrompt: "时间到了继续检查。",
    failurePrompt: "时间到了继续检查。",
    timeoutPrompt: "时间到了继续检查。",
    selection,
  });
  const first = await browser.post(`/api/conversations/${conversationId}/wake-plans/${plan.id}/reschedule`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ delaySeconds: 3_600 })
    .expect(200);
  const firstDeadline = new Date(initialDeadline).getTime() + 3_600_000;
  assert.equal(new Date(first.body.wakePlan.deadline_at).getTime(), firstDeadline);
  assert.equal(first.body.triggered, false);

  const second = await browser.post(`/api/conversations/${conversationId}/wake-plans/${plan.id}/reschedule`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ delaySeconds: 3_600 })
    .expect(200);
  assert.equal(new Date(second.body.wakePlan.deadline_at).getTime(), firstDeadline + 3_600_000);
  assert.equal(second.body.triggered, false);
  assert.equal(instance.db.getWakePlan(plan.id)?.state, "armed");
});

test("time waits become due and use the configured continuation prompt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-time-wake-"));
  const db = new AppDatabase(root);
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "定时续跑测试", selection);
  const plan = db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId,
    mode: "time",
    label: "两小时后继续",
    deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    successPrompt: "检查状态并继续；必要时再次等待。",
    failurePrompt: "检查状态并继续；必要时再次等待。",
    timeoutPrompt: "检查状态并继续；必要时再次等待。",
    selection,
  });
  assert.deepEqual(db.listDueWakePlans(new Date().toISOString()).map((item) => item.id), [plan.id]);
  const result = db.recordWakeEvent(plan.id, `deadline:${plan.deadline_at}`, "deadline", null, crypto.randomUUID());
  assert.equal(result.status, "triggered");
  assert.equal(result.pendingPrompt?.content, "检查状态并继续；必要时再次等待。");
  assert.equal(result.plan?.trigger_cause, "deadline");
  assert.equal(db.getConversation(conversationId)?.pinned_at, null);
  const scheduledMessageId = crypto.randomUUID();
  const job = db.materializePendingPrompt(result.pendingPrompt!.id, scheduledMessageId, crypto.randomUUID());
  assert.ok(job);
  assert.equal(db.getMessage(scheduledMessageId)?.is_scheduled, 1);
  db.updateJob(job!.id, "running");
  db.updateConversation(conversationId, { status: "running" });
  assert.equal(db.getConversation(conversationId)?.pinned_at, null);
  db.sqlite.prepare("UPDATE messages SET is_scheduled=0 WHERE id=?").run(scheduledMessageId);
  db.sqlite.prepare("DELETE FROM schema_migrations WHERE version=2026082002").run();
  db.close();
  const migrated = new AppDatabase(root);
  assert.equal(migrated.getMessage(scheduledMessageId)?.is_scheduled, 1);
  migrated.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("agent waits immediately create a fresh timestamped conversation and attach the wait to it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-new-conversation-wake-"));
  const db = new AppDatabase(root);
  const source = db.createConversation(crypto.randomUUID(), "Last War 巡检 · 08-14 09:00", selection, LEGACY_USER_ID);
  const sourceMessageId = crypto.randomUUID();
  const sourceJobId = crypto.randomUUID();
  db.addMessage({ id: sourceMessageId, conversation_id: source.id, role: "user", content: "安排下一次巡检", created_at: new Date().toISOString() });
  db.createJob(sourceJobId, source.id, sourceMessageId, selection);
  db.updateJob(sourceJobId, "running");
  db.setConversationPinnedForUser(source.id, LEGACY_USER_ID, true);
  const plan = db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId: source.id,
    createdByJobId: sourceJobId,
    mode: "time",
    label: "三小时后新对话",
    deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    successPrompt: "运行一次巡检并再次登记新对话续跑。",
    failurePrompt: "运行一次巡检并再次登记新对话续跑。",
    timeoutPrompt: "运行一次巡检并再次登记新对话续跑。",
    newConversation: true,
    selection,
  });
  assert.equal(plan.new_conversation, 1);
  assert.ok(plan.target_conversation_id);
  assert.equal(plan.conversation_id, plan.target_conversation_id);
  const target = db.getConversation(plan.target_conversation_id!);
  assert.ok(target);
  assert.notEqual(target?.id, source.id);
  assert.match(target?.title ?? "", /^三小时后新对话 · \d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(target?.title_source, "manual");
  assert.equal(db.setAiConversationTitleIfDefault(target!.id, "自动标题不应覆盖时间"), false);
  assert.equal(target?.project_id, source.project_id);
  assert.equal(target?.user_id, source.user_id);
  assert.equal(target?.agent_model, selection.model);
  assert.equal(target?.reasoning_effort, selection.reasoningEffort);
  assert.equal(db.getConversation(source.id)?.pinned_at, null);
  assert.equal(db.getConversation(source.id)?.active_wake_count, 0);
  assert.equal(db.getConversation(target!.id)?.active_wake_count, 1);
  const secondPlan = db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId: source.id,
    createdByJobId: sourceJobId,
    mode: "time",
    label: "重复安排不应留下空会话",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    successPrompt: "重复计划",
    failurePrompt: "重复计划",
    timeoutPrompt: "重复计划",
    newConversation: true,
    selection,
  });
  assert.ok(secondPlan.target_conversation_id);
  assert.notEqual(secondPlan.target_conversation_id, target?.id);
  assert.equal((db.sqlite.prepare("SELECT count(*) AS value FROM conversations").get() as { value: number }).value, 3);
  const result = db.recordWakeEvent(plan.id, `deadline:${plan.deadline_at}`, "deadline", null, crypto.randomUUID());
  assert.equal(result.status, "triggered");
  assert.ok(result.targetConversation);
  assert.equal(result.targetConversation?.id, target?.id);
  assert.equal(db.listPendingPrompts(source.id).length, 0);
  assert.equal(db.listPendingPrompts(result.targetConversation!.id)[0]?.content, "运行一次巡检并再次登记新对话续跑。");
  assert.equal(db.getWakePlan(plan.id)?.target_conversation_id, result.targetConversation?.id);
  assert.equal(db.recordWakeEvent(plan.id, "second-trigger", "deadline", null, crypto.randomUUID()).status, "stale");
  const count = db.sqlite.prepare("SELECT count(*) AS value FROM conversations").get() as { value: number };
  assert.equal(count.value, 3);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("armed wake prompts use optimistic revisions and cannot change after triggering", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-edit-"));
  const db = new AppDatabase(root);
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "提示词并发编辑", selection);
  const plan = db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId,
    mode: "event_or_deadline",
    label: "等待外部流水线",
    runId: "pipeline-7",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    successPrompt: "旧成功提示词",
    failurePrompt: "旧失败提示词",
    timeoutPrompt: "旧超时提示词",
    selection,
    eventTokenHash: "unchanged-token-hash",
  });
  assert.equal(plan.revision, 0);
  const updated = db.updateWakePlanPrompts({
    id: plan.id,
    expectedRevision: 0,
    successPrompt: "新成功提示词",
    failurePrompt: "新失败提示词",
    timeoutPrompt: "新超时提示词",
  });
  assert.equal(updated?.revision, 1);
  assert.equal(updated?.deadline_at, plan.deadline_at);
  assert.equal(updated?.run_id, plan.run_id);
  assert.equal(updated?.agent_model, plan.agent_model);
  assert.equal(updated?.reasoning_effort, plan.reasoning_effort);
  assert.equal(updated?.event_token_hash, "unchanged-token-hash");
  assert.equal(db.updateWakePlanPrompts({
    id: plan.id,
    expectedRevision: 0,
    successPrompt: "过期页面不应覆盖",
    failurePrompt: "过期页面不应覆盖",
    timeoutPrompt: "过期页面不应覆盖",
  }), undefined);
  const triggered = db.recordWakeEvent(plan.id, "pipeline-complete", "success", null, crypto.randomUUID());
  assert.equal(triggered.pendingPrompt?.content, "新成功提示词");
  assert.equal(db.updateWakePlanPrompts({
    id: plan.id,
    expectedRevision: 1,
    successPrompt: "终态不应覆盖",
    failurePrompt: "终态不应覆盖",
    timeoutPrompt: "终态不应覆盖",
  }), undefined);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the live scheduler recovers a due wait while maintenance keeps the continuation safely queued", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-scheduler-"));
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, ".codex-update-maintenance"), "active\n", "utf8");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot,
    tenantRoot: path.join(root, "tenants"),
    username: "demo-owner",
    passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "wake-scheduler-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: true,
  });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversationId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "调度器恢复测试", selection, LEGACY_USER_ID);
  const plan = instance.db.createWakePlan({
    id: crypto.randomUUID(),
    conversationId,
    mode: "time",
    label: "服务重启后到点",
    deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    successPrompt: "调度器已恢复，请继续。",
    failurePrompt: "调度器已恢复，请继续。",
    timeoutPrompt: "调度器已恢复，请继续。",
    selection,
  });
  const deadline = Date.now() + 2_500;
  while (instance.db.getWakePlan(plan.id)?.state === "armed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(instance.db.getWakePlan(plan.id)?.state, "triggered");
  assert.equal(instance.db.listPendingPrompts(conversationId)[0]?.content, "调度器已恢复，请继续。");
  assert.equal(instance.db.listActiveJobsForConversation(conversationId).length, 0);
});

test("job-scoped automation API redacts event secrets and accepts idempotent completion receipts", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-wake-api-"));
  const secret = "wake-test-session-secret-that-is-longer-than-thirty-two-characters";
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "demo-owner",
    passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: secret,
    publicBaseUrl: "https://codex-web.test",
    queueAutoStart: false,
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
  instance.db.createConversation(conversationId, "事件 API 测试", selection, LEGACY_USER_ID);
  instance.db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "等待 OCR", created_at: new Date().toISOString() });
  instance.db.createJob(jobId, conversationId, messageId, selection);
  instance.db.updateJob(jobId, "running");
  const token = createJobAutomationToken(secret, jobId, conversationId);
  assert.equal(verifyJobAutomationToken(secret, token)?.jobId, jobId);
  assert.equal(verifyJobAutomationToken(`${secret}-wrong`, token), null);
  const armed = await request(instance.app)
    .post(`/api/automation/jobs/${jobId}/wake-plans`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      mode: "event_or_deadline",
      delaySeconds: 3600,
      label: "等待 OCR",
      runId: "ocr-api-1",
      successPrompt: "OCR 完成，继续整理。",
      failurePrompt: "OCR 失败，检查日志。",
      timeoutPrompt: "OCR 超时，检查运行状态。",
      newConversation: true,
    })
    .expect(201);
  assert.equal(armed.body.wakePlan.event_token_hash, undefined);
  const targetConversationId = armed.body.wakePlan.target_conversation_id as string;
  assert.ok(targetConversationId);
  assert.equal(armed.body.wakePlan.conversation_id, targetConversationId);
  assert.equal(armed.body.targetConversation.id, targetConversationId);
  assert.notEqual(targetConversationId, conversationId);
  assert.match(armed.body.signal.url, /\/api\/automation\/wake-plans\/.+\/events$/);
  assert.ok(armed.body.signal.token);
  assert.equal(instance.db.getConversation(targetConversationId)?.title_source, "manual");
  assert.match(instance.db.getConversation(targetConversationId)?.title ?? "", /^等待 OCR · \d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(instance.db.getConversation(conversationId)?.active_wake_count, 0);
  assert.equal(instance.db.getConversation(targetConversationId)?.active_wake_count, 1);
  const browser = request.agent(instance.app);
  const login = await browser.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const csrfToken = login.body.csrfToken as string;
  assert.equal((await browser.get(`/api/conversations/${conversationId}/wake-plans/active`).expect(200)).body.wakePlan, null);
  const visiblePlan = await browser.get(`/api/conversations/${targetConversationId}/wake-plans/active`).expect(200);
  assert.equal(visiblePlan.body.wakePlan.id, armed.body.wakePlan.id);
  assert.equal(visiblePlan.body.wakePlan.mode, "event_or_deadline");
  assert.equal(visiblePlan.body.wakePlan.revision, 0);
  assert.equal(visiblePlan.body.wakePlan.new_conversation, 1);
  assert.equal(visiblePlan.body.wakePlan.agent_model, selection.model);
  assert.equal(visiblePlan.body.wakePlan.reasoning_effort, selection.reasoningEffort);
  assert.equal(visiblePlan.body.wakePlan.target_conversation_id, targetConversationId);
  assert.equal(visiblePlan.body.wakePlan.event_token_hash, undefined);
  const editBody = {
    revision: 0,
    successPrompt: "用户实时改写：OCR 完成后继续。",
    failurePrompt: "用户实时改写：OCR 失败后检查。",
    timeoutPrompt: "用户实时改写：OCR 超时后检查。",
    model: "gpt-5.6-sol",
    reasoningEffort: selection.reasoningEffort,
  };
  const eventTokenHashBeforeEdit = instance.db.getWakePlan(armed.body.wakePlan.id)?.event_token_hash;
  await browser.patch(`/api/conversations/${targetConversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .send(editBody)
    .expect(403);
  await browser.patch(`/api/conversations/${targetConversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", csrfToken)
    .send({ ...editBody, successPrompt: "   " })
    .expect(400);
  await browser.patch(`/api/conversations/${targetConversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", csrfToken)
    .send({ ...editBody, successPrompt: "x".repeat(20_001) })
    .expect(400);
  const forbiddenFields = await browser.patch(`/api/conversations/${targetConversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", csrfToken)
    .send({ ...editBody, eventToken: "browser-must-not-submit-this", event_token_hash: "nor-this" })
    .expect(400);
  assert.equal(forbiddenFields.body.code, "WAKE_PROMPTS_INVALID");
  assert.equal(instance.db.getWakePlan(armed.body.wakePlan.id)?.revision, 0);
  assert.equal(instance.db.getWakePlan(armed.body.wakePlan.id)?.event_token_hash, eventTokenHashBeforeEdit);
  const edited = await browser.patch(`/api/conversations/${targetConversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", csrfToken)
    .send(editBody)
    .expect(200);
  assert.equal(edited.body.wakePlan.revision, 1);
  assert.equal(edited.body.wakePlan.success_prompt, editBody.successPrompt);
  assert.equal(edited.body.wakePlan.failure_prompt, editBody.failurePrompt);
  assert.equal(edited.body.wakePlan.timeout_prompt, editBody.timeoutPrompt);
  assert.equal(edited.body.wakePlan.agent_model, editBody.model);
  assert.equal(edited.body.wakePlan.reasoning_effort, editBody.reasoningEffort);
  assert.equal(edited.body.wakePlan.deadline_at, armed.body.wakePlan.deadline_at);
  const stale = await browser.patch(`/api/conversations/${targetConversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", csrfToken)
    .send(editBody)
    .expect(409);
  assert.equal(stale.body.code, "WAKE_PLAN_CONFLICT");

  const otherUserId = crypto.randomUUID();
  const otherPassword = "fixture";
  const now = new Date().toISOString();
  instance.db.createUser({
    id: otherUserId,
    username: "wake-other",
    display_name: "Wake Other",
    password_hash: bcrypt.hashSync(otherPassword, 8),
    role: "member",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  const otherBrowser = request.agent(instance.app);
  const otherLogin = await otherBrowser.post("/api/auth/login").send({ username: "wake-other", password: otherPassword }).expect(200);
  await otherBrowser.patch(`/api/conversations/${targetConversationId}/wake-plans/${armed.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", otherLogin.body.csrfToken)
    .send({ ...editBody, revision: 1 })
    .expect(404);
  await request(instance.app)
    .post(`/api/automation/jobs/${jobId}/wake-plans`)
    .set("Authorization", "Bearer invalid")
    .send({ mode: "time", delaySeconds: 1, successPrompt: "no" })
    .expect(401);
  await request(instance.app)
    .post(`/api/automation/jobs/${jobId}/wake-plans`)
    .set("Authorization", `Bearer ${token}`)
    .send({ mode: "time", delaySeconds: 60, successPrompt: "无效覆盖", model: "missing-model", reasoningEffort: "high" })
    .expect(400);

  const planId = armed.body.wakePlan.id as string;
  const eventToken = armed.body.signal.token as string;
  const event = { eventId: "ocr-event-1", kind: "success", summary: "42 pages" };
  const first = await request(instance.app)
    .post(`/api/automation/wake-plans/${planId}/events`)
    .set("Authorization", `Bearer ${eventToken}`)
    .send(event)
    .expect(200);
  assert.equal(first.body.status, "triggered");
  const duplicate = await request(instance.app)
    .post(`/api/automation/wake-plans/${planId}/events`)
    .set("Authorization", `Bearer ${eventToken}`)
    .send(event)
    .expect(200);
  assert.equal(duplicate.body.status, "duplicate");
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  const triggeredPlan = instance.db.getWakePlan(planId)!;
  assert.ok(triggeredPlan.target_conversation_id);
  assert.equal(instance.db.listPendingPrompts(triggeredPlan.target_conversation_id!)[0].content, editBody.successPrompt);
  const terminalEdit = await browser.patch(`/api/conversations/${targetConversationId}/wake-plans/${planId}/prompts`)
    .set("X-CSRF-Token", csrfToken)
    .send({ ...editBody, revision: 1 })
    .expect(409);
  assert.equal(terminalEdit.body.code, "WAKE_PLAN_CONFLICT");

  const conversationOptions = await browser.get(`/api/agent-options?conversationId=${conversationId}`).expect(200);
  const manualSelection = conversationOptions.body.selection as { model: string; reasoningEffort: string };
  assert.ok(manualSelection.model);
  assert.ok(manualSelection.reasoningEffort);
  const cancellable = await request(instance.app)
    .post(`/api/automation/jobs/${jobId}/wake-plans`)
    .set("Authorization", `Bearer ${token}`)
    .send({ mode: "time", delaySeconds: 3600, successPrompt: "不应触发的新会话任务", newConversation: true, model: manualSelection.model, reasoningEffort: manualSelection.reasoningEffort })
    .expect(201);
  assert.notEqual(cancellable.body.wakePlan.conversation_id, conversationId);
  assert.equal(cancellable.body.wakePlan.agent_model, manualSelection.model);
  assert.equal(cancellable.body.wakePlan.reasoning_effort, manualSelection.reasoningEffort);
  await request(instance.app)
    .post(`/api/automation/jobs/${jobId}/wake-plans/${cancellable.body.wakePlan.id}/cancel`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(instance.db.getWakePlan(cancellable.body.wakePlan.id)?.state, "cancelled");

  const countBeforeInvalidManual = (instance.db.sqlite.prepare("SELECT count(*) AS value FROM conversations").get() as { value: number }).value;
  await browser.post(`/api/conversations/${conversationId}/wake-plans`)
    .set("X-CSRF-Token", csrfToken)
    .send({ delaySeconds: 3600, prompt: "无效手动续跑", newConversation: true, model: "missing-model", reasoningEffort: manualSelection.reasoningEffort })
    .expect(400);
  assert.equal((instance.db.sqlite.prepare("SELECT count(*) AS value FROM conversations").get() as { value: number }).value, countBeforeInvalidManual);

  const manualNewConversation = await browser.post(`/api/conversations/${conversationId}/wake-plans`)
    .set("X-CSRF-Token", csrfToken)
    .send({
      delaySeconds: 3600,
      label: "手动新会话续跑",
      prompt: "在新会话继续。",
      newConversation: true,
      model: manualSelection.model,
      reasoningEffort: manualSelection.reasoningEffort,
    })
    .expect(201);
  const manualTargetId = manualNewConversation.body.targetConversation.id as string;
  assert.notEqual(manualTargetId, conversationId);
  assert.equal(manualNewConversation.body.wakePlan.conversation_id, manualTargetId);
  assert.equal(manualNewConversation.body.wakePlan.agent_model, manualSelection.model);
  assert.equal(manualNewConversation.body.wakePlan.reasoning_effort, manualSelection.reasoningEffort);
  assert.equal(instance.db.getConversation(conversationId)?.active_wake_count, 0);
  assert.equal(instance.db.getConversation(manualTargetId)?.active_wake_count, 1);
  await browser.post(`/api/conversations/${manualTargetId}/wake-plans/${manualNewConversation.body.wakePlan.id}/cancel`)
    .set("X-CSRF-Token", csrfToken)
    .expect(200);

  const timePlan = await browser.post(`/api/conversations/${conversationId}/wake-plans`)
    .set("X-CSRF-Token", csrfToken)
    .send({ delaySeconds: 3600, label: "时间模式编辑测试", prompt: "时间模式旧提示词" })
    .expect(201);
  await browser.patch(`/api/conversations/${conversationId}/wake-plans/${timePlan.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", csrfToken)
    .send({ revision: 0, successPrompt: "时间模式新提示词", failurePrompt: "时间模式不能提交这个字段" })
    .expect(400);
  const editedTimePlan = await browser.patch(`/api/conversations/${conversationId}/wake-plans/${timePlan.body.wakePlan.id}/prompts`)
    .set("X-CSRF-Token", csrfToken)
    .send({ revision: 0, successPrompt: "时间模式新提示词" })
    .expect(200);
  assert.equal(editedTimePlan.body.wakePlan.success_prompt, "时间模式新提示词");
  assert.equal(editedTimePlan.body.wakePlan.failure_prompt, "时间模式新提示词");
  assert.equal(editedTimePlan.body.wakePlan.timeout_prompt, "时间模式新提示词");
  await browser.post(`/api/conversations/${conversationId}/wake-plans/${timePlan.body.wakePlan.id}/cancel`)
    .set("X-CSRF-Token", csrfToken)
    .expect(200);

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const receipt = path.join(root, "supervisor", "ocr-receipt.json");
  const cli = path.join(process.cwd(), "dist-server", "server", "wait-cli.js");
  const cliEnvironment = {
    ...process.env,
    CODEX_WEB_AUTOMATION_BASE_URL: `http://127.0.0.1:${address.port}`,
    CODEX_WEB_AUTOMATION_TOKEN: token,
    CODEX_WEB_AUTOMATION_JOB_ID: jobId,
  };
  const armedByCli = await execFileAsync(process.execPath, [cli, "event",
    "--deadline-seconds", "3600",
    "--success-prompt", "CLI 收到完成事件。",
    "--failure-prompt", "CLI 收到失败事件。",
    "--timeout-prompt", "CLI 等待超时。",
    "--receipt", receipt,
    "--run-id", "ocr-cli-2",
  ], { env: cliEnvironment });
  assert.match(armedByCli.stdout, /signalCredentialStored/);
  const receiptBody = fs.readFileSync(receipt, "utf8");
  assert.match(receiptBody, /eventToken/);
  assert.doesNotMatch(armedByCli.stdout, /eventToken/);
  const localReceipt = JSON.parse(receiptBody) as { wakePlanId: string; eventUrl: string; eventToken: string; deadlineAt: string; version: 1 };
  localReceipt.eventUrl = `http://127.0.0.1:${address.port}/api/automation/wake-plans/${localReceipt.wakePlanId}/events`;
  fs.writeFileSync(receipt, `${JSON.stringify(localReceipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const signalledByCli = await execFileAsync(process.execPath, [cli, "signal",
    "--receipt", receipt,
    "--status", "success",
    "--event-id", "ocr-cli-event-2",
    "--summary", "CLI end-to-end",
    "--retry-seconds", "0",
  ], { env: cliEnvironment });
  assert.match(signalledByCli.stdout, /triggered/);
  assert.deepEqual(instance.db.listPendingPrompts(conversationId).map((prompt) => prompt.content), [
    "CLI 收到完成事件。",
  ]);
});
