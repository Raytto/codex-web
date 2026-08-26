import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DurableOutbox } from "./durable-outbox.js";

test("durable outbox survives restart, is bounded and clears after replay", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-outbox-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "outbox.json");
  const reports: string[] = [];
  const first = new DurableOutbox(file, (message) => reports.push(message));
  for (let index = 0; index < 501; index += 1) {
    first.enqueue({ type: "request_failed", requestId: crypto.randomUUID(), message: `offline-${index}` });
  }
  assert.equal(first.length, 500);
  assert.ok(reports.some((message) => message.includes("dropped")));
  assert.ok(fs.statSync(file).size < 8 * 1024 * 1024 + 64 * 1024);

  const restored = new DurableOutbox(file);
  assert.equal(restored.length, 500);
  const replayed: string[] = [];
  assert.equal(restored.flush((message) => replayed.push(message.type)), 500);
  assert.equal(replayed.every((type) => type === "request_failed"), true);
  assert.equal(fs.existsSync(file), false);
});

test("durable outbox never persists the enrollment hello or oversized payloads", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-outbox-secret-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "outbox.json");
  const outbox = new DurableOutbox(file);
  const result = outbox.enqueue({
    type: "hello", protocolVersion: 5, workerId: crypto.randomUUID(), machineName: "worker",
    enrollmentToken: "secret-enrollment-token", platform: "win32-x64", workerVersion: "1.15.0",
    workerRelease: null, workerCommit: null,
    capabilities: { workerUpdate: true, waitAutomation: true, capacityConfig: true }, codexVersion: "0.144.1", capacity: 1,
  });
  assert.deepEqual(result, { accepted: false, dropped: 0, reason: "invalid" });
  assert.equal(fs.existsSync(file), false);
});
