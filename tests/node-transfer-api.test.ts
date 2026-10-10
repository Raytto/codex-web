import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import bcrypt from "bcryptjs";
import request from "supertest";
import { WebSocket } from "ws";
import { createApp } from "../server/app.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";

test("transfer API enforces login, account boundary, CSRF, job credentials and relay authentication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppa-transfer-api-"));
  const instance = createApp({
    projectRoot: process.cwd(),
    basePath: "/codex-web",
    hostRootSocketPath: "",
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "member",
    passwordHash: bcrypt.hashSync("Test-Password-2026!", 8),
    sessionSecret:
      "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  instance.nodeTransfers.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await request(server).get("/codex-web/api/transfers").expect(401);
    await request(server)
      .get("/codex-web/api/automation/jobs/unknown/transfers")
      .expect(401);
    const member = request.agent(server);
    await member
      .post("/codex-web/api/auth/login")
      .send({ username: "member", password: "Test-Password-2026!" })
      .expect(200);
    await member.get("/codex-web/api/transfers").expect(403);
    const now = new Date().toISOString();
    instance.db.createUser({
      id: HOST_ROOT_USER_ID,
      username: "owner",
      display_name: "Host administrator",
      password_hash: bcrypt.hashSync("Host-Password-2026!", 8),
      role: "owner",
      status: "active",
      created_at: now,
      updated_at: now,
    });
    const admin = request.agent(server);
    const login = await admin
      .post("/codex-web/api/auth/login")
      .send({ username: "owner", password: "Host-Password-2026!" })
      .expect(200);
    await admin.get("/codex-web/api/transfers").expect(200, { transfers: [] });
    const nodes = await admin.get("/codex-web/api/transfers/nodes").expect(200);
    assert.ok(nodes.body.nodes.every((node: {capable: boolean}) => !node.capable), "empty optional configuration exposes no capable endpoints");
    await admin.post("/codex-web/api/transfers").set("X-CSRF-Token", login.body.csrfToken)
      .send({ source: {executorId: "local-host", path: "/fixture/source"}, target: {executorId: "remote:fixture", path: "/fixture/target"}, idempotencyKey: "disabled-fixture" }).expect(400);
    await admin.post("/codex-web/api/transfers").send({}).expect(403);
    await admin
      .post("/codex-web/api/transfers")
      .set("X-CSRF-Token", login.body.csrfToken)
      .send({})
      .expect(400);
    await admin.get("/codex-web/api/transfers/missing").expect(404);
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${(server.address() as { port: number }).port}/codex-web/api/node-transfers/connect`,
      );
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode!);
        res.resume();
        ws.terminate();
      });
      ws.on("error", () => {});
      ws.on("open", () => {
        ws.close();
        reject(new Error("unauthenticated relay opened"));
      });
    });
    assert.equal(status, 401);
    // Reject a malformed upgrade target without throwing from the shared server.
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect((server.address() as {port: number}).port, "127.0.0.1");
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("malformed upgrade was not closed")); });
      socket.once("connect", () => socket.write("GET //[/ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
      socket.on("error", () => {});
      socket.once("close", () => resolve());
    });
    await request(server).get("/codex-web/api/health").expect(200);
  } finally {
    instance.nodeTransfers.close();
    instance.remoteWorkers.close();
    await new Promise<void>((r) => server.close(() => r()));
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
