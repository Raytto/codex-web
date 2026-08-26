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
