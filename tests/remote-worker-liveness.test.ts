import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import bcrypt from "bcryptjs";
import { WebSocket } from "ws";
import { createApp } from "../server/app.js";
import { LEGACY_USER_ID } from "../server/db.js";
import { REMOTE_WORKER_PROTOCOL_VERSION } from "../server/remote-worker-protocol.js";

function message(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const listener = (raw: Buffer) => {
      const value = JSON.parse(raw.toString());
      if (value.type === type) { socket.off("message", listener); resolve(value); }
    };
    socket.on("message", listener);
  });
}

test("validated sync traffic keeps the real Worker socket alive while invalid traffic and silence do not", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-liveness-"));
  const enrollmentToken = "test-liveness-enrollment-token";
  const instance = createApp({ basePath: "", projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "tester", passwordHash: bcrypt.hashSync("test-password", 4), sessionSecret: "test-secret-longer-than-thirty-two-characters",
    queueAutoStart: false, remoteWorkerEnrollmentToken: enrollmentToken });
  const server = http.createServer(instance.app); instance.remoteWorkers.attach(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    instance.remoteWorkers.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    instance.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  instance.db.createRemoteWorkerEnrollment(crypto.createHash("sha256").update(enrollmentToken).digest("hex"), new Date(Date.now() + 600_000).toISOString());
  const workerId = crypto.randomUUID();
  const project = instance.db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "sync test", "C:/work", `remote:${workerId}`);
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/remote-workers/connect`); sockets.push(socket);
    const authenticated = message(socket, "authenticated"); await once(socket, "open");
    socket.send(JSON.stringify({ type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, workerId, machineName: "LIVENESS", enrollmentToken,
      platform: "win32-x64", workerVersion: "test", codexVersion: "test", capacity: 1 }));
    await authenticated;
    const ack = message(socket, "heartbeat_ack"); socket.send(JSON.stringify({ type: "heartbeat", activeJobs: [] })); await ack;
    return socket;
  }
  const socket = await connect();
  const gateway = instance.remoteWorkers;
  const sweep = () => Reflect.get(gateway, "checkHeartbeats").call(gateway);
  // Reproduce a slow startup history stream. The heartbeat is older than the
  // watchdog threshold, but authenticated, schema-valid snapshots still arrive.
  t.mock.timers.tick(60_000);
  const imported = once(gateway, "thread_activity");
  socket.send(JSON.stringify({ type: "thread_activity", projectId: project.id, thread: {
    id: crypto.randomUUID(), name: "sync", nameSource: "explicit", createdAt: 1, updatedAt: 2, status: "idle", messages: [], activities: [],
  } }));
  await imported; sweep();
  assert.equal(gateway.executor(`remote:${workerId}`)?.status, "online");
  socket.on("message", raw => {
    const request = JSON.parse(raw.toString());
    if (request.type === "project_fs") socket.send(JSON.stringify({ type: "project_fs_result", requestId: request.requestId, directory: "C:/work", parent: "C:/", directories: [] }));
  });
  assert.equal((await gateway.projectFs(`remote:${workerId}`, "list", "C:/work")).directory, "C:/work");

  // An invalid frame must not refresh authenticated liveness.
  t.mock.timers.tick(60_000);
  const rejected = message(socket, "request_failed"); socket.send(JSON.stringify({ type: "unexpected_worker_message" })); await rejected;
  const closed = once(socket, "close"); sweep(); await closed;
  assert.equal(gateway.executor(`remote:${workerId}`)?.status, "offline");

  // A genuinely silent reconnect still expires on the original bound.
  const silent = await connect(); t.mock.timers.tick(46_000);
  const silentClosed = once(silent, "close"); sweep(); await silentClosed;
  assert.equal(gateway.executor(`remote:${workerId}`)?.status, "offline");
});
