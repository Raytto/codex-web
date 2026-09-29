import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import type { JobEvent } from "../src/api.js";
import { mergeJobEvents } from "../src/recovery.js";
import { buildProcessJournal } from "../src/process-journal.js";

const visible: JobEvent[] = [
  { seq: 1, type: "status", status: "running" },
  { seq: 2, type: "progress", kind: "update", label: "阶段反馈", detail: "正在核查" },
  { seq: 3, type: "progress", kind: "search", label: "搜索完成", detail: "查询资料" },
  { seq: 4, type: "progress", kind: "reasoning", label: "模型思路摘要", detail: "核对结果" },
];
const stream: JobEvent[] = Array.from({ length: 120 }, (_, index) => ({
  seq: index + 5, type: "progress", kind: "assistant_stream", label: "正在生成回答", detail: `回答片段 ${index}`,
}));

test("hidden answer streaming cannot evict the running journal during live delivery or replay", () => {
  let live = mergeJobEvents([], visible);
  for (const event of stream) {
    live = mergeJobEvents(live, [event]);
    assert.deepEqual(live, visible);
  }
  assert.deepEqual(mergeJobEvents([], [...visible, ...stream]), visible);
  assert.deepEqual(mergeJobEvents(live, [...visible, ...stream]), visible);
  assert.deepEqual(buildProcessJournal(live).map(event => event.kind), ["update", "search", "reasoning"]);

  // A genuinely full activity window still rolls off the oldest ordinary steps.
  const later: JobEvent[] = Array.from({ length: 50 }, (_, index) => ({
    seq: index + 125, type: "progress", kind: "search", label: `搜索 ${index}`,
  }));
  const rolled = mergeJobEvents(live, later);
  assert.deepEqual(rolled.map(event => event.seq), [2, ...later.map(event => event.seq)]);
});

test("activity/detail snapshots exclude hidden streams before limiting while raw SSE retains them", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-stream-retention-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "demo", passwordHash: bcrypt.hashSync("Test-Progress-2026!", 8),
    sessionSecret: "isolated-test-session-secret-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/api/auth/login").send({ username: "demo", password: "Test-Progress-2026!" }).expect(200);
  const conversationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "进度保留回归");
  instance.db.createJob(jobId, conversationId);
  instance.db.updateJob(jobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  for (const { seq: _seq, type, ...payload } of [...visible, ...stream]) instance.db.appendEvent(jobId, type!, payload);

  for (const suffix of ["/activity", ""]) {
    const response = await agent.get(`/api/conversations/${conversationId}${suffix}`).expect(200);
    assert.deepEqual(response.body.jobEvents.map((event: JobEvent) => event.seq), [1, 2, 3, 4]);
    assert.deepEqual(buildProcessJournal(mergeJobEvents([], response.body.jobEvents)).map(event => event.kind), ["update", "search", "reasoning"]);
  }
  assert.equal(instance.db.listEvents(jobId).length, 124);
  assert.equal(instance.db.listRecentEvents(jobId, 50).length, 50);
  instance.db.updateJob(jobId, "completed");
  const replay = await agent.get(`/api/jobs/${jobId}/events?after=4`).expect(200);
  const replayed = replay.text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(replayed.filter(event => event.kind === "assistant_stream").length, 120);
  assert.equal(replayed.at(-1).type, "replay_complete");
});
