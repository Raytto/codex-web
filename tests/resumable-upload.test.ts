import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";

const PASSWORD = "fixture";
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
  assert.equal(instance.resumableUploads.root, path.join(root, "tenants", ".resumable-uploads"));

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
  const legacyDataRoot = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "codex-web-tus-legacy-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: legacyDataRoot, tenantRoot: path.join(root, "tenants"),
    username: "recover", passwordHash: bcrypt.hashSync(PASSWORD, 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false,
    minimumFreeDiskBytes: 1, maxStoredBytesPerUser: 1_000,
  });
  context.after(() => {
    instance.beginShutdown();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(legacyDataRoot, { recursive: true, force: true });
  });
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
  // Simulate a fully received upload created by the first production release,
  // when partials still lived below dataRoot. Recovery must find and finalize
  // it after the staging root moved onto the tenant filesystem.
  const legacyRoot = path.join(legacyDataRoot, "resumable-uploads");
  fs.mkdirSync(legacyRoot, { recursive: true, mode: 0o700 });
  if (legacyDataRoot.startsWith("/dev/shm/")) {
    assert.notEqual(fs.statSync(legacyRoot).dev, fs.statSync(instance.resumableUploads.root).dev);
  }
  fs.rmSync(path.join(instance.resumableUploads.root, row.storage_name), { force: true });
  const legacyPartial = path.join(legacyRoot, row.storage_name);
  fs.writeFileSync(legacyPartial, payload, { mode: 0o600 });
  const recovery = await instance.resumableUploads.recover();
  assert.equal(recovery.reconciled, 1);
  assert.equal(recovery.finalized, 1);
  assert.equal(instance.db.getResumableUpload(id)?.state, "completed");
  assert.equal(instance.db.getFile(row.file_id)?.sha256, crypto.createHash("sha256").update(payload).digest("hex"));
  assert.equal(fs.existsSync(legacyPartial), false);

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

// These checks use real kernel ACL enforcement, not a root access() result.
async function permissionFixture(context: test.TestContext) {
  const { spawnSync } = await import("node:child_process");
  const { listTenantIdentities } = await import("../server/tenant-identities.js");
  const identity = listTenantIdentities()[0];
  const other = listTenantIdentities()[1];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-tus-permissions-"));
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "permissions", passwordHash: bcrypt.hashSync(PASSWORD, 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters", queueAutoStart: false, minimumFreeDiskBytes: 1 });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const browser = request.agent(instance.app);
  const login = await browser.post("/api/auth/login").send({ username: "permissions", password: PASSWORD }).expect(200);
  const csrf = login.body.csrfToken;
  const conversation = (await browser.post("/api/conversations").set("X-CSRF-Token", csrf).expect(201)).body.conversation;
  const workspace = path.join(root, "tenants", identity.userId, "conversations", conversation.id);
  fs.chmodSync(root, 0o711);
  fs.chmodSync(path.join(root, "tenants"), 0o711);
  for (const directory of [path.join(root, "tenants", identity.userId), path.dirname(workspace), workspace, path.join(workspace, "uploads")]) {
    assert.equal(spawnSync("setfacl", ["--set", `u::rwx,u:${identity.uid}:rwx,g::---,m::rwx,o::---`, directory]).status, 0);
    assert.equal(spawnSync("setfacl", ["-d", "--set", `u::rwx,u:${identity.uid}:rwx,g::---,m::rwx,o::---`, directory]).status, 0);
  }
  const rootFd = fs.openSync(root, "r");
  context.after(() => fs.closeSync(rootFd));
  const access = (file: string, uid = identity.uid) => spawnSync(process.execPath, ["-e",
    'const fs=require("fs");const f=fs.openSync(process.argv[1],"r+");const b=Buffer.alloc(1);fs.readSync(f,b,0,1,0);fs.closeSync(f);',
    "/proc/self/fd/3/" + path.relative(root, file)], { uid, gid: uid, cwd: "/", env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe", rootFd] });
  const create = async (name = "permission.bin") => {
    const response = await browser.post("/api/uploads").set(TUS_HEADERS).set("X-CSRF-Token", csrf)
      .set("Upload-Length", "4").set("Upload-Metadata", metadata({ filename: name, conversationId: conversation.id })).expect(201);
    const row = instance.db.getResumableUpload(uploadId(response.headers.location))!;
    return { row, location: response.headers.location as string, partial: path.join(instance.resumableUploads.root, row.storage_name), final: path.join(workspace, "uploads", row.final_name) };
  };
  return { root, instance, browser, csrf, conversation, workspace, access, create, other };
}

const permissionTest = { skip: process.platform !== "linux" || process.getuid?.() !== 0 };

test("tus rename grants the ordinary tenant rw, leaves partials private and preserves multipart access", permissionTest, async (context) => {
  const f = await permissionFixture(context);
  const item = await f.create("no-special-extension.dat");
  assert.notEqual(f.access(item.partial).status, 0);
  await f.browser.patch(item.location).set(TUS_HEADERS).set("X-CSRF-Token", f.csrf)
    .set("Upload-Offset", "0").set("Content-Type", "application/offset+octet-stream").send(Buffer.from("data")).expect(204);
  assert.equal(f.access(item.final).status, 0);
  assert.notEqual(f.access(item.final, f.other.uid).status, 0);
  assert.equal(fs.statSync(item.final).mode & 7, 0);
  assert.equal(fs.readFileSync(item.final, "utf8"), "data");
  await Promise.all([f.browser.get(`${item.location}/result`).expect(200), f.browser.head(item.location).set(TUS_HEADERS).expect(200)]);
  assert.equal(f.instance.db.listFiles(f.conversation.id).length, 1);
  const small = await f.browser.post(`/api/conversations/${f.conversation.id}/draft/files`).set("X-CSRF-Token", f.csrf)
    .attach("files", Buffer.from("small"), "small.txt").expect(201);
  const smallPath = path.join(f.workspace, small.body.uploadedFiles[0].relative_path);
  assert.equal(f.access(smallPath).status, 0);
  assert.notEqual(f.access(smallPath, f.other.uid).status, 0);
});

test("tus permission failure stays finalizing; concurrent retries and restart grant access exactly once", permissionTest, async (context) => {
  const f = await permissionFixture(context);
  const item = await f.create();
  const blocked = path.join(f.root, "blocked-bin");
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, "setfacl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = blocked;
    await f.browser.patch(item.location).set(TUS_HEADERS).set("X-CSRF-Token", f.csrf)
      .set("Upload-Offset", "0").set("Content-Type", "application/offset+octet-stream").send(Buffer.from("data")).expect(500);
    assert.equal(f.instance.db.getResumableUpload(item.row.id)?.state, "finalizing");
    assert.equal(f.instance.db.getFile(item.row.file_id), undefined);
    assert.equal(fs.statSync(item.final).mode & 0o777, 0o600);
    assert.notEqual(f.access(item.final).status, 0);
    await Promise.all([f.browser.get(`${item.location}/result`).expect(500), f.browser.head(item.location).set(TUS_HEADERS).expect(500)]);
    assert.equal(f.instance.db.getFile(item.row.file_id), undefined);
  } finally { process.env.PATH = oldPath; }
  // A new service instance models loss of the in-memory completion lock.
  const { ResumableUploadService } = await import("../server/resumable-upload.js");
  const recovery = new ResumableUploadService({ db: f.instance.db, config: f.instance.config,
    availableDiskBytes: () => Number.MAX_SAFE_INTEGER, maximumStoredBytesForUser: () => Number.MAX_SAFE_INTEGER });
  const recovered = await recovery.recover();
  assert.equal(recovered.finalized, 1);
  assert.equal(f.access(item.final).status, 0);
  await Promise.all([f.browser.get(`${item.location}/result`).expect(200), f.browser.head(item.location).set(TUS_HEADERS).expect(200)]);
  assert.equal((await recovery.recover()).finalized, 0);
  assert.equal(f.instance.db.listFiles(f.conversation.id).length, 1);
});

test("tus EXDEV completion grants tenant access and removes private staging", permissionTest, async (context) => {
  const f = await permissionFixture(context);
  const item = await f.create();
  fs.writeFileSync(item.partial, "data");
  // Force the kernel EXDEV path using tmpfs, including the normal retry entry.
  const external = fs.mkdtempSync(path.join("/dev/shm", "tus-permission-"));
  context.after(() => fs.rmSync(external, { recursive: true, force: true }));
  assert.notEqual(fs.statSync(external).dev, fs.statSync(f.root).dev);
  const source = path.join(external, item.row.storage_name);
  fs.copyFileSync(item.partial, source);
  fs.unlinkSync(item.partial);
  const service = f.instance.resumableUploads as unknown as { partialPath: () => string };
  context.mock.method(service, "partialPath", () => source);
  context.mock.method(f.instance.resumableUploads as unknown as { partialPaths: () => string[] }, "partialPaths", () => [source, item.partial]);
  const recovered = await f.instance.resumableUploads.recover();
  assert.equal(recovered.finalized, 1);
  assert.equal(f.access(item.final).status, 0);
  assert.equal(fs.existsSync(source), false);
  assert.notEqual(f.access(item.final, f.other.uid).status, 0);
  assert.equal(fs.statSync(item.final).mode & 7, 0);
  assert.equal(fs.readFileSync(item.final, "utf8"), "data");
  assert.equal(fs.readdirSync(path.dirname(item.final)).some(name => name.endsWith(".tus-finalizing")), false);
});

test("tus recovery rejects symlink files/directories, hardlinks, escaping names and wrong ownership", permissionTest, async (context) => {
  const f = await permissionFixture(context);
  const item = await f.create();
  fs.writeFileSync(item.partial, "data");
  const outside = path.join(f.root, "outside");
  fs.writeFileSync(outside, "safe", { mode: 0o600 });
  const before = fs.statSync(outside).mode;
  fs.symlinkSync(outside, item.final);
  await assert.rejects(f.instance.resumableUploads.recover());
  assert.equal(fs.statSync(outside).mode, before);
  assert.equal(f.instance.db.getFile(item.row.file_id), undefined);
  fs.unlinkSync(item.final);
  fs.linkSync(outside, item.final);
  await assert.rejects(f.instance.resumableUploads.recover());
  assert.equal(fs.statSync(outside).mode, before);
  fs.unlinkSync(item.final);
  const uploads = path.dirname(item.final), moved = uploads + "-moved";
  fs.renameSync(uploads, moved);
  fs.symlinkSync(path.dirname(outside), uploads);
  await assert.rejects(f.instance.resumableUploads.recover());
  fs.unlinkSync(uploads);
  fs.renameSync(moved, uploads);
  f.instance.db.sqlite.prepare("UPDATE resumable_uploads SET final_name='../outside' WHERE id=?").run(item.row.id);
  await assert.rejects(f.instance.resumableUploads.recover());
  f.instance.db.sqlite.prepare("UPDATE resumable_uploads SET final_name=?,storage_name='../outside' WHERE id=?").run(item.row.final_name, item.row.id);
  await assert.rejects(f.instance.resumableUploads.recover());
  const now = new Date().toISOString();
  f.instance.db.createUser({ id: f.other.userId, username: "other", display_name: "Other", password_hash: bcrypt.hashSync(PASSWORD, 8), role: "member", status: "active", created_at: now, updated_at: now });
  f.instance.db.sqlite.prepare("UPDATE resumable_uploads SET storage_name=?,user_id=? WHERE id=?").run(item.row.storage_name, f.other.userId, item.row.id);
  await assert.rejects(f.instance.resumableUploads.recover());
  assert.equal(f.instance.db.getFile(item.row.file_id), undefined);
  assert.equal(fs.readFileSync(outside, "utf8"), "safe");
  assert.equal(fs.statSync(outside).mode, before);
});
