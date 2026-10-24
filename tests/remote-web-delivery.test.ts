import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { WebSocket } from "ws";
import { createApp } from "../server/app.js";
import { HOST_ROOT_USER_ID } from "../server/host-root-user.js";
import { REMOTE_WORKER_PROTOCOL_VERSION } from "../server/remote-worker-protocol.js";

const html = '<!doctype html><meta charset="utf-8"><meta name="pp-agent-view" content="web"><title>远端城市</title><svg id="city"></svg><button onclick="this.textContent=\'已点击\'">方案 A</button><script>document.querySelector("#city").innerHTML="<rect width=20 height=20 />"</script>';
const digest = (body: string) => crypto.createHash("sha256").update(body).digest("hex");

test("real remote fetch preserves managed declarations, private immutable versions and delivery failures", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-remote-web-")), dataRoot = path.join(root, "data");
  const enrollmentToken = "test-remote-web-enrollment-token";
  const instance = createApp({ projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"),
    username: "pp", passwordHash: bcrypt.hashSync("Owner-Password-2026!", 4), sessionSecret: "test-secret-longer-than-thirty-two-characters",
    queueAutoStart: false, remoteWorkerEnrollmentToken: enrollmentToken });
  const server = http.createServer(instance.app);
  instance.remoteWorkers.attach(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const workerId = crypto.randomUUID(), now = new Date().toISOString();
  instance.db.createRemoteWorkerEnrollment(digest(enrollmentToken), new Date(Date.now() + 60_000).toISOString());
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/api/remote-workers/connect");
  const remote = new Map<string, string>();
  const errors = new Map<string, string>();
  const requests: string[] = [];
  const corrupt = new Set<string>();
  const authenticated = new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({ type: "hello", protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId, machineName: "WEB-TEST", enrollmentToken, platform: "win32-x64", workerVersion: "test", codexVersion: "test", capacity: 1 })));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "authenticated") resolve();
      if (message.type !== "file_fetch") return;
      requests.push(message.path);
      const body = remote.get(message.path);
      if (errors.has(message.path) || body === undefined) {
        socket.send(JSON.stringify({ type: "file_fetch_result", requestId: message.requestId, ok: false,
          message: errors.get(message.path) ?? "找不到文件", errorCode: errors.has(message.path) ? undefined : "NOT_FOUND" }));
        return;
      }
      void fetch(`${origin}/api/remote-worker-files/fetch/${message.requestId}`, {
        method: "PUT", headers: { authorization: `Bearer ${message.transferToken}`, "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(path.posix.basename(message.path)) }, body,
      }).then(response => {
        if (response.ok && corrupt.has(message.path)) {
          // Inject disk corruption after the authenticated upload was hashed,
          // before final publication. A transport failure must never downgrade.
          const directory = path.join(dataRoot, "remote-worker-fetch-staging", message.requestId);
          const staged = fs.readdirSync(directory).filter(name => !name.endsWith(".part"));
          assert.equal(staged.length, 1);
          fs.appendFileSync(path.join(directory, staged[0]), "corrupt");
        }
        socket.send(JSON.stringify({ type: "file_fetch_result", requestId: message.requestId,
          ok: response.ok, message: response.ok ? undefined : `文件回传失败（${response.status}）` }));
      }).catch(reject);
    });
  });
  await authenticated;
  t.after(async () => {
    if (socket.readyState === WebSocket.OPEN) await new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.close(); });
    instance.remoteWorkers.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    instance.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  instance.db.createUser({ id: HOST_ROOT_USER_ID, username: "host-fixture", display_name: "CODEX_WEB", password_hash: bcrypt.hashSync("Host-Password-2026!", 4),
    role: "owner", status: "active", created_at: now, updated_at: now });
  const project = instance.db.createProject(crypto.randomUUID(), HOST_ROOT_USER_ID, "remote", "E:/work", `remote:${workerId}`);
  const conversation = instance.db.createConversation(crypto.randomUUID(), "remote web", undefined, HOST_ROOT_USER_ID, project.id);
  const messageId = crypto.randomUUID();
  instance.db.addMessage({ id: messageId, conversation_id: conversation.id, role: "assistant", content: "test outputs", created_at: now });
  const owner = request.agent(server), guest = request(server);
  const login = await owner.post("/api/auth/login").send({ username: "host-fixture", password: "Host-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken;
  const route = `/api/conversations/${conversation.id}/messages/${messageId}/remote-file`;
  const fetchFile = (sourcePath: string) => owner.post(route).set("X-CSRF-Token", csrf).send({ path: sourcePath });
  function declared(name: string, body = html, hash = digest(body)) {
    const source = `E:/work/${name}`;
    remote.set(source, body);
    remote.set(source + ".pp-agent.json", JSON.stringify({ presentation_mode: "web", sha256: hash }));
    return source;
  }
  await guest.post(route).send({ path: "E:/work/demo.html" }).expect(401);
  const ordinary = request.agent(server);
  const ordinaryLogin = await ordinary.post("/api/auth/login").send({ username: "pp", password: "Owner-Password-2026!" }).expect(200);
  await ordinary.post(route).set("X-CSRF-Token", ordinaryLogin.body.csrfToken).send({ path: "E:/work/demo.html" }).expect(403);

  const source = declared("demo.html");
  const [first, concurrent] = await Promise.all([fetchFile(source), fetchFile(source)]);
  assert.deepEqual([first.status, concurrent.status].sort(), [200, 201]);
  assert.equal(first.body.file.id, concurrent.body.file.id);
  const file = first.body.file;
  assert.equal(file.presentation_mode, "web"); assert.equal(file.mime_type, "text/html"); assert.equal(file.sha256, digest(html));
  assert.deepEqual(first.body.warnings, []);
  assert.equal(instance.db.listFilesForMessage(messageId).length, 1);
  assert.equal((await owner.get(`/api/files/${file.id}/share`).expect(200)).body.share.status, "private");
  const runtime = (await owner.get(`/api/files/${file.id}/web-session`).expect(200)).body;
  await guest.get(`/api/files/${file.id}/web-session`).expect(401); await guest.get(runtime.src).expect(404);
  const content = await owner.get(runtime.src).set("Sec-Fetch-Dest", "iframe").expect(200);
  assert.match(content.text, /querySelector/); assert.match(content.headers["content-security-policy"], /sandbox allow-scripts/);
  assert.doesNotMatch(content.headers["content-security-policy"], /allow-same-origin/);
  await owner.get(`/api/reader/files/${file.id}/manifest`).expect(415);
  await owner.get(runtime.src).set("Sec-Fetch-Dest", "document").expect(404);
  assert.equal((await fetchFile(source).expect(200)).body.file.id, file.id);
  assert.equal(requests.filter(item => item.startsWith(source)).length, 2);

  const legacySource = "E:/work/legacy.html";
  remote.set(legacySource, html);
  const legacy = (await fetchFile(legacySource).expect(201)).body;
  assert.equal(legacy.file.presentation_mode, "reader"); assert.match(legacy.warnings[0].reason, /脚本不会运行/);
  const share = (await owner.post(`/api/files/${legacy.file.id}/share`).set("X-CSRF-Token", csrf).expect(200)).body.share;
  remote.set(legacySource + ".pp-agent.json", JSON.stringify({ presentation_mode: "web", sha256: digest(html) }));
  const corrected = (await fetchFile(legacySource).expect(201)).body.file;
  assert.notEqual(corrected.id, legacy.file.id); assert.equal(corrected.previous_file_id, legacy.file.id); assert.equal(corrected.presentation_mode, "web");
  assert.equal(instance.db.getFile(legacy.file.id)?.presentation_mode, "reader");
  assert.equal(instance.db.getPublicFileShare(legacy.file.id)?.expires_at, share.expiresAt);
  assert.equal((await owner.get(`/api/files/${corrected.id}/share`).expect(200)).body.share.status, "private");
  assert.equal((await fetchFile(legacySource).expect(200)).body.file.id, corrected.id);

  for (const [name, body, hash, reason] of [
    ["wrong.html", html, "0".repeat(64), /SHA-256/],
    ["external.html", html + '<script src="app.js"></script>', undefined, /脚本必须内嵌/],
  ] as const) {
    const rejectedSource = declared(name, body, hash);
    const rejected = (await fetchFile(rejectedSource).expect(201)).body;
    assert.equal(rejected.file.presentation_mode, "reader"); assert.equal(rejected.file.presentation_manifest, null);
    assert.match(rejected.warnings[0].reason, reason);
    await owner.get(`/api/files/${rejected.file.id}/web-session`).expect(404);
    assert.equal((await fetchFile(rejectedSource).expect(200)).body.file.id, rejected.file.id);
  }
  const malformed = declared("malformed.html"); remote.set(malformed + ".pp-agent.json", "not json");
  assert.match((await fetchFile(malformed).expect(201)).body.warnings[0].reason, /JSON/);
  const olderWorkerSource = "E:/work/old-worker.html";
  remote.set(olderWorkerSource, html); errors.set(olderWorkerSource + ".pp-agent.json", "文件不存在或无法访问");
  const older = (await fetchFile(olderWorkerSource).expect(201)).body;
  assert.equal(older.file.presentation_mode, "reader"); assert.match(older.warnings[0].reason, /未能读取/);
  const failedSource = declared("failed.html"); errors.set(failedSource + ".pp-agent.json", "EACCES: permission denied");
  assert.match((await fetchFile(failedSource).expect(409)).body.error, /EACCES/);
  assert.equal(instance.db.getFileForMessageSource(messageId, failedSource), undefined);
  const corruptSource = declared("corrupt.html"); corrupt.add(corruptSource + ".pp-agent.json");
  assert.match((await fetchFile(corruptSource).expect(409)).body.error, /回传校验失败/);
  assert.equal(instance.db.getFileForMessageSource(messageId, corruptSource), undefined);
  await fetchFile(source + ".pp-agent.json").expect(400);
  assert.equal(instance.db.listFilesForMessage(messageId).some(item => item.original_name.endsWith(".pp-agent.json")), false);
  for (const directory of ["finalization", "remote-worker-fetch-staging"]) {
    const absolute = path.join(dataRoot, directory);
    assert.deepEqual(fs.existsSync(absolute) ? fs.readdirSync(absolute) : [], []);
  }
});

test("explicit presentation correction normalizes legacy octet-stream HTML only on the new private version", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-legacy-html-mime-")), dataRoot = path.join(root, "data");
  const instance = createApp({ projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), username: "pp",
    passwordHash: bcrypt.hashSync("Test-password-2026!", 4), sessionSecret: "test-secret-longer-than-thirty-two-characters", queueAutoStart: false });
  t.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "legacy MIME"), messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.addMessage({ id: messageId, conversation_id: conversation.id, role: "assistant", content: "test", created_at: now });
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login").send({ username: "pp", password: "Test-password-2026!" }).expect(200);
  for (const kind of ["output", "upload"] as const) {
    const id = crypto.randomUUID(), relative = `deliverables/${id}/历史网页.html`;
    const storageRoot = kind === "output" ? dataRoot : path.join(root, "tenants", conversation.user_id, "conversations", conversation.id);
    fs.mkdirSync(path.dirname(path.join(storageRoot, relative)), { recursive: true }); fs.writeFileSync(path.join(storageRoot, relative), html);
    instance.db.addFile({ id, conversation_id: conversation.id, message_id: messageId, original_name: "历史网页.html", relative_path: relative,
      source_path: "E:/outputs/历史网页.html", mime_type: "application/octet-stream", size: Buffer.byteLength(html), sha256: digest(html), kind,
      presentation_mode: "reader", created_at: now });
    const corrected = (await owner.post(`/api/files/${id}/presentation-version`).set("X-CSRF-Token", login.body.csrfToken)
      .send({ presentation_mode: "web" }).expect(201)).body;
    assert.equal(corrected.file.mime_type, "text/html"); assert.equal(corrected.file.kind, "output");
    assert.equal(corrected.file.presentation_mode, "web"); assert.equal(corrected.file.previous_file_id, id);
    assert.equal(corrected.share.status, "private"); assert.equal(instance.db.getFile(id)?.mime_type, "application/octet-stream");
    assert.equal(instance.db.getFile(id)?.presentation_mode, "reader");
    await owner.get(`/api/files/${corrected.file.id}/web-session`).expect(200);
  }
});
