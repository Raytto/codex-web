import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { AppDatabase } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
test("real Worker handshake binds device credentials, rejects shared tokens and takeover, and survives lost rotation acknowledgement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-credentials-"));
  const db = new AppDatabase(root);
  const config = loadConfig({ projectRoot: process.cwd(), basePath: "", dataRoot: root, tenantRoot: path.join(root, "tenants"), remoteWorkerEnrollmentToken: "obsolete-shared-secret" });
  const gateway = new RemoteWorkerGateway(config, db);
  const server = http.createServer(); gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const sockets: WebSocket[] = [];
  t.after(async () => { gateway.close(); for (const socket of sockets) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function connect(workerId: string, token: string): Promise<{ socket: WebSocket; accepted: boolean; reason?: string; messages: Array<Record<string, unknown>> }> {
    const socket = new WebSocket(`ws://127.0.0.1:${addr.port}/api/remote-workers/connect`); sockets.push(socket);
    const messages: Array<Record<string, unknown>> = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("handshake timeout")), 2_000);
      socket.once("error", reject);
      socket.once("open", () => socket.send(JSON.stringify({ type: "hello", workerId, enrollmentToken: token, machineName: workerId.slice(0, 12),
        protocolVersion: 5, workerVersion: "test", platform: "linux", codexVersion: "test", capacity: 1, capabilities: { deviceCredentials: true } })));
      socket.on("message", (raw) => { messages.push(JSON.parse(raw.toString())); if (JSON.parse(raw.toString()).type === "authenticated") { clearTimeout(timer); resolve({ socket, accepted: true, messages }); } });
      socket.once("close", (code, reason) => { clearTimeout(timer); resolve({ socket, accepted: false, messages, reason: `${code} ${reason}` }); });
    });
  }
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  const tokenA = crypto.randomBytes(32).toString("base64url"), tokenB = crypto.randomBytes(32).toString("base64url");
  assert.equal((await connect(a, config.remoteWorkerEnrollmentToken)).accepted, false);
  db.createRemoteWorkerEnrollment(hash(tokenA), new Date(Date.now() + 60_000).toISOString());
  const first = await connect(a, tokenA); assert.equal(first.accepted, true);
  assert.equal(db.remoteWorkerEnrollment(hash(tokenA)), undefined);
  assert.equal((await connect(b, tokenA)).accepted, false);
  db.createRemoteWorkerEnrollment(hash(tokenB), new Date(Date.now() + 60_000).toISOString());
  assert.equal((await connect(a, tokenB)).accepted, false, "fresh enrollment cannot replace an existing Worker");
  assert.equal(first.socket.readyState, WebSocket.OPEN, "rejected takeover must not disconnect the legitimate device");
  const second = await connect(b, tokenB); assert.equal(second.accepted, true, second.reason);
  let replacement!: { token: string; credentialId: string };
  const received = new Promise<void>((resolve) => first.socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()); if (message.type === "credential_replace") { replacement = message; resolve(); }
  }));
  gateway.rotateDeviceCredential(a); await received;
  assert.equal(db.activeRemoteWorkerCredential(hash(tokenA))?.worker_id, a, "old credential remains valid until save is confirmed");
  assert.equal((await connect(a, replacement.token)).accepted, true, "reconnect with saved token implicitly confirms a lost ack");
  assert.equal(db.pendingRemoteWorkerCredential(a), undefined);
  assert.equal((await connect(a, tokenA)).accepted, false);
  assert.equal((await connect(b, replacement.token)).accepted, false);
  gateway.revokeDeviceCredential(a);
  assert.equal((await connect(a, replacement.token)).accepted, false);
  assert.equal((await connect(a, config.remoteWorkerEnrollmentToken)).accepted, false, "revocation must never downgrade to shared auth");
  assert.equal((await connect(b, tokenB)).accepted, true, "revoking A must leave B available");
  assert.equal(gateway.authorizeReleaseDownload(`Bearer ${replacement.token}`), false);
  assert.equal(gateway.authorizeReleaseDownload(`Bearer ${tokenB}`), true);
  const expired = crypto.randomBytes(32).toString("hex");
  db.createRemoteWorkerEnrollment(hash(expired), "2000-01-01T00:00:00.000Z");
  assert.equal((await connect(crypto.randomUUID(), expired)).accepted, false);
  const legacyId = crypto.randomUUID();
  db.registerRemoteWorker({ id: legacyId, machine_name: "Legacy", platform: "win32-x64", protocol_version: 5,
    worker_version: "1.18.7", worker_release: null, worker_commit: null, worker_update_capable: 0, codex_version: "test", capacity: 1 });
  assert.equal((await connect(legacyId, config.remoteWorkerEnrollmentToken)).accepted, false, "legacy migration is never enabled implicitly");
  fs.writeFileSync(path.join(root, "worker-credential-migration.json"), JSON.stringify({ version: 1,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), workerIds: [legacyId] }));
  const maintenance = path.join(root, ".codex-update-maintenance");
  fs.writeFileSync(maintenance, "active");
  assert.equal((await connect(legacyId, config.remoteWorkerEnrollmentToken)).accepted, false, "candidate promotion cannot migrate device credentials before health acceptance");
  fs.rmSync(maintenance);
  const migration = await connect(legacyId, config.remoteWorkerEnrollmentToken);
  assert.equal(migration.accepted, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gateway.canRun(`remote:${legacyId}`), false);
  assert.throws(() => gateway.rotateDeviceCredential(legacyId), /迁移/);
  assert.equal(migration.messages.some((message) => message.type === "project_watch"), false);
  const offered = migration.messages.find((message) => message.type === "credential_replace"); assert.ok(offered);
  assert.equal((await connect(legacyId, offered.token as string)).accepted, true);
  assert.equal((await connect(legacyId, config.remoteWorkerEnrollmentToken)).accepted, false);
  gateway.revokeDeviceCredential(legacyId);
  assert.equal((await connect(legacyId, config.remoteWorkerEnrollmentToken)).accepted, false, "a surviving migration manifest cannot bypass revocation");

});
