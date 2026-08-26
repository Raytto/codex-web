import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID, type FileRow } from "../server/db.js";
import {
  archiveConversation,
  COLD_STORAGE_FORMAT,
  defaultColdStorageRoots,
  listColdCandidates,
  purgeColdIsolated,
  restoreColdConversation,
  type ColdManifest,
} from "../server/conversation-cold-storage.js";

function executable(root: string, name: string, source: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function fakeAge(root: string): string {
  return executable(root, "age", `
const fs = require("node:fs"); const args = process.argv.slice(2); const source = args.at(-1); const outputIndex = args.indexOf("-o");
if (!source) process.exit(2);
if (outputIndex >= 0) { const output = args[outputIndex + 1]; if (!output) process.exit(2); fs.copyFileSync(source, output); }
else { process.stdout.write(fs.readFileSync(source)); }
`);
}

function fakeAliyun(root: string, cloud: string): string {
  return executable(root, "aliyunpan", `
const fs = require("node:fs"); const path = require("node:path"); const args = process.argv.slice(2); const cloud = ${JSON.stringify(cloud)}; const cmd = args[0];
const remote = (value) => path.join(cloud, String(value).replace(/^\\/+/, ""));
if (cmd === "tree") { const dir = args.at(-1); const target = remote(dir); if (!fs.existsSync(target)) process.exit(1); console.log(dir); for (const name of fs.readdirSync(target)) console.log(path.posix.join(dir, name) + " -> " + path.posix.join(dir, name)); process.exit(0); }
if (cmd === "mkdir") { const dir = args.at(-1); fs.mkdirSync(remote(dir), { recursive: true }); console.log(dir); process.exit(0); }
if (cmd === "upload") { const source = args.filter((value) => fs.existsSync(value) && fs.statSync(value).isFile()).at(-1); const dir = args.at(-1); if (!source || !dir) process.exit(2); fs.mkdirSync(remote(dir), { recursive: true }); fs.copyFileSync(source, path.join(remote(dir), path.basename(source))); process.exit(0); }
if (cmd === "download") { const dirArg = args.find((value) => value.startsWith("--saveto=")); const source = args.at(-1); if (!dirArg || !source) process.exit(2); fs.mkdirSync(dirArg.slice(9), { recursive: true }); fs.copyFileSync(remote(source), path.join(dirArg.slice(9), path.basename(source))); process.exit(0); }
process.exit(2);
`);
}

test("archived conversations bypass inactivity and round-trip every unshared registered file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-conversation-cold-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const tools = path.join(root, "tools");
  const cloud = path.join(root, "cloud");
  fs.mkdirSync(tools, { recursive: true }); fs.mkdirSync(cloud, { recursive: true });
  const originalPath = process.env.PATH;
  executable(tools, "id", `console.log("0");`);
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => { process.env.PATH = originalPath; });

  const ageRecipient = path.join(root, "recipient");
  const ageIdentity = path.join(root, "identity");
  fs.writeFileSync(ageRecipient, "recipient"); fs.writeFileSync(ageIdentity, "identity");

  const conversationId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = new AppDatabase(dataRoot, undefined, false);
  const projectId = crypto.randomUUID();
  db.sqlite.prepare("INSERT INTO projects(id,user_id,name,root_path,executor_id,is_default,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?)")
    .run(projectId, LEGACY_USER_ID, "cold storage", "/tmp/codex-web-test", "local-host", now, now);
  db.createConversation(conversationId, "archived files");
  db.sqlite.prepare("UPDATE conversations SET project_id=?,codex_thread_id=?,archived_at=?,last_active_at=? WHERE id=?")
    .run(projectId, threadId, now, now, conversationId);

  const workspace = path.join(tenantRoot, LEGACY_USER_ID, "conversations", conversationId);
  const codexHome = path.join(tenantRoot, LEGACY_USER_ID, "codex-home");
  const uploadPath = path.join(workspace, "uploads", "input.txt");
  const htmlPath = path.join(workspace, "outputs", "report.html");
  const runtimeRelative = `.runtime/jobs/${crypto.randomUUID()}/cache.bin`;
  const runtimePath = path.join(workspace, ...runtimeRelative.split("/"));
  const rootReportPath = path.join(workspace, "report.html");
  const outputId = crypto.randomUUID();
  const outputPath = path.join(dataRoot, "deliverables", outputId, "report.txt");
  const sharedId = crypto.randomUUID();
  const sharedPath = path.join(dataRoot, "deliverables", sharedId, "shared.txt");
  const rolloutPath = path.join(codexHome, "archived_sessions", `rollout-${threadId}.jsonl`);
  for (const file of [uploadPath, htmlPath, runtimePath, rootReportPath, outputPath, sharedPath, rolloutPath]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(uploadPath, "user upload");
  fs.writeFileSync(htmlPath, "<html>report</html>");
  fs.writeFileSync(runtimePath, "runtime cache");
  fs.writeFileSync(rootReportPath, "<html>root report</html>");
  fs.writeFileSync(outputPath, "text output");
  fs.writeFileSync(sharedPath, "public share");
  fs.writeFileSync(rolloutPath, "rollout history");

  const rows: FileRow[] = [
    { id: crypto.randomUUID(), conversation_id: conversationId, message_id: null, original_name: "input.txt", relative_path: "uploads/input.txt", mime_type: "text/plain", size: 11, kind: "upload", created_at: now },
    { id: outputId, conversation_id: conversationId, message_id: null, original_name: "report.txt", relative_path: `deliverables/${outputId}/report.txt`, mime_type: "text/plain", size: 11, kind: "output", created_at: now },
    { id: sharedId, conversation_id: conversationId, message_id: null, original_name: "shared.txt", relative_path: `deliverables/${sharedId}/shared.txt`, mime_type: "text/plain", size: 12, kind: "output", created_at: now },
  ];
  db.addFiles(rows);
  db.sqlite.prepare("INSERT INTO public_file_shares(id,file_id,user_id,file_name_snapshot,enabled,created_at,enabled_at) VALUES(?,?,?,?,1,?,?)")
    .run(crypto.randomUUID(), sharedId, LEGACY_USER_ID, "shared.txt", now, now);
  const normalId = crypto.randomUUID();
  const normalThreadId = crypto.randomUUID();
  db.createConversation(normalId, "normal old");
  db.sqlite.prepare("UPDATE conversations SET project_id=?,codex_thread_id=?,last_active_at=? WHERE id=?")
    .run(projectId, normalThreadId, new Date(Date.now() - 16 * 24 * 60 * 60_000).toISOString(), normalId);
  const normalRollout = path.join(codexHome, "sessions", `rollout-${normalThreadId}.jsonl`);
  fs.mkdirSync(path.dirname(normalRollout), { recursive: true }); fs.writeFileSync(normalRollout, "normal rollout");
  db.close();

  const roots = defaultColdStorageRoots({
    dataRoot, tenantRoot, databasePath: path.join(dataRoot, "codex-web.sqlite"),
    age: fakeAge(tools), aliyunpan: fakeAliyun(tools, cloud), ageRecipient, ageIdentity,
    relayDir: path.join(root, "relay"), downloadDir: path.join(root, "downloads"),
    isolationRoot: path.join(root, "isolated"), driveId: "test-drive",
  });

  const candidate = listColdCandidates(roots).find((item) => item.conversationId === conversationId);
  assert.equal(candidate?.archived, true);
  assert.equal(candidate?.eligible, true, candidate?.reasons.join(","));
  assert.equal(candidate?.drawing, false);
  assert.equal(candidate?.entries, 6);
  assert.equal(candidate?.reasons.includes("active_within_15_days"), false);
  assert.equal(candidate?.sharedFiles, 1);
  const normalCandidate = listColdCandidates(roots).find((item) => item.conversationId === normalId);
  assert.equal(normalCandidate?.eligible, true);
  assert.equal(normalCandidate?.drawing, false);
  assert.equal(normalCandidate?.reasons.includes("not_drawing_conversation"), false);

  const archived = archiveConversation(roots, conversationId);
  assert.equal(fs.existsSync(uploadPath), false);
  assert.equal(fs.existsSync(htmlPath), false);
  assert.equal(fs.existsSync(runtimePath), false);
  assert.equal(fs.existsSync(rootReportPath), false);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(rolloutPath), false);
  assert.equal(fs.readFileSync(sharedPath, "utf8"), "public share");
  assert.equal(fs.existsSync(archived.isolatedPath), true);

  let inspection = new AppDatabase(dataRoot, undefined, false);
  const storage = inspection.sqlite.prepare("SELECT state,manifest_json,local_isolated_path FROM conversation_storage WHERE conversation_id=?").get(conversationId) as { state: string; manifest_json: string; local_isolated_path: string };
  assert.equal(storage.state, "cold");
  const manifest = JSON.parse(storage.manifest_json) as ColdManifest;
  assert.equal(manifest.format, COLD_STORAGE_FORMAT);
  assert.deepEqual(manifest.entries.map((entry) => `${entry.kind}:${entry.root}`).sort(), [
    "file:conversation", "file:conversation", "file:conversation", "file:conversation",
    "file:dataRoot", "rollout:codexHome",
  ]);
  assert.deepEqual(manifest.entries.filter((entry) => entry.root === "conversation").map((entry) => entry.relativePath).sort(), [
    runtimeRelative,
    "outputs/report.html",
    "report.html",
    "uploads/input.txt",
  ]);
  inspection.close();

  assert.deepEqual(purgeColdIsolated(roots, 7), []);
  assert.equal(fs.existsSync(storage.local_isolated_path), true);
  inspection = new AppDatabase(dataRoot, undefined, false);
  inspection.sqlite.prepare("UPDATE conversation_storage SET updated_at=? WHERE conversation_id=?")
    .run(new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(), conversationId);
  inspection.close();
  assert.equal(purgeColdIsolated(roots, 7)[0]?.deleted, true);
  assert.equal(fs.existsSync(storage.local_isolated_path), false);

  restoreColdConversation(roots, conversationId, LEGACY_USER_ID);
  assert.equal(fs.readFileSync(uploadPath, "utf8"), "user upload");
  assert.equal(fs.readFileSync(htmlPath, "utf8"), "<html>report</html>");
  assert.equal(fs.readFileSync(runtimePath, "utf8"), "runtime cache");
  assert.equal(fs.readFileSync(rootReportPath, "utf8"), "<html>root report</html>");
  assert.equal(fs.readFileSync(outputPath, "utf8"), "text output");
  assert.equal(fs.readFileSync(rolloutPath, "utf8"), "rollout history");
  assert.equal(fs.readFileSync(sharedPath, "utf8"), "public share");
  inspection = new AppDatabase(dataRoot, undefined, false);
  assert.equal((inspection.sqlite.prepare("SELECT state FROM conversation_storage WHERE conversation_id=?").get(conversationId) as { state: string }).state, "local");
  inspection.close();
});
