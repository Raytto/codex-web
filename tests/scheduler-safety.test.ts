import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { StorageQuotaExceededError } from "../server/db.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { HOST_EXECUTOR_ID } from "../server/remote-worker-protocol.js";
import { TENANT_LOCAL_EXECUTOR_ID } from "../server/tenant-projects.js";

test("scheduler enforces global and per-user limits while fairly admitting another user", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-scheduler-limits-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    maxGlobalRunningJobs: 2, maxRunningJobsPerUser: 1, maxRunningJobsPerExecutor: 2,
    minimumFreeDiskBytes: 1,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const secondUserId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.createUser({
    id: secondUserId, username: "friend", display_name: "Friend", password_hash: bcrypt.hashSync("fixture", 8),
    role: "member", status: "active", created_at: now, updated_at: now,
  });

  const owner = request.agent(instance.app);
  const ownerLogin = await owner.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const friend = request.agent(instance.app);
  const friendLogin = await friend.post("/api/auth/login").send({ username: "friend", password: "fixture" }).expect(200);
  const queued: string[] = [];
  for (const label of ["owner-first", "owner-second"]) {
    const conversation = await owner.post("/api/conversations").set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(201);
    const submitted = await owner.post(`/api/conversations/${conversation.body.conversation.id}/messages`)
      .set("X-CSRF-Token", ownerLogin.body.csrfToken).send({ message: label }).expect(202);
    queued.push(submitted.body.job.id);
  }
  const friendConversation = await friend.post("/api/conversations").set("X-CSRF-Token", friendLogin.body.csrfToken).expect(201);
  const friendSubmitted = await friend.post(`/api/conversations/${friendConversation.body.conversation.id}/messages`)
    .set("X-CSRF-Token", friendLogin.body.csrfToken).send({ message: "friend-first" }).expect(202);
  queued.push(friendSubmitted.body.job.id);

  const started: string[] = [];
  const releases = new Map<string, () => void>();
  instance.runner.run = async (jobId, conversationId) => {
    started.push(jobId);
    await new Promise<void>((resolve) => releases.set(jobId, resolve));
    instance.db.finishJob(jobId, conversationId, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 20 && started.length < 2; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [queued[0], queued[2]]);
  assert.equal(instance.db.getJob(queued[1])?.status, "queued");

  releases.get(queued[0])!();
  for (let attempt = 0; attempt < 20 && !started.includes(queued[1]); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [queued[0], queued[2], queued[1]]);
  releases.get(queued[2])!();
  releases.get(queued[1])!();
  for (let attempt = 0; attempt < 20 && queued.some((id) => instance.db.getJob(id)?.status !== "completed"); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(queued.map((id) => instance.db.getJob(id)?.status), ["completed", "completed", "completed"]);
});

test("CODEX_WEB concurrency is unlimited without consuming the shared-user budget", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-owner-unlimited-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    maxGlobalRunningJobs: 1, maxRunningJobsPerUser: 1, maxRunningJobsPerExecutor: 1,
    minimumFreeDiskBytes: 1,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
  const hostProject = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "host", "/tmp/codex-web-workspace", HOST_EXECUTOR_ID);
  const ownerId = instance.db.listUsers().find((user) => user.username === "demo-owner")!.id;
  const ownerProject = instance.db.getDefaultProject(ownerId)!;
  const queued: string[] = [];
  for (const [userId, projectId, label] of [
    [HOST_ROOT_USER_ID, hostProject.id, "host-one"],
    [HOST_ROOT_USER_ID, hostProject.id, "host-two"],
    [HOST_ROOT_USER_ID, hostProject.id, "host-three"],
    [ownerId, ownerProject.id, "shared-user"],
  ] as const) {
    const conversation = instance.db.createConversation(crypto.randomUUID(), label, undefined, userId, projectId);
    const messageId = crypto.randomUUID();
    instance.db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: label, created_at: now });
    queued.push(instance.db.createJob(crypto.randomUUID(), conversation.id, messageId, { model: "gpt-5.6-sol", reasoningEffort: "high" }).id);
  }

  const started: string[] = [];
  const releases = new Map<string, () => void>();
  instance.runner.run = async (jobId, conversationId) => {
    started.push(jobId);
    await new Promise<void>((resolve) => releases.set(jobId, resolve));
    instance.db.finishJob(jobId, conversationId, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 20 && started.length < queued.length; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(new Set(started), new Set(queued));
  assert.equal(instance.db.countRunningJobsForUser(HOST_ROOT_USER_ID), 3);
  assert.equal(instance.db.countRunningJobsExcludingUser(HOST_ROOT_USER_ID), 1);
  assert.equal(instance.db.countRunningJobsForExecutorExcludingUser(HOST_EXECUTOR_ID, HOST_ROOT_USER_ID), 0);
  assert.equal(instance.db.countRunningJobsForExecutorExcludingUser(TENANT_LOCAL_EXECUTOR_ID, HOST_ROOT_USER_ID), 1);
  assert.equal(instance.remoteWorkers.executor(HOST_EXECUTOR_ID)?.capacity, 0);

  for (const release of releases.values()) release();
  for (let attempt = 0; attempt < 20 && queued.some((id) => instance.db.getJob(id)?.status !== "completed"); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(queued.map((id) => instance.db.getJob(id)?.status), ["completed", "completed", "completed", "completed"]);
});

test("disk watermark blocks dispatch without losing the queued job", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-scheduler-disk-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    // Other test processes can release filesystem blocks between setup and
    // dispatch. Use an unreachable watermark so the result is deterministic.
    minimumFreeDiskBytes: Number.MAX_SAFE_INTEGER,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const conversation = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const submitted = await agent.post(`/api/conversations/${conversation.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "keep queued" }).expect(202);
  let started = false;
  instance.runner.run = async () => { started = true; };
  await instance.pumpQueue();
  assert.equal(started, false);
  assert.equal(instance.db.getJob(submitted.body.job.id)?.status, "queued");
  assert.ok(instance.db.listEvents(submitted.body.job.id).some((event) => event.payload.includes("磁盘可用空间低于安全水位")));
});

test("per-user storage quota removes rejected multipart files before registration", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-storage-limit-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    maxStoredBytesPerUser: 4, minimumFreeDiskBytes: 1,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "demo-owner", password: "fixture" }).expect(200);
  const conversation = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const rejected = await agent.post(`/api/conversations/${conversation.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "inspect")
    .attach("files", Buffer.from("12345"), { filename: "five.txt", contentType: "text/plain" })
    .expect(413);
  assert.equal(rejected.body.code, "USER_STORAGE_LIMIT");
  assert.equal(instance.db.listFiles(conversation.body.conversation.id).length, 0);
  const ownerId = instance.db.getConversation(conversation.body.conversation.id)!.user_id;
  const uploadedFiles = fs.readdirSync(path.join(tenantRoot, ownerId, "conversations", conversation.body.conversation.id, "uploads"));
  assert.deepEqual(uploadedFiles, []);
});

test("CODEX_WEB bypasses the per-user storage quota while retaining upload registration", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-owner-storage-unlimited-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    maxStoredBytesPerUser: 4, minimumFreeDiskBytes: 1,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: HOST_ROOT_USER_ID, username: "owner", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("fixture", 8),
    role: "owner", status: "active", created_at: now, updated_at: now,
  });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "owner", password: "fixture" }).expect(200);
  const conversation = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  await agent.post(`/api/conversations/${conversation.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "inspect")
    .attach("files", Buffer.from("12345"), { filename: "five.txt", contentType: "text/plain" })
    .expect(202);
  assert.equal(instance.db.sumStoredFileBytesForUser(HOST_ROOT_USER_ID), 5);
  assert.equal(instance.db.listFiles(conversation.body.conversation.id).length, 1);
});

test("the SQLite registration transaction is the final per-user quota gate", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-storage-transaction-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo-owner", passwordHash: bcrypt.hashSync("fixture", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    minimumFreeDiskBytes: 1,
  });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "quota transaction");
  const ownerId = conversation.user_id;
  const row = (id: string, size: number) => ({
    id, conversation_id: conversation.id, message_id: null, pending_prompt_id: null,
    original_name: `${id}.bin`, relative_path: `uploads/${id}`, mime_type: "application/octet-stream",
    size, kind: "upload" as const, created_at: new Date().toISOString(),
  });
  instance.db.addFiles([row(crypto.randomUUID(), 4)], ownerId, 4);
  assert.throws(
    () => instance.db.addFiles([row(crypto.randomUUID(), 1)], ownerId, 4),
    StorageQuotaExceededError,
  );
  assert.equal(instance.db.listFiles(conversation.id).length, 1);
});
