import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { isPersistableWorkerMessage, parseServerMessage } from "./protocol-validation.js";

test("Worker accepts a bounded authenticated server message", () => {
  const parsed = parseServerMessage(JSON.stringify({ type: "authenticated", workerId: crypto.randomUUID(), heartbeatIntervalMs: 15_000 }));
  assert.equal(parsed.ok, true);
  const withContext = parseServerMessage(JSON.stringify({
    type: "steer", jobId: crypto.randomUUID(), requestId: crypto.randomUUID(), prompt: "adjust", transferToken: "x".repeat(43), attachments: [],
    turnContext: { version: 1, userPrompt: "重命名图片", imageInput: "path_only" },
  }));
  assert.equal(withContext.ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ type: "title_agent", requestId: crypto.randomUUID(), prompt: "为 Codex Web 优化任务命名", timeoutMs: 60_000 })).ok, true);
});

test("Worker rejects malformed run requests and oversized control arrays", () => {
  const jobId = crypto.randomUUID();
  const run = {
    type: "run",
    request: {
      jobId,
      conversationId: crypto.randomUUID(),
      projectRoot: "C:\\work",
      codexThreadId: null,
      prompt: "test",
      attachments: Array.from({ length: 33 }, () => ({
        id: crypto.randomUUID(), name: "a.txt", mimeType: "text/plain", size: 1,
        downloadPath: `/api/remote-worker-files/${jobId}/input/${crypto.randomUUID()}`,
      })),
      transferToken: "x".repeat(43),
      selection: { model: "gpt-test", reasoningEffort: "high" },
      optionalCapabilities: { apps: false },
    },
  };
  assert.deepEqual(parseServerMessage(JSON.stringify(run)), { ok: false, reason: "invalid_schema" });
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "project_watch", projects: Array.from({ length: 201 }, () => ({ id: crypto.randomUUID(), rootPath: "C:\\work" })) })), { ok: false, reason: "invalid_schema" });
});

test("Worker accepts a bounded account Skill bundle and rejects tampering", () => {
  const contentBase64 = Buffer.from("---\nname: html-report\ndescription: test\n---\n").toString("base64");
  const hash = crypto.createHash("sha256");
  hash.update("html-report\0");
  hash.update(`SKILL.md\0-\0${contentBase64}\0`);
  const request = {
    type: "run",
    request: {
      jobId: crypto.randomUUID(), conversationId: crypto.randomUUID(), projectRoot: "C:\\work", codexThreadId: null,
      prompt: "report", attachments: [], transferToken: "x".repeat(43),
      selection: { model: "gpt-test", reasoningEffort: "high" }, optionalCapabilities: {},
      accountSkills: { version: 1, revision: hash.digest("hex"), skills: [{ name: "html-report", files: [{ path: "SKILL.md", contentBase64 }] }] },
    },
  };
  assert.equal(parseServerMessage(JSON.stringify(request)).ok, true);
  request.request.accountSkills.revision = "0".repeat(64);
  assert.deepEqual(parseServerMessage(JSON.stringify(request)), { ok: false, reason: "invalid_schema" });
});

test("Worker rejects invalid JSON and unexpected control message fields", () => {
  assert.deepEqual(parseServerMessage("{"), { ok: false, reason: "invalid_json" });
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "cancel", jobId: crypto.randomUUID(), retry: true })), { ok: false, reason: "invalid_schema" });
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "title_agent", requestId: crypto.randomUUID(), prompt: "x", timeoutMs: 1_000 })), { ok: false, reason: "invalid_schema" });
});

test("Worker accepts only action-specific Codex account control fields", () => {
  const requestId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const loginId = crypto.randomUUID();
  assert.equal(parseServerMessage(JSON.stringify({ type: "codex_accounts", requestId, action: "list" })).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ type: "codex_accounts", requestId, action: "login_start", label: "home Plus" })).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ type: "codex_accounts", requestId, action: "login_status", loginId })).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ type: "codex_accounts", requestId, action: "activate", accountId })).ok, true);
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "codex_accounts", requestId, action: "list", accountId })), { ok: false, reason: "invalid_schema" });
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "codex_accounts", requestId, action: "activate" })), { ok: false, reason: "invalid_schema" });
});

test("account usage refresh accepts only optional list booleans", () => {
  const base = { type: "codex_accounts", requestId: crypto.randomUUID(), action: "list", threadIds: [] };
  for (const refreshUsage of [false, true]) {
    assert.equal(parseServerMessage(JSON.stringify({ ...base, refreshUsage })).ok, true);
  }
  for (const refreshUsage of [null, 0, "true", {}]) {
    assert.equal(parseServerMessage(JSON.stringify({ ...base, refreshUsage })).ok, false);
  }
  for (const action of ["login_start", "login_status", "login_cancel", "activate", "delete"]) {
    assert.equal(parseServerMessage(JSON.stringify({ ...base, action, refreshUsage: true })).ok, false);
  }
  assert.equal(parseServerMessage(JSON.stringify({ ...base, refreshUsage: true, access_token: "forbidden" })).ok, false);
});

test("Worker sends reset-only quota and validates reset details in account replies", () => {
  const now = new Date().toISOString();
  const resetCredits = { availableCount: 3, earliestExpiresAt: null, expiryStatus: "unknown", state: "ok", updatedAt: now, checkedAt: now };
  const usage = { remainingPercent: null, resetCredits };
  assert.equal(isPersistableWorkerMessage({ type: "quota_usage", usage }), true);
  assert.equal(isPersistableWorkerMessage({ type: "event", jobId: crypto.randomUUID(), event: { type: "quota_usage", usage } }), true);
  const id = crypto.randomUUID();
  const account = { id, label: "Fixture", email: null, accountHint: "masked", active: true, createdAt: now, lastUsedAt: null, resetCredits };
  const reply = (value: unknown) => ({ type: "codex_accounts_result", requestId: id, ok: true, state: { activeAccountId: id, accounts: [{ ...account, resetCredits: value }] } });
  assert.equal(isPersistableWorkerMessage(reply(resetCredits)), true);
  for (const extra of [{ availableCount: -1 }, { availableCount: 1.5 }, { state: "invalid" }, { access_token: "forbidden" }]) {
    const invalid = { ...resetCredits, ...extra };
    assert.equal(isPersistableWorkerMessage(reply(invalid)), false);
    assert.equal(isPersistableWorkerMessage({ type: "quota_usage", usage: { ...usage, resetCredits: invalid } }), false);
  }
});

test("Worker protocol messages omit absent optional fields", () => {
  const requestId = crypto.randomUUID();
  const result = { type: "codex_accounts_result", requestId, ok: true } as const;
  assert.equal(isPersistableWorkerMessage(result), true);
  assert.equal(isPersistableWorkerMessage({ ...result, state: undefined }), false);
  assert.equal(isPersistableWorkerMessage({ type: "runtime_status", requestId: undefined, installedVersion: "0.1.0", latestVersion: null, versionCheckedAt: null, catalogUpdatedAt: null, agentOptions: null }), false);
});

test("Worker validates bounded Remote steer attachments and transfer scope", () => {
  const jobId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const parsed = parseServerMessage(JSON.stringify({
    type: "steer", jobId, requestId: crypto.randomUUID(), prompt: "adjust",
    transferToken: "x".repeat(43),
    attachments: [{
      id: attachmentId, name: "reference.png", mimeType: "image/png", size: 10,
      downloadPath: `/api/remote-worker-files/${jobId}/input/${attachmentId}`,
    }],
  }));
  assert.equal(parsed.ok, true);
});

test("credential delivery is validated and credential acknowledgements never enter the durable outbox", () => {
  const workerId = "10000000-0000-4000-8000-000000000001";
  const credentialId = "10000000-0000-4000-8000-000000000002";
  assert.equal(parseServerMessage(JSON.stringify({ type: "credential_replace", workerId, credentialId, token: "x".repeat(43) })).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ type: "credential_replace", workerId: "invalid", credentialId, token: "secret" })).ok, false);
  assert.equal(isPersistableWorkerMessage({ type: "credential_saved", credentialId }), false);
});


test("account lifecycle checks are bounded UUID-only list extensions", () => {
  const requestId = "00000000-0000-4000-8000-000000000001";
  const threadId = "019fb964-b1fa-7c90-bbe7-fc16d4d165a3";
  const base = { type: "codex_accounts", requestId, action: "list", threadIds: [threadId] };
  assert.equal(parseServerMessage(JSON.stringify(base)).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ ...base, threadIds: ["../../auth.json"] })).ok, false);
  assert.equal(parseServerMessage(JSON.stringify({ ...base, action: "activate", accountId: requestId })).ok, false);
  assert.equal(parseServerMessage(JSON.stringify({ ...base, threadIds: Array(201).fill(requestId) })).ok, false);
});

test("rollout size query accepts only thread UUIDs and safe byte counts", () => {
  const requestId = crypto.randomUUID();
  assert.equal(parseServerMessage(JSON.stringify({ type: "thread_rollout_size", requestId, threadId: crypto.randomUUID() })).ok, true);
  assert.equal(parseServerMessage(JSON.stringify({ type: "thread_rollout_size", requestId, threadId: "../../auth.json" })).ok, false);
  for (const bytes of [null, 0, 1234]) assert.equal(isPersistableWorkerMessage({ type: "thread_rollout_size_result", requestId, bytes }), true);
  for (const bytes of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(isPersistableWorkerMessage({ type: "thread_rollout_size_result", requestId, bytes }), false);
});
