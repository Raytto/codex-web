import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import { AppDatabase, LEGACY_USER_ID, type RemoteThreadSnapshotInput } from "../server/db.js";
import { createApp } from "../server/app.js";
import { extractTitleRequestText, remotePreviewTitle } from "../server/title-request.js";
import { buildAgentTurnPrompt } from "../server/agent-context.js";
import { buildRemoteTurnPrompt } from "../remote-worker/src/agent-context.js";
import type { RunRequest } from "../remote-worker/src/protocol.js";

const attachments = [{ name: "截图.png", path: "C:/runs/job/uploads/截图.png", mimeType: "image/png" }];
const task = "补齐玩家摩托车与觉醒配置";
const wrapped = (userPrompt = task, files = attachments) => buildRemoteTurnPrompt({
  turnContext: { userPrompt, imageInput: "preload", interruptedContext: "历史任务与本轮无关" },
} as RunRequest, files).prompt;
const selection = { model: "gpt-6-astra", reasoningEffort: "high" };
const snapshot = (content: string): RemoteThreadSnapshotInput => ({
  id: crypto.randomUUID(), name: "本轮附件：", nameSource: "preview", createdAt: 1, updatedAt: 2, status: "idle",
  messages: [{ turnId: "turn-1", itemId: "user-1", role: "user", content, createdAt: "2026-11-04T00:00:00Z" }],
});

test("title requests unwrap real attachment builders and retain task semantics", () => {
  for (const files of [attachments, [{ name: "data.xlsx", path: "/tmp/data.xlsx", mimeType: "application/octet-stream" }]]) {
    assert.equal(extractTitleRequestText(wrapped(task, files)), task);
    assert.equal(extractTitleRequestText(buildAgentTurnPrompt({ userPrompt: task, attachments: files,
      imageInputDecision: { preload: true, reason: "image" }, storageLifecycleEnabled: true })), task);
  }
  assert.equal(extractTitleRequestText(wrapped().replaceAll("\n", "\r\n")), task);
  assert.equal(extractTitleRequestText(`<execution_context>\nC:/workspace\n</execution_context>\n\n${wrapped()}`), task);
  assert.equal(extractTitleRequestText(`<pp_agent_personal_context>\nprivate background\n</pp_agent_personal_context>\n\n${wrapped()}`), task);
  assert.equal(extractTitleRequestText(`${wrapped()}\n\n<pp_agent_wait_automation>\ninternal wait\n</pp_agent_wait_automation>`), task);
  assert.equal(extractTitleRequestText(buildRemoteTurnPrompt({ prompt: task } as RunRequest, attachments).prompt), task);
});

test("title extraction preserves discussion of wrapper vocabulary and malformed user examples", () => {
  for (const body of ["请解释本轮附件：这个标题为什么出现", "本轮附件：\n这里是我要讨论的真实需求", "处理图片时请保留细节", "解释 execution_context 的含义", "C:/work/config.ts 请修复这份配置", "/tmp/report.csv 请统计销售额"]) {
    assert.equal(extractTitleRequestText(body), body.replaceAll("\n", " "));
  }
  assert.equal(remotePreviewTitle(["本轮附件："], "本轮附件：", "新任务"), "本轮附件：");
});

test("attachment-only input and truncated metadata use a generic title", () => {
  assert.equal(extractTitleRequestText(wrapped("")), "");
  for (const preview of ["本轮附件：", "C:/runs/file.png", "/tmp/file.png", '"C:/runs/test image.png"', "<environment_context>"]) {
    assert.equal(remotePreviewTitle([], preview, "新任务"), "新任务");
  }
  assert.equal(remotePreviewTitle([wrapped("")], "本轮附件：", "本机任务"), "本机任务");
  assert.equal(remotePreviewTitle(["C:/runs/file.png"], "file.png", "本机任务"), "本机任务");
});

test("remote imports derive fallback from original body, remain idempotent and protect AI/manual names", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "title-import-"));
  const db = new AppDatabase(root);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "work", "C:/work", "remote:test");
  const native = snapshot(wrapped());
  const first = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, native, selection);
  assert.equal(first.conversation.title, task);
  assert.equal(first.conversation.title_source, "default");
  assert.equal(db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, native, selection).changed, false);
  assert.equal(db.setAiConversationTitleIfDefault(first.conversation.id, "摩托车觉醒配置"), true);
  assert.equal(db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, native, selection).conversation.title_source, "ai");
  db.updateConversation(first.conversation.id, { title: "新任务", titleSource: "manual" });
  const after = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, native, selection).conversation;
  assert.equal(after.title, "新任务"); assert.equal(after.title_source, "manual");
  const empty = db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, snapshot(wrapped("")), selection);
  assert.equal(empty.conversation.title, "本机任务");
  const pp = db.createConversation(crypto.randomUUID(), "新任务", selection, LEGACY_USER_ID, project.id);
  const snap = snapshot(wrapped("later task"));
  db.updateConversation(pp.id, { codexThreadId: snap.id });
  db.addMessage({ id: crypto.randomUUID(), conversation_id: pp.id, role: "user", content: task, created_at: "2026-11-03T00:00:00Z" });
  const job = db.createJob(crypto.randomUUID(), pp.id);
  db.updateJob(job.id, "running");
  assert.equal(db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, snap, selection).conversation.title, "新任务");
  db.updateJob(job.id, "failed");
  assert.equal(db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, snap, selection).conversation.title, task);
  assert.equal(db.importRemoteThread(LEGACY_USER_ID, project.id, project.executor_id, { ...snap, messages: [] }, selection).conversation.title, task);
});

for (const failure of ["timeout", "executor_offline"]) test(`attachment naming ${failure} keeps auditable fallback through sync and retries the original request`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "title-failure-"));
  const instance = createApp({ basePath: "", projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "tester", passwordHash: bcrypt.hashSync("title-test-password", 8), sessionSecret: "test-session-secret-longer-than-thirty-two-characters" });
  t.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "tester", password: "title-test-password" }).expect(200);
  const csrf = login.body.csrfToken;
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const conversation = created.body.conversation;
  instance.conversationTitles.generate = async () => { throw new Error(failure === "timeout" ? "title timed out" : failure); };
  const submitted = await agent.post(`/api/conversations/${conversation.id}/messages`).set("X-CSRF-Token", csrf)
    .field("message", task).attach("files", Buffer.from("fixture"), { filename: "data.txt", contentType: "text/plain" }).expect(202);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const db = instance.db;
  const audit = db.listConversationTitleAudits(conversation.id)[0];
  assert.equal(audit.status, "failed"); assert.equal(audit.applied, 0); assert.equal(audit.output_title, null);
  assert.equal(audit.error, failure);
  assert.equal(audit.request_excerpt, task);
  assert.deepEqual(JSON.parse(audit.context_json).attachmentNames, ["data.txt"]);
  db.updateJob(submitted.body.job.id, "failed");
  const snap = snapshot(wrapped());
  db.updateConversation(conversation.id, { codexThreadId: snap.id, status: "idle" });
  assert.equal(db.importRemoteThread(LEGACY_USER_ID, conversation.project_id, "remote:test", snap, selection).conversation.title, task);
  let retried = "";
  instance.conversationTitles.generate = async (input) => { retried = input.requestText; return "摩托车觉醒配置"; };
  await agent.post(`/api/conversations/${conversation.id}/messages`).set("X-CSRF-Token", csrf).field("message", "继续").expect(202);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(retried, task); assert.equal(db.getConversation(conversation.id)?.title_source, "ai");
  const audits = db.listConversationTitleAudits(conversation.id);
  assert.equal(audits.length, 2); assert.equal(audits.filter((a) => a.applied).length, 1);
  // A repair cannot overwrite a name that changed since the operator read it.
  await agent.patch(`/api/conversations/${conversation.id}`).set("X-CSRF-Token", csrf)
    .send({ title: "补救标题", expectedTitle: "本轮附件：", expectedTitleSource: "default" }).expect(409);
  assert.equal(db.getConversation(conversation.id)?.title_source, "ai");
  await agent.patch(`/api/conversations/${conversation.id}`).set("X-CSRF-Token", csrf)
    .send({ title: "用户自定义", expectedTitle: "摩托车觉醒配置", expectedTitleSource: "ai" }).expect(200);
  assert.equal(db.getConversation(conversation.id)?.title_source, "manual");
});

test("targeted remote replay validates ownership and skips unrelated history and title attempts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "title-target-sync-"));
  const instance = createApp({ basePath: "", projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "tester", passwordHash: bcrypt.hashSync("test-password", 8), sessionSecret: "test-session-secret-longer-than-thirty-two-characters" });
  t.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const { HOST_ROOT_USER_ID } = await import("../server/host-root-user.js");
  const now = new Date().toISOString();
  instance.db.createUser({ id: HOST_ROOT_USER_ID, username: "test-host", display_name: "Host operator", password_hash: bcrypt.hashSync("test-password", 8),
    role: "owner", status: "active", created_at: now, updated_at: now });
  const project = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "work", "C:/work", `remote:${crypto.randomUUID()}`);
  const target = instance.db.createConversation(crypto.randomUUID(), "新任务", selection, HOST_ROOT_USER_ID, project.id);
  const wanted = snapshot(wrapped());
  instance.db.updateConversation(target.id, { codexThreadId: wanted.id });
  const unrelated = snapshot("unrelated private task");
  let calls = 0;
  instance.remoteWorkers.projectThreadsPage = async (_executor, _root, cursor) => {
    calls++;
    return cursor ? { threads: [wanted], nextCursor: "more" } : { threads: [unrelated], nextCursor: "next" };
  };
  let named = 0;
  instance.conversationTitles.generate = async () => { named++; throw new Error("executor offline"); };
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "test-host", password: "test-password" }).expect(200);
  await agent.post(`/api/projects/${project.id}/sync`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ conversationId: crypto.randomUUID() }).expect(400);
  assert.equal(calls, 0);
  const result = await agent.post(`/api/projects/${project.id}/sync`).set("X-CSRF-Token", login.body.csrfToken)
    .send({ conversationId: target.id }).expect(200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(result.body.scanned, 2); assert.equal(result.body.truncated, false);
  assert.deepEqual(result.body.syncedThread, { id: wanted.id, name: "本轮附件：", nameSource: "preview" });
  assert.equal(instance.db.getConversationByCodexThread(project.id, unrelated.id), undefined);
  assert.equal(instance.db.getConversation(target.id)?.title, task);
  assert.equal(named, 1);
  assert.equal(instance.db.listConversationTitleAudits(target.id)[0].request_excerpt, task);
});
