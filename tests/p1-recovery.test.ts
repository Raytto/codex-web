import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID, type JobAttemptState } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { CodexRunner } from "../server/codex-runner.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { ensureTenant, ensureTenantWorkspace } from "../server/paths.js";
import type { TenantWorkerRunRequest } from "../server/tenant-worker-protocol.js";
import type { TenantWorkerClient } from "../server/tenant-worker-client.js";

const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;
const initial: JobAttemptState = { retries: 1, capacityStartedAt: Date.now(), nextAttemptAt: "2999-01-01T00:00:00.000Z",
  continuation: true, acceptedTurnId: "accepted", contextRevision: 1, outputs: [["outputs/a.txt", "fingerprint"]], images: [], imageThreadId: null };

test("capacity waiting survives database restart, frees slots, preserves conversation order and cancellation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-queue-"));
  let db = new AppDatabase(root);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = db.createConversation(crypto.randomUUID(), "wait");
  const other = db.createConversation(crypto.randomUUID(), "other");
  const job = db.createJob(crypto.randomUUID(), c.id);
  const later = db.createJob(crypto.randomUUID(), c.id);
  const runnable = db.createJob(crypto.randomUUID(), other.id);
  db.updateJob(job.id, "running");
  assert.equal(db.deferJobForCapacity(job.id, initial), true);
  db.close(); db = new AppDatabase(root);
  assert.equal(db.countRunningJobs(), 0);
  assert.deepEqual(db.getJobAttemptState(job.id), initial);
  assert.deepEqual(db.listRunnableQueuedJobs().map((row) => row.id), [runnable.id]);
  assert.equal(db.getNextRunnableQueuedJob()?.id, runnable.id);
  db.finishJob(job.id, c.id, "cancelled", "stop");
  assert.equal(db.deferJobForCapacity(job.id, initial), false, "cancelled Jobs must never resurrect");
  assert.equal(db.getNextRunnableQueuedJob()?.id, later.id);
  assert.equal(db.hasCapacityWaitingJobs(), false);
});

test("runner retains runtime and output baseline across capacity failures and injects accepted context only once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-runner-"));
  let db = new AppDatabase(path.join(root, "data"));
  const config = loadConfig({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    pythonRuntimeRoot: path.join(root, "python"), tenantWorkerIsolation: true, queueAutoStart: false });
  let gateway = new RemoteWorkerGateway(config, db);
  t.after(() => { gateway.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const tenant = ensureTenant(config.tenantRoot, LEGACY_USER_ID);
  const personal = path.join(tenant.library, "personal"); fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, "ENABLED"), "1");
  fs.writeFileSync(path.join(personal, "PREFERENCES.md"), "## 沟通与解释\nUse deterministic test context.\n");
  const projectRoot = path.join(tenant.library, "test-project"); fs.mkdirSync(projectRoot, { recursive: true });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "test", projectRoot, "tenant-local");
  const c = db.createConversation(crypto.randomUUID(), "retry", selection, LEGACY_USER_ID, project.id);
  const job = db.createJob(crypto.randomUUID(), c.id, undefined, selection);
  const workspace = ensureTenantWorkspace(config.tenantRoot, LEGACY_USER_ID, c.id);
  const checkpoint = path.join(workspace, ".runtime", "jobs", job.id, "checkpoint.txt");
  const resultFile = path.join(workspace, "outputs", "first-attempt.txt");
  const threadId = crypto.randomUUID();
  const prompts: string[] = [];
  let runner = new CodexRunner(config, db, () => {}, gateway);
  function fakeRun(request: TenantWorkerRunRequest, callbacks: Parameters<TenantWorkerClient["run"]>[1]): Promise<string> {
    prompts.push(request.effectivePrompt);
    callbacks.onThreadStarted(threadId);
    callbacks.onProgress({ kind: "input_accepted", threadId, turnId: `turn-${prompts.length}` });
    if (prompts.length === 1) {
      fs.writeFileSync(checkpoint, "do not delete");
      fs.writeFileSync(resultFile, "result created before capacity failure");
      return Promise.reject(new Error("Selected model is at capacity. Please try a different model."));
    }
    assert.equal(fs.readFileSync(checkpoint, "utf8"), "do not delete");
    return Promise.resolve("completed after recovery");
  }
  (runner as unknown as { workerClient: unknown }).workerClient = { run: fakeRun };
  await runner.run(job.id, c.id, "create the result", [], selection);
  assert.equal(db.getJob(job.id)?.status, "queued", db.getJob(job.id)?.error ?? "");
  assert.equal(runner.activeJobCount, 0);
  assert.ok(db.getJobAttemptState(job.id)?.acceptedTurnId);
  assert.equal(fs.existsSync(checkpoint), true);
  assert.match(prompts[0], /codex_web_personal_context/);
  gateway.close(); db.close(); db = new AppDatabase(config.dataRoot);
  gateway = new RemoteWorkerGateway(config, db);
  runner = new CodexRunner(config, db, () => {}, gateway);
  (runner as unknown as { workerClient: unknown }).workerClient = { run: fakeRun };
  await runner.run(job.id, c.id, "create the result", [], selection);
  assert.equal(db.getJob(job.id)?.status, "completed");
  assert.equal(db.getJobAttemptState(job.id), undefined, "terminal Jobs must release accumulated snapshot metadata");
  assert.doesNotMatch(prompts[1], /codex_web_personal_context|create the result/);
  assert.match(prompts[1], /继续刚才/);
  assert.equal(fs.existsSync(checkpoint), false);
  const files = db.sqlite.prepare("SELECT original_name FROM files WHERE conversation_id=? AND kind='output'").all(c.id);
  assert.equal(files.length, 1, "the result from the first attempt must still be registered");
});
