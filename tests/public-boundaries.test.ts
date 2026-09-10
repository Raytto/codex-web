import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";

test("public subpath keeps password login, rejects SMS routes and protects credential administration", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-boundary-"));
  const instance = createApp({ projectRoot: process.cwd(), basePath: "/codex-web",
    dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    codexHome: path.join(root, "codex"), pythonRuntimeRoot: path.join(root, "python"),
    username: "public-user", passwordHash: bcrypt.hashSync("fixture-password", 4),
    sessionSecret: "fixture-session-secret-for-public-boundary", queueAutoStart: false,
    remoteWorkerEnrollmentToken: "", remoteWorkerReleaseRoot: path.join(root, "no-release"),
    hostRootSocketPath: "", hostTenantRoot: "", hostKnowledgeRoot: "", hostRootCodexHome: "",
    personalMemoryApiKey: "", personalMemoryBaseUrl: "", dashscopeApiKey: "", dashscopeBaseUrl: "" });
  t.after(async () => { instance.beginShutdown(); await instance.waitForBackgroundTasks(); instance.remoteWorkers.close(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await request(instance.app).get("/codex-web/api/health").expect(200);
  const page = await request(instance.app).get("/codex-web/").expect(200);
  const script = /<script[^>]+src="([^"]+\.js)"/.exec(page.text)?.[1];
  assert.ok(script?.startsWith("/codex-web/assets/"));
  await request(instance.app).get(script).expect(200).expect("Content-Type", /javascript/);
  const browser = request.agent(instance.app);
  const login = await browser.post("/codex-web/api/auth/login")
    .send({ username: "public-user", password: "fixture-password" }).expect(200);
  assert.ok(login.body.csrfToken);
  await browser.get("/codex-web/api/auth/session").expect(200);
  await browser.post("/codex-web/api/executors/remote:example/worker/credential/rotate")
    .set("X-CSRF-Token", login.body.csrfToken).send({}).expect(403);
  await browser.post("/codex-web/api/auth/sms/send")
    .set("X-CSRF-Token", login.body.csrfToken).send({}).expect(404);
  await browser.post("/api/auth/login").send({ username: "public-user", password: "fixture-password" }).expect(404);
  const columns = instance.db.sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  assert.ok(columns.some(column => column.name === "password_hash"));
  assert.equal(columns.some(column => column.name === "phone" || column.name === "phone_number"), false);
  assert.throws(() => instance.remoteWorkers.createBootstrapGrant("windows"), /尚未配置/);
});
