import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";

const PASSWORD = "Resumable-Test-Password-2026!";
const TUS_HEADERS = { "Tus-Resumable": "1.0.0" };

function metadata(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`).join(",");
}

function uploadId(location: string): string {
  return location.split("/").filter(Boolean).at(-1)!;
}

test("tus upload persists confirmed offsets, enforces ownership and registers an idempotent draft file", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-tus-api-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    basePath: "",
    username: "owner", passwordHash: bcrypt.hashSync(PASSWORD, 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    minimumFreeDiskBytes: 1, maxStoredBytesPerUser: 100,
  });
  const friendId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.createUser({
    id: friendId, username: "friend", display_name: "Friend", password_hash: bcrypt.hashSync(PASSWORD, 8),
    role: "member", status: "active", created_at: now, updated_at: now,
  });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const owner = request.agent(instance.app);
  const friend = request.agent(instance.app);
  const ownerLogin = await owner.post("/api/auth/login").send({ username: "owner", password: PASSWORD }).expect(200);
  const friendLogin = await friend.post("/api/auth/login").send({ username: "friend", password: PASSWORD }).expect(200);
  const conversation = await owner.post("/api/conversations").set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(201);
  const conversationId = conversation.body.conversation.id as string;
  const payload = Buffer.from("hello-world!");

  await owner.post("/api/uploads").set(TUS_HEADERS)
    .set("Upload-Length", String(payload.length))
    .set("Upload-Metadata", metadata({ filename: "resume.txt", filetype: "text/plain", conversationId }))
    .expect(403);
  const created = await owner.post("/api/uploads").set(TUS_HEADERS).set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .set("Upload-Length", String(payload.length))
    .set("Upload-Metadata", metadata({ filename: "resume.txt", filetype: "text/plain", conversationId }))
    .expect(201);
  assert.match(created.headers.location, /^\/api\/uploads\/[0-9a-f-]{36}$/);
  const location = created.headers.location as string;
  const id = uploadId(location);

  await owner.patch(location).set(TUS_HEADERS).set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .set("Upload-Offset", "0").set("Content-Type", "application/offset+octet-stream")
    .set("Content-Length", "5").send(payload.subarray(0, 5)).expect(204).expect("Upload-Offset", "5");
  await owner.head(location).set(TUS_HEADERS).expect(200).expect("Upload-Offset", "5").expect("Upload-Length", String(payload.length));
  await friend.head(location).set(TUS_HEADERS).expect(404);
  await owner.patch(location).set(TUS_HEADERS).set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .set("Upload-Offset", "0").set("Content-Type", "application/offset+octet-stream")
    .set("Content-Length", "1").send(payload.subarray(0, 1)).expect(409).expect("Upload-Offset", "5");

  await owner.patch(location).set(TUS_HEADERS).set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .set("Upload-Offset", "5").set("Content-Type", "application/offset+octet-stream")
    .set("Content-Length", String(payload.length - 5)).send(payload.subarray(5)).expect(204).expect("Upload-Offset", String(payload.length));
  const result = await owner.get(`${location}/result`).expect(200);
  assert.equal(result.body.uploadedFiles.length, 1);
  assert.equal(result.body.uploadedFiles[0].size, payload.length);
  const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");
  assert.equal(instance.db.getFile(result.body.uploadedFiles[0].id)?.sha256, expectedHash);
  assert.equal(instance.db.getResumableUpload(id)?.state, "completed");
  const stored = path.join(root, "tenants", instance.db.getResumableUpload(id)!.user_id, "conversations", conversationId, result.body.uploadedFiles[0].relative_path);
  assert.deepEqual(fs.readFileSync(stored), payload);
  await owner.get(`${location}/result`).expect(200);
  assert.equal(instance.db.listFiles(conversationId).length, 1);

  await owner.delete(`/api/conversations/${conversationId}/draft/files/${result.body.uploadedFiles[0].id}`)
    .set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(200);
  assert.equal(fs.existsSync(stored), false);
  assert.equal(instance.db.getResumableUpload(id), undefined);

  const friendConversation = await friend.post("/api/conversations").set("X-CSRF-Token", friendLogin.body.csrfToken).expect(201);
  const reserve = (size: number) => friend.post("/api/uploads").set(TUS_HEADERS).set("X-CSRF-Token", friendLogin.body.csrfToken)
    .set("Upload-Length", String(size))
    .set("Upload-Metadata", metadata({ filename: `${size}.bin`, filetype: "application/octet-stream", conversationId: friendConversation.body.conversation.id }));
  const firstReservation = await reserve(60).expect(201);
  await reserve(41).expect(413).expect((response) => assert.equal(response.body.code, "USER_STORAGE_LIMIT"));
  await friend.delete(firstReservation.headers.location).set(TUS_HEADERS).set("X-CSRF-Token", friendLogin.body.csrfToken).expect(204);
  assert.equal(instance.db.sumActiveResumableBytesForUser(friendId), 0);
});

test("startup recovery finalizes a fully written partial and expiry cleanup releases reservations", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-tus-recovery-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    basePath: "",
    username: "recover", passwordHash: bcrypt.hashSync(PASSWORD, 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    minimumFreeDiskBytes: 1, maxStoredBytesPerUser: 1_000,
  });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const browser = request.agent(instance.app);
  const login = await browser.post("/api/auth/login").send({ username: "recover", password: PASSWORD }).expect(200);
  const conversation = await browser.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const payload = Buffer.from("crash-safe-content");
  const created = await browser.post("/api/uploads").set(TUS_HEADERS).set("X-CSRF-Token", login.body.csrfToken)
    .set("Upload-Length", String(payload.length))
    .set("Upload-Metadata", metadata({ filename: "recovered.bin", filetype: "application/octet-stream", conversationId: conversation.body.conversation.id }))
    .expect(201);
  const id = uploadId(created.headers.location);
  const row = instance.db.getResumableUpload(id)!;
  fs.writeFileSync(path.join(instance.resumableUploads.root, row.storage_name), payload, { mode: 0o600 });
  const recovery = await instance.resumableUploads.recover();
  assert.equal(recovery.reconciled, 1);
  assert.equal(recovery.finalized, 1);
  assert.equal(instance.db.getResumableUpload(id)?.state, "completed");
  assert.equal(instance.db.getFile(row.file_id)?.sha256, crypto.createHash("sha256").update(payload).digest("hex"));

  const expiring = await browser.post("/api/uploads").set(TUS_HEADERS).set("X-CSRF-Token", login.body.csrfToken)
    .set("Upload-Length", "25")
    .set("Upload-Metadata", metadata({ filename: "expired.bin", filetype: "application/octet-stream", conversationId: conversation.body.conversation.id }))
    .expect(201);
  const expiringId = uploadId(expiring.headers.location);
  instance.db.sqlite.prepare("UPDATE resumable_uploads SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), expiringId);
  const cleanup = await instance.resumableUploads.cleanupExpired();
  assert.equal(cleanup.expired, 1);
  assert.equal(instance.db.getResumableUpload(expiringId)?.state, "expired");
  assert.equal(fs.existsSync(path.join(instance.resumableUploads.root, `${expiringId}.part`)), false);
});
