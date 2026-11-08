import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server/app.js";
import { AppDatabase, type JobAttemptState } from "../server/db.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { HostRootWorkerClient } from "../server/host-root-worker-client.js";
import { spawnMemoryWorker } from "../server/memory-worker.js";
import { memoryScopeName, validateTenantMemoryTarget } from "../server/task-memory-scope.js";
import { TASK_MEMORY_BYTES, parseAvailableMemory, memoryDispatchBlock, taskMemoryError, taskMemoryErrorCode } from "../server/task-memory.js";

test("memory gate uses MemAvailable, permits exactly 4 GiB and fails closed on unknown data", () => {
  assert.equal(parseAvailableMemory("MemFree: 100 kB\nMemAvailable: 4194304 kB\n"), TASK_MEMORY_BYTES);
  assert.equal(parseAvailableMemory("MemFree: 9000000 kB\n"), null);
  assert.equal(parseAvailableMemory("MemAvailable: nope kB\n"), null);
  assert.equal(parseAvailableMemory("MemAvailable: 99999999999999999999 kB\n"), null);
  assert.equal(memoryDispatchBlock(TASK_MEMORY_BYTES - 1), "MEMORY_WAIT");
  assert.equal(memoryDispatchBlock(TASK_MEMORY_BYTES), null);
  assert.equal(memoryDispatchBlock(TASK_MEMORY_BYTES * 100), null);
  for (const value of [null, NaN, Infinity, -1]) assert.equal(memoryDispatchBlock(value), "MEMORY_GUARD_UNAVAILABLE");
});

function fixture(context: { after(fn: () => unknown): void }, read: () => number | null, autoStart = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-memory-test-"));
  const instance = createApp({ basePath: "", projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    hostTenantRoot: path.join(root, "tenants"), hostRootCodexHome: path.join(root, "codex-home"),
    username: "tester", passwordHash: "unused", sessionSecret: "memory-test-session-secret-over-thirty-two-characters",
    queueAutoStart: autoStart, taskMemoryGuard: true, readAvailableMemory: read });
  context.after(async () => { instance.beginShutdown(); await instance.waitForBackgroundTasks(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({ id: HOST_ROOT_USER_ID, username: "test-host", display_name: "Host operator", password_hash: "unused", role: "owner", status: "active", created_at: now, updated_at: now });
  instance.runner.canDispatchConversation = () => true;
  const selection = { model: "gpt-6.1-sol", reasoningEffort: "high" };
  const projects = new Map<string, ReturnType<typeof instance.db.createProject>>();
  function enqueue(executor = "local-host", userId = HOST_ROOT_USER_ID) {
    const key = `${userId}:${executor}`;
    const project = projects.get(key) ?? instance.db.createProject(crypto.randomUUID(), userId, "guard test", root, executor);
    projects.set(key, project);
    const conversation = instance.db.createConversation(crypto.randomUUID(), "Guard test", selection, userId, project.id);
    const messageId = crypto.randomUUID();
    instance.db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: "memory gate test", created_at: now });
    return instance.db.createJob(crypto.randomUUID(), conversation.id, messageId, selection);
  }
  return { instance, enqueue };
}

test("Host operator jobs queue below 4 GiB, retain input, and resume without an 8 GiB budget or 2-job cap", async context => {
  let available = TASK_MEMORY_BYTES - 1;
  const { instance, enqueue } = fixture(context, () => available);
  const jobs = [enqueue(), enqueue(), enqueue()];
  const started: string[] = [];
  const releases: Array<() => void> = [];
  instance.runner.run = async (id, conversationId) => {
    started.push(id);
    await new Promise<void>(resolve => releases.push(resolve));
    instance.db.finishJob(id, conversationId, "completed");
  };
  await instance.pumpQueue();
  assert.equal(started.length, 0);
  for (const job of jobs) {
    assert.equal(instance.db.getJob(job.id)?.status, "queued");
    assert.equal(instance.db.getMessage(job.message_id!)?.content, "memory gate test");
    assert.ok(instance.db.listEvents(job.id).some(event => JSON.stringify(event).includes("服务器可用内存低于 4 GiB")));
  }
  available = TASK_MEMORY_BYTES;
  await instance.pumpQueue();
  assert.equal(started.length, 3, "all three tasks may start at 4 GiB; no full-limit reservation or aggregate cap");
  for (const release of releases) release();
  await instance.waitForBackgroundTasks();
  assert.equal(instance.db.listRunningJobs().length, 0);
});

test("memory recovery wakes persisted queues automatically, including after the last running task is gone", async context => {
  let available: number | null = null;
  const { instance, enqueue } = fixture(context, () => available, true);
  const job = enqueue();
  const started: string[] = [];
  instance.runner.run = async (id, conversationId) => { started.push(id); instance.db.finishJob(id, conversationId, "completed"); };
  await instance.pumpQueue();
  assert.equal(instance.db.getJob(job.id)?.status, "queued");
  assert.equal(started.length, 0);
  available = TASK_MEMORY_BYTES;
  const deadline = Date.now() + 5_000;
  while (!started.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(started, [job.id]);
});

test("local ordinary users share the watermark, while a remote executor can run and queued cancellation stays cancelled", async context => {
  const { instance, enqueue } = fixture(context, () => 1);
  const local = enqueue("tenant-local", "00000000-0000-4000-8000-000000000001");
  const remote = enqueue("remote:memory-test-worker");
  const cancelled = enqueue();
  assert.equal(instance.db.cancelQueuedJob(cancelled.id), true);
  const started: string[] = [];
  instance.runner.run = async (id, conversationId) => { started.push(id); instance.db.finishJob(id, conversationId, "completed"); };
  await instance.pumpQueue(); await instance.waitForBackgroundTasks();
  assert.deepEqual(started, [remote.id]);
  assert.equal(instance.db.getJob(local.id)?.status, "queued");
  assert.equal(instance.db.getJob(cancelled.id)?.status, "cancelled");
});

test("startup memory races persist a retry without incrementing model-capacity attempts, and survive reopening", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-memory-state-"));
  const db = new AppDatabase(root, { username: "tester", passwordHash: "unused", displayName: "Tester" });
  const conversation = db.createConversation(crypto.randomUUID(), "Memory test");
  const messageId = crypto.randomUUID();
  db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: "preserve", created_at: new Date().toISOString() });
  const job = db.createJob(crypto.randomUUID(), conversation.id, messageId);
  db.updateJob(job.id, "running");
  const state: JobAttemptState = { retries: 0, capacityStartedAt: null, continuation: false, acceptedTurnId: null, contextRevision: null, outputs: [], images: [], imageThreadId: null,
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), resourceWait: "MEMORY_WAIT" };
  assert.equal(db.deferJobForMemory(job.id, state), true);
  assert.equal(db.deferJobForMemory(job.id, state), false);
  db.close();
  const reopened = new AppDatabase(root, { username: "tester", passwordHash: "unused", displayName: "Tester" });
  context.after(() => { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(reopened.getJob(job.id)?.status, "queued");
  assert.deepEqual(reopened.getJobAttemptState(job.id), state);
  assert.equal(reopened.getMessage(messageId)?.content, "preserve");
  assert.equal(reopened.listRunnableQueuedJobs().length, 0);
});

test("worker bootstrap waits for its memory scope before exec and preserves the protocol stream", async context => {
  const old = process.env.TASK_MEMORY_GUARD; process.env.TASK_MEMORY_GUARD = "true";
  context.after(() => { if (old === undefined) delete process.env.TASK_MEMORY_GUARD; else process.env.TASK_MEMORY_GUARD = old; });
  let allow!: () => void;
  const gate = new Promise<void>(resolve => { allow = resolve; });
  let finished = 0;
  const worker = spawnMemoryWorker(process.execPath, ["-e", "process.stdin.once('data',d=>{process.stdout.write(d);process.exit(0)})"], { stdio: ["pipe", "pipe", "pipe"], env: process.env }, {
    readAvailableMemory: () => TASK_MEMORY_BYTES,
    protect: async () => gate,
    finish: async () => { finished += 1; return { oom: false, peakBytes: 12 }; },
  });
  context.after(() => worker.child.kill("SIGKILL"));
  let output = ""; worker.child.stdout!.on("data", chunk => { output += String(chunk); }); worker.child.stderr!.resume();
  // Linux can briefly expose the forked parent's comm even after spawn.
  // Wait for the shell while the protection gate remains closed: the target
  // must not start or write to the protocol stream during this observation.
  await once(worker.child, "spawn");
  const bootstrapDeadline = Date.now() + 2_000;
  let command = "";
  do {
    command = fs.readFileSync(`/proc/${worker.child.pid}/comm`, "utf8").trim();
    if (command === "sh") break;
    assert.equal(output, "");
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < bootstrapDeadline);
  assert.equal(command, "sh");
  assert.equal(output, "");
  allow(); await worker.ready;
  worker.child.stdin!.end("task-payload\n");
  assert.equal((await worker.finished).oom, false);
  await new Promise(resolve => worker.child.stdout!.readableEnded ? resolve(undefined) : worker.child.stdout!.once("end", resolve));
  assert.equal(output, "task-payload\n");
  assert.equal(finished, 1);
});

test("failed scope setup kills the waiting bootstrap without running the task", async context => {
  const old = process.env.TASK_MEMORY_GUARD; process.env.TASK_MEMORY_GUARD = "true";
  context.after(() => { if (old === undefined) delete process.env.TASK_MEMORY_GUARD; else process.env.TASK_MEMORY_GUARD = old; });
  const worker = spawnMemoryWorker(process.execPath, ["-e", "process.stdout.write('UNPROTECTED')"], { stdio: ["pipe", "pipe", "pipe"], env: process.env }, {
    readAvailableMemory: () => TASK_MEMORY_BYTES,
    protect: async () => { throw taskMemoryError("MEMORY_GUARD_UNAVAILABLE"); },
    finish: async () => ({ oom: false, peakBytes: null }),
  });
  let output = ""; worker.child.stdout!.on("data", c => { output += c; }); worker.child.stderr!.resume();
  await assert.rejects(worker.ready, error => taskMemoryErrorCode(error) === "MEMORY_GUARD_UNAVAILABLE");
  const result = await worker.finished;
  assert.equal(taskMemoryErrorCode(result.startError), "MEMORY_GUARD_UNAVAILABLE");
  assert.equal(output, "");
});

test("tenant scope identities reject host accounts, arbitrary unit names and invalid process targets", () => {
  const token = crypto.randomUUID();
  assert.equal(validateTenantMemoryTarget({ userId: "00000000-0000-4000-8000-000000000001", pid: 12, token }), 11001);
  assert.throws(() => validateTenantMemoryTarget({ userId: HOST_ROOT_USER_ID, pid: 12, token }));
  assert.throws(() => validateTenantMemoryTarget({ userId: "00000000-0000-4000-8000-000000000001", pid: 1, token }));
  assert.throws(() => memoryScopeName("../ssh.service"));
});

test("host RPC preserves typed memory errors rather than treating resource waits as model failures", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-memory-rpc-"));
  const socket = path.join(root, "bridge.sock");
  const server = net.createServer(connection => {
    connection.once("data", bytes => {
      // Ignore unrelated/non-JSON socket probes; they must not outlive this fixture as uncaught errors.
      if (!String(bytes).trimStart().startsWith("{")) { connection.destroy(); return; }
      const request = JSON.parse(String(bytes));
      connection.end(JSON.stringify({ type: "request_failed", requestId: request.requestId, resourceCode: "MEMORY_WAIT", message: "waiting for memory" }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  context.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const client = new HostRootWorkerClient(socket);
  await assert.rejects(client.protectTenantMemory({ userId: "00000000-0000-4000-8000-000000000001", pid: 12, token: crypto.randomUUID() }), error => taskMemoryErrorCode(error) === "MEMORY_WAIT");
});

for (const code of ["MEMORY_WAIT", "MEMORY_GUARD_UNAVAILABLE", "MEMORY_LIMIT"] as const) {
  test(`runner persists ${code} with resource semantics and no model retries`, async context => {
    const { instance, enqueue } = fixture(context, () => TASK_MEMORY_BYTES);
    const job = enqueue();
    let launches = 0;
    const host = (instance.runner as unknown as { hostWorkerClient: { run: () => Promise<string> } }).hostWorkerClient;
    host.run = async () => { launches += 1; throw taskMemoryError(code); };
    instance.db.updateJob(job.id, "running");
    await instance.runner.run(job.id, job.conversation_id, "memory resource test", [], { model: "gpt-6.1-sol", reasoningEffort: "high" });
    assert.equal(launches, 1);
    assert.equal(instance.db.getJob(job.id)?.status, code === "MEMORY_LIMIT" ? "failed" : "queued");
    if (code !== "MEMORY_LIMIT") {
      const state = instance.db.getJobAttemptState(job.id)!;
      assert.equal(state.retries, 0);
      assert.equal(state.resourceWait, code);
      assert.ok(state.nextAttemptAt);
    }
    assert.ok(instance.db.listEvents(job.id).some(event => JSON.stringify(event).includes(code)));
  });
}
