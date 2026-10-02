import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { ReaderTextResources } from "../server/reader-text-resources.js";
import { createApp } from "../server/app.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIpsAAAAASUVORK5CYII=", "base64");
const uri = `data:image/png;base64,${png.toString("base64")}`;

test("text previews omit embedded bytes and retrieve exact images after UTF-8 text", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-text-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "report.html");
  const source = `\uFEFF<h1>中文🌄正文</h1><img src="${uri}"><p>中文之后</p><img src="${uri}">`;
  fs.writeFileSync(file, source);
  const service = new ReaderTextResources();
  let revision = "";
  const content = await service.content(file, (rev, index) => { revision = rev; return `/images/${index}`; });
  assert.equal(content, '<h1>中文🌄正文</h1><img src="/images/0"><p>中文之后</p><img src="/images/1">');
  for (const index of [0, 1]) {
    const image = await service.image(file, revision, index);
    assert.equal(image?.mime, "image/png");
    assert.deepEqual(image?.body, png);
  }
  assert.equal(await service.image(file, revision, 2), null);
  assert.equal(await service.image(file, revision, -1), null);
  assert.equal(await service.image(file, revision, 0.5), null);
  assert.equal(fs.readFileSync(file, "utf8"), source, "download source stays intact");
  fs.writeFileSync(file, source.replace("中文之后", "内容变化"));
  assert.equal(await service.image(file, revision, 0), null, "same-size replacement invalidates old image URLs");
  fs.symlinkSync(file, path.join(root, "link.html"));
  await assert.rejects(service.content(path.join(root, "link.html"), () => ""));
  const large = path.join(root, "large.html");
  fs.closeSync(fs.openSync(large, "w"));
  fs.truncateSync(large, 100 * 1024 * 1024 + 1);
  await assert.rejects(service.content(large, () => ""));
});

test("Markdown embedded images and concurrent readers share the same immutable byte ranges", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-markdown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "report.md");
  fs.writeFileSync(file, `# 正文\n\n![图一](${uri})\n\n![图二](${uri})`);
  const service = new ReaderTextResources();
  const results = await Promise.all(Array.from({ length: 6 }, () => service.content(file, (rev, index) => `/${rev}/${index}`)));
  assert.equal(new Set(results).size, 1);
  assert.ok(results[0].startsWith("# 正文"));
  assert.equal(results[0].includes("base64"), false);
});

test("preview body/images enforce ownership and public images stop working after revocation or expiry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-resource-api-"));
  const dataRoot = path.join(root, "data");
  const instance = createApp({ projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), username: "demo-owner",
    passwordHash: bcrypt.hashSync("Reader-test-password!", 4), sessionSecret: "reader-test-secret-longer-than-thirty-two-characters",
    publicBaseUrl: "https://agent.example.test", queueAutoStart: false });
  t.after(async () => { instance.beginShutdown(); await instance.waitForBackgroundTasks(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "reader fixture");
  const id = crypto.randomUUID();
  const relative = `deliverables/${id}/report.html`;
  const source = `<h1>正文可先阅读</h1><img src="${uri}">`;
  fs.mkdirSync(path.dirname(path.join(dataRoot, relative)), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, relative), source);
  instance.db.addFile({ id, conversation_id: conversation.id, message_id: null, original_name: "report.html", relative_path: relative,
    mime_type: "text/html", size: Buffer.byteLength(source), kind: "output", created_at: new Date().toISOString() });
  const owner = request.agent(instance.app);
  const login = await owner.post("/api/auth/login").send({ username: "demo-owner", password: "Reader-test-password!" }).expect(200);
  const preview = await owner.get(`/api/files/${id}/preview/content`).expect(200);
  assert.match(preview.body.content, /正文可先阅读/);
  assert.doesNotMatch(preview.body.content, /base64/);
  const imageUrl = /src="([^"]+)"/.exec(preview.body.content)![1];
  assert.deepEqual((await owner.get(imageUrl).expect(200)).body, png);
  await request(instance.app).get(imageUrl).expect(401);
  await request(instance.app).get(`/api/files/${id}/preview/content`).expect(401);
  const now = new Date().toISOString();
  instance.db.createUser({ id: crypto.randomUUID(), username: "demo-member", display_name: "Example member", password_hash: bcrypt.hashSync("Other-reader-password!", 4), role: "member", status: "active", created_at: now, updated_at: now });
  const other = request.agent(instance.app);
  await other.post("/api/auth/login").send({ username: "demo-member", password: "Other-reader-password!" }).expect(200);
  await other.get(imageUrl).expect(404);
  await other.get(`/api/files/${id}/preview/content`).expect(404);
  const original = await owner.get(`/api/files/${id}?download=1`).expect(200);
  assert.equal(original.text, source);
  await owner.post(`/api/files/${id}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const shared = await request(instance.app).get(`/api/files/${id}/preview/public`).expect(200);
  assert.doesNotMatch(shared.body.content, /base64/);
  const publicImage = /src="([^"]+)"/.exec(shared.body.content)![1];
  assert.match(publicImage, /\/preview\/public\/images\//);
  assert.deepEqual((await request(instance.app).get(publicImage).expect(200)).body, png);
  await owner.delete(`/api/files/${id}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  await request(instance.app).get(publicImage).expect(404);
  await owner.post(`/api/files/${id}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  instance.db.sqlite.prepare("UPDATE public_file_shares SET expires_at = ? WHERE file_id = ?").run("2000-01-01T00:00:00.000Z", id);
  await request(instance.app).get(publicImage).expect(404);
  await owner.get(imageUrl.replace(/\/0$/, "/999")).expect(404);
});
