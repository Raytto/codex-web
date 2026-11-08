import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { resolveProcessStatus } from "../src/process-status.js";
import type { JobAttemptState } from "../server/db.js";
import type { JobEvent } from "../src/api.js";

test("immediate admission and engine preparation render as processing", () => {
  for (const status of ["queued", "running"]) {
    const state = resolveProcessStatus([{ status, starting: true, jobsAhead: 0 }]);
    assert.equal(state.queued, false);
    assert.equal(state.starting, true);
    assert.equal(state.retrying, false);
  }
});

test("a later resource wait overrides earlier running even after progress notes", () => {
  const wait: JobEvent = { status: "queued", label: "等待内存", starting: false };
  const state = resolveProcessStatus([
    { status: "queued", starting: true }, { status: "running", starting: true },
    { status: "running" }, wait, { kind: "status", label: "进度说明" },
    { kind: "status", status: "warning", label: "连接提示" },
  ]);
  assert.equal(state.queued, true);
  assert.equal(state.starting, false);
  assert.equal(state.queueStatus, wait);
});

test("legacy waits remain visible and resumed or retried executions use the latest status", () => {
  const events: JobEvent[] = [{ status: "queued", jobsAhead: 0 }];
  assert.equal(resolveProcessStatus(events).queued, true);
  events.push({ status: "running", starting: true }, { status: "running" });
  assert.equal(resolveProcessStatus(events).queued, false);
  assert.equal(resolveProcessStatus(events).starting, false);
  events.push({ status: "retrying", label: "正在自动重试" }, { kind: "status", label: "进度说明" });
  assert.equal(resolveProcessStatus(events).retrying, true);
});

async function fixture(context: { after(fn: () => unknown): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-startup-status-"));
  const instance = createApp({ basePath: "", projectRoot: process.cwd(), dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "pp", passwordHash: bcrypt.hashSync("Startup-Test-2026!", 8),
    sessionSecret: "startup-test-session-secret-longer-than-thirty-two-characters" });
  const releases: Array<() => void> = [];
  context.after(async () => {
    instance.beginShutdown();
    for (const release of releases) release();
    await instance.waitForBackgroundTasks();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  instance.runner.canDispatchConversation = () => true;
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "pp", password: "Startup-Test-2026!" }).expect(200);
  const created = await agent.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  return { instance, agent, conversationId, releases, root, cookie: login.headers["set-cookie"], setAvailable: (value: number) => { available = value; },
    send: (useComposerDraft = false) => agent.post(`/api/conversations/${conversationId}/messages`)
      .set("X-CSRF-Token", login.body.csrfToken).send({ message: "startup test", ...(useComposerDraft ? { useComposerDraft: "true" } : {}) }).expect(202) };
}

for (const useComposerDraft of [false, true]) {
  test(`dispatch persists running before slow engine preparation (draft=${useComposerDraft})`, async context => {
    const { instance, agent, conversationId, releases, send } = await fixture(context);
    let beforePreparation: JobEvent | undefined;
    instance.runner.run = async (jobId, id) => {
      const events = instance.db.listEvents(jobId);
      beforePreparation = JSON.parse(events.at(-1)!.payload) as JobEvent;
      await new Promise<void>(resolve => releases.push(resolve));
      instance.db.finishJob(jobId, id, "completed");
    };
    instance.config.queueAutoStart = true;
    const submitted = await send(useComposerDraft);
    await instance.pumpQueue();
    assert.equal(beforePreparation?.status, "running", "state must already be durable before engine work");
    assert.equal(beforePreparation.starting, true);
    const events = instance.db.listEvents(submitted.body.job.id);
    const initial = JSON.parse(events[0]!.payload) as JobEvent;
    assert.equal(initial.status, "queued", "admission must remain durable");
    assert.equal(initial.starting, true, "unblocked admission must not look like a wait");
    const activity = await agent.get(`/api/conversations/${conversationId}/activity`).expect(200);
    assert.equal(activity.body.activeJob.status, "running");
    assert.equal(resolveProcessStatus(activity.body.jobEvents).queued, false);
    assert.equal(resolveProcessStatus(activity.body.jobEvents).starting, true);
    // A new client/reconnect receives the same persisted preparing state.
    const replay = await agent.get(`/api/conversations/${conversationId}/activity`).expect(200);
    assert.deepEqual(replay.body.jobEvents, activity.body.jobEvents);
    for (const release of releases) release();
    await instance.waitForBackgroundTasks();
    assert.equal(instance.db.getJob(submitted.body.job.id)?.status, "completed");
  });
}

for (const blocker of ["maintenance"]) {
  test(`${blocker} wait stays queued and only transitions after the gate allows dispatch`, async context => {
    const { instance, root, send } = await fixture(context);
    const marker = path.join(root, "data", ".codex-update-maintenance");
    fs.writeFileSync(marker, "active\n");
    const started: string[] = [];
    instance.runner.run = async (jobId, id) => { started.push(jobId); instance.db.finishJob(jobId, id, "completed"); };
    instance.config.queueAutoStart = true;
    const submitted = await send();
    await instance.pumpQueue();
    assert.deepEqual(started, []);
    assert.equal(instance.db.getJob(submitted.body.job.id)?.status, "queued");
    const waits = instance.db.listEvents(submitted.body.job.id).map(row => JSON.parse(row.payload) as JobEvent);
    assert.equal(waits.some(event => event.starting === true || event.status === "running"), false);
    assert.equal(resolveProcessStatus(waits).queued, true);
    fs.rmSync(marker);
    await instance.pumpQueue();
    await instance.waitForBackgroundTasks();
    assert.deepEqual(started, [submitted.body.job.id]);
    assert.ok(instance.db.listEvents(submitted.body.job.id).some(row => {
      const event = JSON.parse(row.payload) as JobEvent;
      return event.status === "running" && event.starting;
    }));
  });
}

for (const retryKind of [undefined, "capacity", "routing"] as const) {
test(`a persisted ${retryKind ?? "legacy capacity"} retry keeps its reason across queue, reload and live events`, async context => {
  const { instance, agent, conversationId, cookie, send } = await fixture(context);
  const submitted = await send();
  const jobId = submitted.body.job.id;
  const started: string[] = [];
  instance.runner.run = async (id, conversationId) => { started.push(id); instance.db.finishJob(id, conversationId, "completed"); };
  const state: JobAttemptState = { retryKind, retries: 1, capacityStartedAt: new Date().toISOString(),
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), continuation: false,
    acceptedTurnId: null, contextRevision: null, outputs: [], images: [], imageThreadId: null };
  instance.db.saveJobAttemptState(jobId, state);
  instance.config.queueAutoStart = true;
  await instance.pumpQueue();
  assert.deepEqual(started, []);
  const events = instance.db.listEvents(jobId).map(row => JSON.parse(row.payload) as JobEvent);
  assert.equal(events.at(-1)?.starting, false);
  assert.equal(resolveProcessStatus(events).queued, true);
  const expected = retryKind === "routing" ? /上游路由连接暂时不可用/ : /模型容量等待中/;
  assert.match(events.at(-1)!.label!, expected);
  assert.match(events.at(-1)!.label!, /北京时间.*自动继续/);
  const activity = await agent.get(`/api/conversations/${conversationId}/activity`).expect(200);
  assert.match(resolveProcessStatus(activity.body.jobEvents).queueStatus!.label!, expected);
  const reload = await agent.get(`/api/conversations/${conversationId}/activity`).expect(200);
  assert.deepEqual(reload.body.jobEvents, activity.body.jobEvents);

  // Subscribe after the persisted snapshot, then observe a new queue event over
  // the actual SSE endpoint. No mock payloads: pumpQueue publishes the label.
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  context.after(() => { clearTimeout(timeout); controller.abort(); server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${jobId}/events?after=${instance.db.listEvents(jobId).at(-1)!.seq}`, {
    headers: { Cookie: (Array.isArray(cookie) ? cookie : [cookie]).map(value => value.split(";")[0]).join("; ") }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let streamed = "";
  while (!streamed.includes("replay_complete")) streamed += new TextDecoder().decode((await reader.read()).value);
  streamed = "";
  await instance.pumpQueue();
  while (!streamed.includes('"status":"queued"')) streamed += new TextDecoder().decode((await reader.read()).value);
  assert.match(streamed, expected);
  if (retryKind === "routing") assert.doesNotMatch(streamed, /模型容量等待中/);
  await reader.cancel();
  clearTimeout(timeout);
  instance.db.saveJobAttemptState(jobId, { ...state, nextAttemptAt: new Date(Date.now() - 1_000).toISOString() });
  await instance.pumpQueue();
  await instance.waitForBackgroundTasks();
  assert.deepEqual(started, [jobId]);
});

}

for (const blocker of ["MEMORY_WAIT", "MEMORY_GUARD", "maintenance"] as const) {
  test(`routing retry preserves ${blocker} guidance priority`, async context => {
    const { instance, root, send } = await fixture(context);
    const submitted = await send();
    instance.db.saveJobAttemptState(submitted.body.job.id, { retries: 1, capacityStartedAt: new Date().toISOString(),
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), retryKind: "routing",
      ...(blocker === "maintenance" ? {} : { resourceWait: blocker }), continuation: false,
      acceptedTurnId: null, contextRevision: null, outputs: [], images: [], imageThreadId: null });
    if (blocker === "maintenance") fs.writeFileSync(path.join(root, "data", ".codex-update-maintenance"), "active\n");
    await instance.pumpQueue();
    const events = instance.db.listEvents(submitted.body.job.id).map(row => JSON.parse(row.payload) as JobEvent);
    const label = resolveProcessStatus(events).queueStatus!.label!;
    assert.doesNotMatch(label, /上游路由|模型容量/);
    assert.match(label, blocker === "maintenance" ? /维护|更新/ : /内存/);
  });
}
