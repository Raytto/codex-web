import assert from "node:assert/strict";
import test from "node:test";
import { ProjectSyncMonitor } from "./project-sync-monitor.js";
import type { ThreadSnapshot } from "./protocol.js";

test("automatic project sync sends a full checkpoint once and behavior-level deltas afterwards", async (context) => {
  let snapshot: ThreadSnapshot = {
    id: "thread-1",
    name: "Desktop task",
    nameSource: "explicit",
    createdAt: 100,
    updatedAt: 110,
    status: "running",
    rolloutBytes: 1000,
    messages: [{ turnId: "turn-1", itemId: "user-1", role: "user", content: "Run the checks", createdAt: "2026-07-24T00:00:00.000Z" }],
    activities: [{ turnId: "turn-1", itemId: "command-1", kind: "command", label: "本机处理步骤完成", detail: "npm test", createdAt: "2026-07-24T00:00:01.000Z" }],
  };
  const observer = {
    async codexHome() { return "/unused"; },
    async listProjectThreadHeaders() { return { threads: [{ id: snapshot.id, updatedAt: snapshot.updatedAt }], nextCursor: null }; },
    async readThread() { return structuredClone(snapshot); },
    close() {},
  };
  const published: Array<{ projectId: string; snapshot: ThreadSnapshot }> = [];
  const monitor = new ProjectSyncMonitor(observer, (projectId, value) => published.push({ projectId, snapshot: value }), () => undefined, false);
  context.after(() => monitor.close());

  await monitor.replaceProjects([{ id: "project-1", rootPath: "E:\\work" }]);
  assert.equal(published.length, 1);
  assert.equal(published[0].snapshot.messages.length, 1);
  assert.equal(published[0].snapshot.activities.length, 1);

  snapshot = { ...snapshot, updatedAt: 115, rolloutBytes: 1200 };
  await monitor.reconcileAll(false);
  assert.equal(published.length, 1, "token persistence must not publish metadata-only deltas");

  snapshot = {
    ...snapshot,
    updatedAt: 120,
    status: "idle",
    messages: [
      ...snapshot.messages,
      { turnId: "turn-1", itemId: "assistant-1", role: "assistant", content: "Checks passed.", createdAt: "2026-07-24T00:00:05.000Z" },
    ],
    activities: [
      ...snapshot.activities,
      { turnId: "turn-1", itemId: "file-1", kind: "file", label: "已更新文件", files: ["src/app.ts"], createdAt: "2026-07-24T00:00:04.000Z" },
    ],
  };
  await monitor.reconcileAll(false);

  assert.equal(published.length, 2);
  assert.equal(published[1].snapshot.status, "idle");
  assert.deepEqual(published[1].snapshot.messages.map((item) => item.itemId), ["assistant-1"]);
  assert.deepEqual(published[1].snapshot.activities.map((item) => item.itemId), ["file-1"]);

  await monitor.reconcileAll(false);
  assert.equal(published.length, 2);
});

test("startup checkpoints publish oldest threads first so the newest remains at the top", async (context) => {
  const snapshots = new Map<string, ThreadSnapshot>([
    ["newest", { id: "newest", name: "Newest", nameSource: "explicit", createdAt: 200, updatedAt: 220, status: "idle", messages: [], activities: [] }],
    ["oldest", { id: "oldest", name: "Oldest", nameSource: "explicit", createdAt: 100, updatedAt: 110, status: "idle", messages: [], activities: [] }],
  ]);
  const observer = {
    async codexHome() { return "/unused"; },
    async listProjectThreadHeaders() {
      return { threads: [{ id: "newest", updatedAt: 220 }, { id: "oldest", updatedAt: 110 }], nextCursor: null };
    },
    async readThread(threadId: string) { return structuredClone(snapshots.get(threadId) ?? null); },
    close() {},
  };
  const published: string[] = [];
  const monitor = new ProjectSyncMonitor(observer, (_projectId, value) => published.push(value.id), () => undefined, false);
  context.after(() => monitor.close());

  await monitor.replaceProjects([{ id: "project-1", rootPath: "E:\\work" }]);
  assert.deepEqual(published, ["oldest", "newest"]);
});

test("large checkpoints are split below the WebSocket payload budget", async (context) => {
  const snapshot: ThreadSnapshot = {
    id: "large", name: "Large", nameSource: "explicit", createdAt: 100, updatedAt: 110, status: "idle",
    messages: Array.from({ length: 5 }, (_, index) => ({
      turnId: `turn-${index}`, itemId: `message-${index}`, role: "assistant" as const,
      content: "x".repeat(2_000_000), createdAt: "2026-07-24T00:00:00.000Z",
    })),
    activities: [],
  };
  const observer = {
    async codexHome() { return "/unused"; },
    async listProjectThreadHeaders() { return { threads: [{ id: snapshot.id, updatedAt: snapshot.updatedAt }], nextCursor: null }; },
    async readThread() { return snapshot; },
    close() {},
  };
  const published: ThreadSnapshot[] = [];
  const monitor = new ProjectSyncMonitor(observer, (_projectId, value) => published.push(value), () => undefined, false);
  context.after(() => monitor.close());

  await monitor.replaceProjects([{ id: "project-1", rootPath: "E:\\work" }]);
  assert.equal(published.length, 2);
  assert.equal(published.reduce((count, packet) => count + packet.messages.length, 0), 5);
  assert.ok(published.every((packet) => Buffer.byteLength(JSON.stringify(packet), "utf8") <= 8 * 1024 * 1024));
});
