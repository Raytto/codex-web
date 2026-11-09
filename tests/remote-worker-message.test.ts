import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { parseRemoteWorkerMessage, REMOTE_WORKER_MAX_MESSAGE_BYTES } from "../server/remote-worker-message.js";

function hello(overrides: Record<string, unknown> = {}) {
  return {
    type: "hello",
    protocolVersion: 5,
    workerId: crypto.randomUUID(),
    machineName: "test-worker",
    enrollmentToken: "x".repeat(32),
    platform: "win32-x64",
    workerVersion: "1.15.0",
    workerRelease: "remote-worker-v1.15.0",
    workerCommit: "a".repeat(40),
    capabilities: { workerUpdate: true, waitAutomation: true, capacityConfig: true, accountSkills: true, titleAgent: true },
    codexVersion: "0.144.1",
    capacity: 1,
    ...overrides,
  };
}

test("remote Worker runtime schema accepts a bounded hello", () => {
  const parsed = parseRemoteWorkerMessage(JSON.stringify(hello()));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.message.type, "hello");
});

test("remote Worker runtime schema accepts structured sub-agent snapshot activity", () => {
  const parsed = parseRemoteWorkerMessage(JSON.stringify({
    type: "thread_activity",
    projectId: crypto.randomUUID(),
    thread: {
      id: "thread-root", name: "Root task", createdAt: 1, updatedAt: 2, status: "running", messages: [],
      activities: [{
        turnId: "turn-root", itemId: "subagent-1", kind: "agent", label: "协作 Agent 状态更新",
        agents: [{ id: "agent-a", path: "/root/ui_audit", status: "running" }], createdAt: new Date().toISOString(),
      }],
    },
  }));
  assert.equal(parsed.ok, true);
});

test("remote Worker runtime schema rejects unknown fields, invalid arrays and malformed events", () => {
  assert.deepEqual(parseRemoteWorkerMessage(JSON.stringify(hello({ unexpected: true }))), { ok: false, reason: "invalid_schema" });
  assert.deepEqual(parseRemoteWorkerMessage(JSON.stringify({ type: "heartbeat", activeJobs: Array.from({ length: 65 }, () => crypto.randomUUID()) })), { ok: false, reason: "invalid_schema" });
  assert.deepEqual(parseRemoteWorkerMessage(JSON.stringify({ type: "event", jobId: crypto.randomUUID(), event: { type: "completed", finalResponse: 123 } })), { ok: false, reason: "invalid_schema" });
  assert.deepEqual(parseRemoteWorkerMessage("{"), { ok: false, reason: "invalid_json" });
});

test("remote Worker WebSocket message cap is finite and independent from file upload limits", () => {
  assert.equal(REMOTE_WORKER_MAX_MESSAGE_BYTES, 8 * 1024 * 1024);
});

test("remote Worker accepts a bounded title-agent result and rejects oversized audit output", () => {
  const requestId = crypto.randomUUID();
  assert.equal(parseRemoteWorkerMessage(JSON.stringify({ type: "title_agent_result", requestId, ok: true, output: '{"title":"优化任务命名"}' })).ok, true);
  assert.deepEqual(parseRemoteWorkerMessage(JSON.stringify({ type: "title_agent_result", requestId, ok: true, output: "x".repeat(1001) })), { ok: false, reason: "invalid_schema" });
});

test("account lifecycle replies accept native v7 thread IDs and reject arbitrary paths", () => {
  const message = { type: "codex_accounts_result", requestId: crypto.randomUUID(), ok: true,
    threadStates: [{ threadId: "019fb964-b1fa-7c90-bbe7-fc16d4d165a3", status: "idle" }] };
  assert.equal(parseRemoteWorkerMessage(JSON.stringify(message)).ok, true);
  assert.equal(parseRemoteWorkerMessage(JSON.stringify({ ...message, threadStates: [{ threadId: "../../auth.json", status: "idle" }] })).ok, false);
});

test("reset credits traverse account and quota messages without weakening credential-field validation", () => {
  const now = new Date().toISOString();
  const resetCredits = { availableCount: 3, earliestExpiresAt: null, expiryStatus: "unknown", state: "ok", updatedAt: now, checkedAt: now };
  const quota = { type: "quota_usage", usage: { remainingPercent: null, resetCredits }, accountId: crypto.randomUUID() };
  assert.equal(parseRemoteWorkerMessage(JSON.stringify(quota)).ok, true);
  assert.equal(parseRemoteWorkerMessage(JSON.stringify({ type: "event", jobId: crypto.randomUUID(), event: { type: "quota_usage", usage: quota.usage } })).ok, true);
  const accountId = crypto.randomUUID();
  const state = { activeAccountId: accountId, accounts: [{ id: accountId, label: "Account", email: null, accountHint: "masked", active: true, createdAt: now, lastUsedAt: null, resetCredits }] };
  assert.equal(parseRemoteWorkerMessage(JSON.stringify({ type: "codex_accounts_result", requestId: crypto.randomUUID(), ok: true, state })).ok, true);
  for (const extra of [{ access_token: "must-not-cross" }, { availableCount: -1 }, { availableCount: 1.5 }]) {
    assert.equal(parseRemoteWorkerMessage(JSON.stringify({ ...quota, usage: { ...quota.usage, resetCredits: { ...resetCredits, ...extra } } })).ok, false);
  }
});

test("rollout size responses accept safe byte counts only", () => {
  const requestId = crypto.randomUUID();
  for (const bytes of [null, 0, 1234]) assert.equal(parseRemoteWorkerMessage(JSON.stringify({ type: "thread_rollout_size_result", requestId, bytes })).ok, true);
  for (const bytes of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(parseRemoteWorkerMessage(JSON.stringify({ type: "thread_rollout_size_result", requestId, bytes })).ok, false);
});

test("artifact metadata uses the 2 GiB transfer boundary and accepts total-budget omissions", () => {
  const jobId = crypto.randomUUID();
  for (const size of [104857601, 2147483648, 2147483649]) {
    const result = parseRemoteWorkerMessage(JSON.stringify({ type: "artifact_uploaded", jobId,
      artifact: { id: crypto.randomUUID(), name: "archive.zip", mimeType: "application/zip", size, sha256: "a".repeat(64) } }));
    assert.equal(result.ok, size <= 2147483648);
  }
  assert.equal(parseRemoteWorkerMessage(JSON.stringify({ type: "event", jobId, event: { type: "completed", finalResponse: "done",
    omittedArtifacts: [{ path: "archive.zip", reason: "total_size_limit" }] } })).ok, true);
});

test("Gemini title capability is optional for old workers and retained for upgraded workers", () => {
  for (const capabilities of [{ titleAgent: true }, { titleAgent: true, geminiTitleAgent: true }]) {
    const parsed = parseRemoteWorkerMessage(JSON.stringify(hello({ capabilities })));
    assert.equal(parsed.ok, true);
    if (parsed.ok && parsed.message.type === 'hello') assert.deepEqual(parsed.message.capabilities, capabilities);
  }
});

test("Gemini usage capability and sanitized snapshots cross the server schema without accepting credentials", () => {
  const parsed = parseRemoteWorkerMessage(JSON.stringify(hello({ capabilities: { geminiAccounts: true, geminiUsage: true } })));
  assert.equal(parsed.ok, true);
  const checkedAt = new Date().toISOString();
  const message = { type: "gemini_accounts_result", requestId: crypto.randomUUID(), ok: true, usage: {
    accountId: crypto.randomUUID(), state: "ok", checkedAt, quotaUpdatedAt: checkedAt, creditsUpdatedAt: checkedAt,
    groups: [{ label: "Gemini", buckets: [{ id: "weekly", label: "Weekly", window: "weekly", remainingPercent: 0, remainingAmount: null, resetAt: checkedAt, disabled: false }] }], remainingCredits: 0, error: null,
  } };
  assert.equal(parseRemoteWorkerMessage(JSON.stringify(message)).ok, true);
  for (const extra of [{ access_token: "must-not-cross" }, { remainingCredits: -1 }, { quotaUpdatedAt: "invalid" }]) assert.equal(parseRemoteWorkerMessage(JSON.stringify({ ...message, usage: { ...message.usage, ...extra } })).ok, false);
});

test("real Worker account views and fresh quota snapshots pass both ends of account transport", async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { RemoteCodexAccountManager } = await import('../remote-worker/src/codex-accounts.js');
  const { isPersistableWorkerMessage } = await import('../remote-worker/src/protocol-validation.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'account-wire-')); const home=path.join(root,'home');fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{account_id:'synthetic-upstream-account',id_token:'header.e30.signature',access_token:'fixture-access',refresh_token:'fixture-refresh'}}));
  const manager=new RemoteCodexAccountManager({stateRoot:path.join(root,'state'),codexHome:home,codexExecutable:()=>'',assertSwitchAllowed(){throw Error('must not switch');}});
  t.after(()=>{manager.close();fs.rmSync(root,{recursive:true,force:true});});
  const state=manager.listAccounts(); assert.match(state.accounts[0].resetAccountKey!,/^[a-f0-9]{64}$/);
  const now=new Date().toISOString();
  for (const extra of [{},{quotaRemainingPercent:0.5,quotaResetAt:now,quotaUpdatedAt:now},{quotaRemainingPercent:null,quotaResetAt:null,quotaUpdatedAt:null}]) {
    const account={...state.accounts[0],...extra};
    for (const payload of [{state:{...state,accounts:[account]}},{login:{id:crypto.randomUUID(),status:'succeeded',verificationUrl:null,userCode:null,error:null,account,createdAt:now,expiresAt:now}}]) {
      const message={type:'codex_accounts_result',requestId:crypto.randomUUID(),ok:true,...payload};
      assert.equal(isPersistableWorkerMessage(message),true);
      const parsed=parseRemoteWorkerMessage(JSON.stringify(message));assert.equal(parsed.ok,true,'server must accept actual Worker view fields');
      if(parsed.ok)assert.deepEqual(parsed.message,message);
    }
  }
  for(const extra of [{resetAccountKey:'invalid'},{quotaRemainingPercent:101},{quotaRemainingPercent:-1},{quotaUpdatedAt:'invalid'},{access_token:'must-not-cross'}]) {
    const message={type:'codex_accounts_result',requestId:crypto.randomUUID(),ok:true,state:{...state,accounts:[{...state.accounts[0],...extra}]}};
    assert.equal(parseRemoteWorkerMessage(JSON.stringify(message)).ok,false);
  }
});

test("automatic notDue receipts pass both Worker and server validation without allowing unknown outcomes", async () => {
  const { isPersistableWorkerMessage }=await import('../remote-worker/src/protocol-validation.js');
  const now=new Date().toISOString();const message={type:'codex_accounts_result',requestId:crypto.randomUUID(),ok:true,
    resetResult:{attemptId:crypto.randomUUID(),outcome:'notDue',refreshed:false,quota:null,
      resetCredits:{availableCount:0,earliestExpiresAt:null,expiryStatus:'complete',state:'ok',updatedAt:now,checkedAt:now}}};
  assert.equal(isPersistableWorkerMessage(message),true);assert.equal(parseRemoteWorkerMessage(JSON.stringify(message)).ok,true);
  assert.equal(parseRemoteWorkerMessage(JSON.stringify({...message,resetResult:{...message.resetResult,outcome:'unknown'}})).ok,false);
});
