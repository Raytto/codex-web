import assert from "node:assert/strict";
import test from "node:test";
import { CodexRunner, isAlreadyAbsentRemoteThread, remoteArtifactDeliveryName } from "../server/codex-runner.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { remoteThreadSyncTimeoutMs } from "../server/remote-worker-gateway.js";

function dispatchResult(capacity: number, runningJobs: number): boolean {
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
  });
  return runner.canDispatchConversation("conversation");
}

test("remote dispatch treats capacity zero as unlimited in the database race guard", () => {
  assert.equal(dispatchResult(0, 0), true);
  assert.equal(dispatchResult(0, 8), true);
  assert.equal(dispatchResult(2, 1), true);
  assert.equal(dispatchResult(2, 2), false);
});

test("remote thread sync gives every page a bounded five-minute budget", () => {
  assert.equal(remoteThreadSyncTimeoutMs(), 300_000);
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
