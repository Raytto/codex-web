import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { WebSocket } from "ws";
import { CodexRunner, isAlreadyAbsentRemoteThread, remoteArtifactDeliveryName } from "../server/codex-runner.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { RemoteWorkerGateway, remoteThreadSyncTimeoutMs } from "../server/remote-worker-gateway.js";
import { parseServerMessage } from "../remote-worker/src/protocol-validation.js";

function dispatchResult(capacity: number, runningJobs: number, completeWorkflows = true): boolean {
  const executorId = "remote:00000000-0000-4000-8000-000000000099";
  const runner = Object.create(CodexRunner.prototype) as CodexRunner;
  Reflect.set(runner, "db", {
    getConversation: () => ({ id: "conversation", user_id: "user", project_id: "project" }),
    getProjectForUser: () => ({ id: "project", executor_id: executorId }),
    countRunningJobsForExecutor: () => runningJobs,
  });
  Reflect.set(runner, "remoteWorkers", {
    executor: () => ({ status: "online", capacity }),
    canRun: () => true,
    supportsCompleteWorkflows: () => completeWorkflows,
  });
  return runner.canDispatchConversation("conversation");
}

test("remote dispatch treats capacity zero as unlimited in the database race guard", () => {
  assert.equal(dispatchResult(0, 0), true);
  assert.equal(dispatchResult(0, 8), true);
  assert.equal(dispatchResult(2, 1), true);
  assert.equal(dispatchResult(2, 2), false);
  assert.equal(dispatchResult(0, 0, false), false, "old Worker remains queued until workflow capability is available");
});

test("remote thread sync gives every page a bounded five-minute budget", () => {
  assert.equal(remoteThreadSyncTimeoutMs(), 300_000);
});

test("Codex title requests remain valid on the deployed Worker protocol", async () => {
  const workerId = crypto.randomUUID();
  const gateway = Object.create(RemoteWorkerGateway.prototype) as RemoteWorkerGateway;
  const requests: string[] = [];
  Reflect.set(gateway, "connections", new Map([[workerId, {
    socket: { readyState: WebSocket.OPEN, send: (wire: string) => requests.push(wire) },
    titleAgent: true,
  }]]));
  const pending = new Map<string, { timer: NodeJS.Timeout }>();
  Reflect.set(gateway, "pendingTitleAgents", pending);
  try {
    const result = gateway.generateConversationTitle(`remote:${workerId}`, "命名附件任务", 75_000);
    assert.equal(requests.length, 1);
    const parsed = parseServerMessage(requests[0]);
    assert.equal(parsed.ok, true, "the installed Worker must accept the actual gateway wire message");
    if (!parsed.ok || parsed.message.type !== "title_agent") throw new Error("expected title request");
    Reflect.get(gateway, "handleMessage").call(gateway, workerId, {
      type: "title_agent_result", requestId: parsed.message.requestId, ok: true, output: '{"title":"附件任务命名"}',
    });
    assert.equal(await result, '{"title":"附件任务命名"}');
    assert.equal(pending.size, 0);
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
  }
});

test("remote artifact delivery names cannot invalidate job finalization", () => {
  assert.equal(remoteArtifactDeliveryName("report.html"), "report.html");
  assert.equal(remoteArtifactDeliveryName("nested\\report.html"), "report.html");
  assert.equal(remoteArtifactDeliveryName(".gitignore"), null);
  assert.equal(remoteArtifactDeliveryName("folder\\.env"), null);
  assert.equal(remoteArtifactDeliveryName("bad\u0000name.txt"), null);
});

test("Remote thread deletion treats only the exact already-absent result as idempotent success", async () => {
  const threadId = "019fcb56-e678-7d33-a3f7-4f9b930b7f85";
  assert.equal(isAlreadyAbsentRemoteThread(new Error(`no rollout found for thread id ${threadId}`), threadId), true);
  assert.equal(isAlreadyAbsentRemoteThread(new Error("remote Worker offline"), threadId), false);

  const runner = Object.create(CodexRunner.prototype) as CodexRunner;
  Reflect.set(runner, "db", {
    getConversation: () => ({ id: "conversation", user_id: HOST_ROOT_USER_ID, project_id: "project" }),
    getProjectForUser: () => ({ id: "project", executor_id: "remote:worker-a" }),
    isCodexThreadUsedByAnotherActiveConversation: () => false,
    sqlite: { prepare: () => ({ all: () => [] }) }, // legacy conversation has no tracked historical segments
  });
  Reflect.set(runner, "remoteWorkers", {
    archiveThread: async () => { throw new Error(`no rollout found for thread id ${threadId}`); },
  });
  assert.equal(await runner.deleteCodexThread(HOST_ROOT_USER_ID, "conversation", threadId), 0);

  Reflect.set(runner, "remoteWorkers", {
    archiveThread: async () => { throw new Error("remote Worker offline"); },
  });
  await assert.rejects(() => runner.deleteCodexThread(HOST_ROOT_USER_ID, "conversation", threadId), /offline/);
});
