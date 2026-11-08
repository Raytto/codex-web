process.env.PERSONAL_MEMORY_MODEL = "test-memory-model";
import { CodexRunner } from "../server/codex-runner.js";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { personalMemoryArguments, runCodexPersonalMemory, decodePersonalMemoryResult, personalMemoryError, validatePersonalMemoryRequest } from "../server/codex-personal-memory.js";
import { PersonalMemoryService, PersonalMemoryExtractor, parseExtractionPayload } from "../server/personal-memory.js";
import { AppDatabase } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { ensureTenant } from "../server/paths.js";
const userId = "00000000-0000-4000-8000-000000000001";
const envelope = (output: string) => JSON.stringify({ provider: "codex-cli", model: "test-memory-model", reasoningEffort: "medium", output });

test("memory CLI pins model/effort and the shared no-tools profile", () => {
  const args = personalMemoryArguments("schema", "output");
  assert.equal(args[args.indexOf("--model") + 1], "test-memory-model");
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  for (const value of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "read-only", 'approval_policy="never"', 'history.persistence="none"', "features.shell_tool=false", "features.unified_exec=false", "agents.enabled=false", "features.apps=false", "features.multi_agent=false", "features.memories=false", "project_doc_max_bytes=0"]) assert.ok(args.includes(value));
  assert.throws(() => validatePersonalMemoryRequest({ userId, prompt: "x", timeoutMs: 30000 }, crypto.randomUUID()), /user_mismatch/);
  assert.throws(() => validatePersonalMemoryRequest({ userId, prompt: "x", timeoutMs: 30000, engineId: "antigravity" }), /invalid_engine/);
  assert.equal(decodePersonalMemoryResult(envelope('{"candidates":[]}')), '{"candidates":[]}');
  assert.throws(() => decodePersonalMemoryResult(envelope('{}').replace('test-memory-model', 'other')), /runtime_mismatch/);
});

test("invalid structured output fails instead of silently consuming evidence", async () => {
  for (const value of ["", "broken", "{}", '{"candidates":[null]}', '{"candidates":[[]]}']) assert.throws(() => parseExtractionPayload(value), /invalid_output/);
  assert.deepEqual(parseExtractionPayload('```json\n{"candidates":[]}\n```'), []);
  let called = false;
  const extractor = new PersonalMemoryExtractor(loadConfig({personalMemoryProvider: "codex-cli", personalMemoryModel: "test-memory-model"}), async () => { called = true; return envelope('{"candidates":[]}'); });
  const source = { id: crypto.randomUUID(), user_id: userId, conversation_id: crypto.randomUUID(), project_id: "p", conversation_title: "test", content: "test", quote_excerpt: null, created_at: new Date().toISOString(), attempts: 0 };
  await assert.rejects(extractor.extract([source, { ...source, user_id: crypto.randomUUID() }], ""), /user_mismatch/);
  assert.equal(called, false);
  assert.equal(personalMemoryError(new Error("quota exceeded private memory body")), "personal_memory_quota");
  assert.equal(personalMemoryError(new Error("401 secret")), "personal_memory_auth");
});

test("CLI errors, cancellation and stubborn child cleanup use bounded safe errors", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-cli-test-"));
  const keys = ["CODEX_RUNTIME_PATH", "CODEX_HOME", "CODEX_PRIMARY_HTTP_PROXY", "CWW_TENANT_USER_ID"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  context.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } fs.rmSync(root, { recursive: true, force: true }); });
  delete process.env.CODEX_HOME; delete process.env.CODEX_PRIMARY_HTTP_PROXY; process.env.CWW_TENANT_USER_ID = userId;
  const executable = path.join(root, "codex"), pidFile = path.join(root, "pid");
  process.env.CODEX_RUNTIME_PATH = executable;
  fs.writeFileSync(executable, `#!/usr/bin/env node\nconst fs=require('fs'); const args=process.argv;fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({candidates:[]}));process.stdin.resume();`, { mode: 0o700 });
  const result = await runCodexPersonalMemory({ userId, prompt: "synthetic", timeoutMs: 30000 }, { signal: new AbortController().signal });
  assert.equal(decodePersonalMemoryResult(result), '{"candidates":[]}');
  fs.writeFileSync(executable, "#!/usr/bin/env node\nconsole.error('quota exceeded PRIVATE_BODY');process.exit(1);", { mode: 0o700 });
  await assert.rejects(runCodexPersonalMemory({ userId, prompt: "synthetic", timeoutMs: 30000 }, { signal: new AbortController().signal }), /^Error: personal_memory_quota$/);
  fs.writeFileSync(executable, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`, { mode: 0o700 });
  const controller = new AbortController();
  const pending = runCodexPersonalMemory({ userId, prompt: "synthetic", timeoutMs: 30000 }, { signal: controller.signal });
  const check = setInterval(() => { if (fs.existsSync(pidFile)) { clearInterval(check); controller.abort(); } }, 20);
  await assert.rejects(pending, /personal_memory_cancelled/);
  clearInterval(check);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("outbox survives quota/offline failures, is serialized, yields to work and resumes idempotently", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-queue-test-"));
  const config = loadConfig({ personalMemoryProvider: "codex-cli", personalMemoryModel: "test-memory-model", projectRoot: root, dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), personalMemoryDelayMs: 0 });
  const db = new AppDatabase(config.dataRoot, { username: "tester", passwordHash: "", displayName: "Tester" }, false);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const personal = path.join(ensureTenant(config.tenantRoot, userId).library, "personal");
  fs.mkdirSync(personal, { recursive: true }); fs.writeFileSync(path.join(personal, "ENABLED"), "1");
  const conversationId = crypto.randomUUID(), messageId = crypto.randomUUID();
  db.createConversation(conversationId, "Synthetic", { model: "test", reasoningEffort: "low" });
  db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "Synthetic evidence", created_at: "2026-01-01T00:00:00.000Z" });
  let count = 0, allowed = true;
  const failed = new PersonalMemoryService(config, db, async id => { assert.equal(id, userId); count++; throw new Error("quota PRIVATE"); }, () => allowed);
  await Promise.all([failed.pump(), failed.pump()]);
  assert.equal(count, 1); assert.equal(db.getPersonalMemoryStatus(userId).pending, 1);
  const row = db.sqlite.prepare("SELECT provider,model,reasoning_effort,runtime_verified,error FROM personal_memory_runs").get();
  assert.deepEqual({ ...row as object }, { provider: "codex-cli", model: "test-memory-model", reasoning_effort: "medium", runtime_verified: 0, error: "personal_memory_quota" });
  await failed.pump(); assert.equal(count, 1); // durable backoff
  db.sqlite.prepare("UPDATE personal_memory_outbox SET next_attempt_at=NULL").run();
  const offline = new PersonalMemoryService(config, db, async () => { throw new Error("ECONNREFUSED"); });
  await offline.pump(); assert.equal(db.getPersonalMemoryStatus(userId).pending, 1);
  db.sqlite.prepare("UPDATE personal_memory_outbox SET next_attempt_at=NULL").run();
  const cancelled = new PersonalMemoryService(config, db, async (_id, _prompt, _timeout, signal) => {
    allowed = false;
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test cancel missing")), 3000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("personal_memory_cancelled")); }, { once: true });
    });
  }, () => allowed);
  await cancelled.pump(); assert.equal(db.getPersonalMemoryStatus(userId).pending, 1);
  db.sqlite.prepare("UPDATE personal_memory_outbox SET next_attempt_at=NULL").run();
  allowed = false;
  const resumed = new PersonalMemoryService(config, db, async () => { count++; return envelope('{"candidates":[]}'); }, () => allowed);
  await resumed.pump(); assert.equal(count, 1);
  allowed = true; await resumed.pump(); await resumed.pump();
  assert.equal(count, 2); assert.equal(db.getPersonalMemoryStatus(userId).pending, 0);
  assert.equal(db.getPersonalMemoryStatus(userId).processed, 1);
  const success = db.sqlite.prepare("SELECT runtime_verified FROM personal_memory_runs WHERE status='succeeded'").get() as { runtime_verified: number };
  assert.equal(success.runtime_verified, 1);
  assert.ok(fs.readFileSync(path.join(personal, "AUTO.md"), "utf8").includes("revision:"));
});

test("CLI deadline kills a stubborn process before returning timeout", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-timeout-test-"));
  const keys = ["CODEX_RUNTIME_PATH", "CODEX_HOME", "CODEX_PRIMARY_HTTP_PROXY", "CWW_TENANT_USER_ID"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  context.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } fs.rmSync(root, { recursive: true, force: true }); });
  delete process.env.CODEX_HOME; delete process.env.CODEX_PRIMARY_HTTP_PROXY; process.env.CWW_TENANT_USER_ID = userId;
  const executable = path.join(root, "codex"), pidFile = path.join(root, "pid");
  process.env.CODEX_RUNTIME_PATH = executable;
  fs.writeFileSync(executable, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`, { mode: 0o700 });
  await assert.rejects(runCodexPersonalMemory({ userId, prompt: "synthetic", timeoutMs: 30000 }, { signal: new AbortController().signal }), /personal_memory_timeout/);
  assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0), /ESRCH/);
});


test("memory routing keeps tenant identities separate from the host account", async () => {
  const calls: Array<{ route: string; user: string }> = [];
  const fake = {
    hostWorkerClient: { extractPersonalMemory: async (user: string) => { calls.push({ route: "host", user }); return "ok"; } },
    workerClient: { extractPersonalMemory: async (user: string) => { calls.push({ route: "tenant", user }); return "ok"; } },
  } as unknown as CodexRunner;
  for (const user of ["00000000-0000-4000-8000-000000000010", userId, "acbadaef-0753-4f3d-bc23-c5a727c35ed8"]) {
    await CodexRunner.prototype.extractPersonalMemory.call(fake, user, "synthetic", 30000, new AbortController().signal);
  }
  assert.deepEqual(calls.map(call => call.route), ["host", "tenant", "tenant"]);
  assert.equal(new Set(calls.map(call => call.user)).size, 3);
  await assert.rejects(CodexRunner.prototype.extractPersonalMemory.call({} as CodexRunner, userId, "synthetic", 30000, new AbortController().signal), /executor_offline/);
});
