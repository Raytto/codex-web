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
if (cmd === "ls") { const dir = args.at(-1); const target = remote(dir); if (!fs.existsSync(target)) process.exit(1); console.log("当前目录: " + dir); process.exit(0); }
if (cmd === "tree") { const dir = args.at(-1); const target = remote(dir); if (!fs.existsSync(target)) process.exit(1); console.log(dir); for (const name of fs.readdirSync(target)) console.log(path.posix.join(dir, name) + " -> " + path.posix.join(dir, name)); process.exit(0); }
if (cmd === "mkdir") { const dir = args.at(-1); fs.mkdirSync(remote(dir), { recursive: true }); console.log(dir); process.exit(0); }
if (cmd === "upload") { const source = args.filter((value) => fs.existsSync(value) && fs.statSync(value).isFile()).at(-1); const dir = args.at(-1); if (!source || !dir) process.exit(2); fs.mkdirSync(remote(dir), { recursive: true }); fs.copyFileSync(source, path.join(remote(dir), path.basename(source))); process.exit(0); }
if (cmd === "download") { const dirArg = args.find((value) => value.startsWith("--saveto=")); const source = args.at(-1); if (!dirArg || !source) process.exit(2); fs.mkdirSync(dirArg.slice(9), { recursive: true }); fs.copyFileSync(remote(source), path.join(dirArg.slice(9), path.basename(source))); process.exit(0); }
process.exit(2);
`);
}

test("archived conversations bypass inactivity and round-trip every unshared registered file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppagent-conversation-cold-storage-"));
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
    .run(projectId, LEGACY_USER_ID, "cold storage", "/example/project", "tenant-local", now, now);
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
  const imageId = crypto.randomUUID();
  const imagePath = path.join(dataRoot, "deliverables", imageId, "chart.png");
  const rolloutPath = path.join(codexHome, "archived_sessions", `rollout-${threadId}.jsonl`);
  for (const file of [uploadPath, htmlPath, runtimePath, rootReportPath, outputPath, sharedPath, imagePath, rolloutPath]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(uploadPath, "user upload");
  fs.writeFileSync(htmlPath, "<html>report</html>");
  fs.writeFileSync(runtimePath, "runtime cache");
  fs.writeFileSync(rootReportPath, "<html>root report</html>");
  fs.writeFileSync(outputPath, "text output");
  fs.writeFileSync(sharedPath, "public share");
  fs.writeFileSync(imagePath, "public image");
  const rolloutHistory = JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "exec" } }) + "\n";
  fs.writeFileSync(rolloutPath, rolloutHistory);

  const rows: FileRow[] = [
    { id: crypto.randomUUID(), conversation_id: conversationId, message_id: null, original_name: "input.txt", relative_path: "uploads/input.txt", mime_type: "text/plain", size: 11, kind: "upload", created_at: now },
    { id: outputId, conversation_id: conversationId, message_id: null, original_name: "report.txt", relative_path: `deliverables/${outputId}/report.txt`, mime_type: "text/plain", size: 11, kind: "output", created_at: now },
    { id: sharedId, conversation_id: conversationId, message_id: null, original_name: "shared.txt", relative_path: `deliverables/${sharedId}/shared.txt`, mime_type: "text/plain", size: 12, kind: "output", created_at: now },
    { id: imageId, conversation_id: conversationId, message_id: null, original_name: "chart.png", relative_path: `deliverables/${imageId}/chart.png`, mime_type: "image/png", size: 12, kind: "output", created_at: now },
  ];
  db.addFiles(rows);
  db.sqlite.prepare("INSERT INTO public_file_shares(id,file_id,user_id,file_name_snapshot,enabled,created_at,enabled_at,expires_at) VALUES(?,?,?,?,1,?,?,?)")
    .run(crypto.randomUUID(), sharedId, LEGACY_USER_ID, "shared.txt", now, now, new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString());
  db.sqlite.prepare("INSERT INTO public_file_share_assets(share_id,asset_file_id,source_ref,created_at) VALUES(?,?,?,?)")
    .run(db.getPublicFileShare(sharedId)!.id, imageId, "chart.png", now);
  const normalId = crypto.randomUUID();
  const normalThreadId = crypto.randomUUID();
  db.createConversation(normalId, "normal old");
  db.sqlite.prepare("UPDATE conversations SET project_id=?,codex_thread_id=?,last_active_at=? WHERE id=?")
    .run(projectId, normalThreadId, new Date(Date.now() - 16 * 24 * 60 * 60_000).toISOString(), normalId);
  const normalRollout = path.join(codexHome, "sessions", `rollout-${normalThreadId}.jsonl`);
  fs.mkdirSync(path.dirname(normalRollout), { recursive: true }); fs.writeFileSync(normalRollout, JSON.stringify({ type: "session_meta", payload: { id: normalThreadId, source: "exec" } }) + "\n");
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
  assert.equal(candidate?.drawing, true);
  assert.equal(candidate?.entries, 6);
  assert.equal(candidate?.reasons.includes("active_within_15_days"), false);
  assert.equal(candidate?.sharedFiles, 2);
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
  let storage = inspection.sqlite.prepare("SELECT state,manifest_json,local_isolated_path FROM conversation_storage WHERE conversation_id=?").get(conversationId) as { state: string; manifest_json: string; local_isolated_path: string };
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

  assert.equal(listColdCandidates(roots).find((item) => item.conversationId === conversationId)?.eligible, false);
  inspection = new AppDatabase(dataRoot, undefined, false);
  // Expiry does not depend on a sweeper deleting the asset mappings.
  inspection.sqlite.prepare("UPDATE public_file_shares SET expires_at=? WHERE file_id=?").run("2000-01-01T00:00:00.000Z", sharedId);
  inspection.close();
  const residual = listColdCandidates(roots).find((item) => item.conversationId === conversationId)!;
  assert.equal(residual.eligible, true, residual.reasons.join(","));
  assert.equal(residual.entries, 2);
  assert.equal(residual.sharedFiles, 0);
  const failUpload = executable(tools, "aliyunpan-fail-upload", `
const { execFileSync } = require("node:child_process"); const args = process.argv.slice(2);
if (args[0] === "upload") process.exit(2);
process.stdout.write(execFileSync(${JSON.stringify(roots.aliyunpan)}, args));
`);
  assert.throws(() => archiveConversation({ ...roots, aliyunpan: failUpload }, conversationId));
  inspection = new AppDatabase(dataRoot, undefined, false);
  const failedStorage = inspection.getConversationStorage(conversationId)!;
  assert.equal(failedStorage.state, "local", "upload failure keeps authoritative local files usable");
  assert.equal(failedStorage.generation, archived.generation, "failed replacement keeps the previous cloud generation recoverable");
  assert.equal(failedStorage.remote_path, archived.remotePath);
  inspection.close();
  assert.equal(fs.readFileSync(uploadPath, "utf8"), "user upload");
  assert.equal(fs.readFileSync(sharedPath, "utf8"), "public share");
  const merged = archiveConversation(roots, conversationId);
  assert.equal(merged.generation, archived.generation + 1);
  assert.equal(fs.existsSync(sharedPath), false);
  assert.equal(fs.existsSync(imagePath), false);
  assert.equal(fs.existsSync(archived.isolatedPath), true, "each prior isolation keeps its own verified grace period even after a new generation succeeds");
  inspection = new AppDatabase(dataRoot, undefined, false);
  storage = inspection.sqlite.prepare("SELECT state,manifest_json,local_isolated_path FROM conversation_storage WHERE conversation_id=?").get(conversationId) as typeof storage;
  assert.equal(JSON.parse(storage.manifest_json).entries.length, 8, "old rollout/files and expired public document/image all survive in the new archive");
  assert.equal(inspection.getConversation(conversationId)!.last_active_at, now, "maintenance restore does not fabricate user activity");
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
  assert.equal(fs.readFileSync(rolloutPath, "utf8"), rolloutHistory);
  assert.equal(fs.readFileSync(sharedPath, "utf8"), "public share");
  assert.equal(fs.readFileSync(imagePath, "utf8"), "public image");
  inspection = new AppDatabase(dataRoot, undefined, false);
  assert.equal((inspection.sqlite.prepare("SELECT state FROM conversation_storage WHERE conversation_id=?").get(conversationId) as { state: string }).state, "local");
  inspection.close();
});

function lineageFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppagent-lineage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = path.join(root, "tools"); fs.mkdirSync(tools);
  const originalPath = process.env.PATH;
  executable(tools, "id", `console.log("0");`);
  process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => { process.env.PATH = originalPath; });
  const dataRoot = path.join(root, "data"), tenantRoot = path.join(root, "tenants");
  const home = path.join(tenantRoot, LEGACY_USER_ID, "codex-home"); fs.mkdirSync(home, { recursive: true });
  const db = new AppDatabase(dataRoot, undefined, false); t.after(() => db.close());
  const now = new Date().toISOString(), conversationId = crypto.randomUUID(), threadId = crypto.randomUUID(), projectId = crypto.randomUUID();
  db.sqlite.prepare("INSERT INTO projects(id,user_id,name,root_path,executor_id,is_default,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?)")
    .run(projectId, LEGACY_USER_ID, "fixture", root, "tenant-local", now, now);
  db.createConversation(conversationId, "lifecycle fixture");
  db.sqlite.prepare("UPDATE conversations SET project_id=?,codex_thread_id=?,archived_at=? WHERE id=?").run(projectId, threadId, now, conversationId);
  const index = new DatabaseSync(path.join(home, "state_5.sqlite")); t.after(() => index.close());
  index.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,source TEXT NOT NULL,archived INTEGER DEFAULT 0,tokens_used INTEGER DEFAULT 0);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE thread_dynamic_tools(thread_id TEXT,position INTEGER,name TEXT,PRIMARY KEY(thread_id,position));
    CREATE TABLE thread_attachments(id TEXT PRIMARY KEY,thread_id TEXT,payload TEXT);
    CREATE TABLE thread_read_receipts(thread_id TEXT PRIMARY KEY NOT NULL,first_unread_turn TEXT,revision TEXT NOT NULL,last_published_turn TEXT);`);
  const addThread = (id: string, parent?: string) => {
    const source = parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/fixture" } } } : "exec";
    const file = path.join(home, "sessions", `rollout-${id}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, source } }) + "\n" + JSON.stringify({ type: "response_item", payload: { fixture: id } }) + "\n");
    index.prepare("INSERT INTO threads(id,rollout_path,source) VALUES(?,?,?)").run(id, file, typeof source === "string" ? source : JSON.stringify(source));
    if (parent) index.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,?)").run(parent, id, "open");
    return file;
  };
  const file = addThread(threadId);
  const recipient = path.join(root, "recipient"), identity = path.join(root, "identity"); fs.writeFileSync(recipient, "fixture"); fs.writeFileSync(identity, "fixture");
  fs.mkdirSync(path.join(root, "cloud", "codex-web", "conversations", LEGACY_USER_ID, conversationId), { recursive: true });
  const roots = defaultColdStorageRoots({ dataRoot, tenantRoot, databasePath: path.join(dataRoot, "codex-web.sqlite"),
    age: fakeAge(tools), aliyunpan: fakeAliyun(tools, path.join(root, "cloud")), ageRecipient: recipient, ageIdentity: identity,
    relayDir: path.join(root, "relay"), downloadDir: path.join(root, "downloads"), isolationRoot: path.join(root, "cold", "isolated"), driveId: "fixture" });
  return { root, tools, db, index, home, conversationId, threadId, projectId, file, addThread, roots };
}

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { collectConversationLineage, mutateThreadIndex, validateRestoredLineage } from "../server/conversation-lineage.js";
import { acquireCodexLifecycleLock, spawnCodexRuntime } from "../server/codex-lifecycle-lock.js";
import { garbageCollectConversationRecords } from "../server/conversation-cold-storage.js";

test("busy Home preserves restore intent without downloads or failure churn, then restores intact", async (t) => {
  const f = lineageFixture(t);
  const before = fs.readFileSync(f.file, "utf8");
  archiveConversation(f.roots, f.conversationId);
  const child = spawnCodexRuntime(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { env: { ...process.env, CODEX_HOME: f.home }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  await new Promise<void>(resolve => child.stdout.once("data", () => resolve()));
  const original = f.roots.aliyunpan;
  f.roots.aliyunpan = "/missing-download-must-not-run";
  assert.throws(() => restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID), /codex_runtime_active/);
  const waiting = f.db.getConversationStorage(f.conversationId)!;
  assert.equal(waiting.state, "restoring"); assert.equal(waiting.last_error, "codex_runtime_active"); assert.equal(waiting.retry_count, 0);
  assert.throws(() => restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID), /codex_runtime_active/);
  assert.equal(f.db.getConversationStorage(f.conversationId)!.revision, waiting.revision, "repeated contention must not churn audit rows");
  assert.equal(fs.existsSync(f.file), false);
  const ended = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill(); await ended;
  f.roots.aliyunpan = original;
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.equal(f.db.getConversationStorage(f.conversationId)!.state, "local");
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

function childGraph(t: test.TestContext) {
  const f = lineageFixture(t), child = crypto.randomUUID(), grandchild = crypto.randomUUID(), unrelated = crypto.randomUUID();
  const childFile = f.addThread(child, f.threadId), grandchildFile = f.addThread(grandchild, child), unrelatedFile = f.addThread(unrelated);
  return { ...f, child, grandchild, childFile, grandchildFile, unrelated, unrelatedFile };
}

test("recursive archive restores indexes/tools/attachments and tombstone GC is scoped and idempotent", (t) => {
  const f = childGraph(t);
  f.index.prepare("INSERT INTO thread_dynamic_tools VALUES(?,?,?)").run(f.child, 0, "fixture_tool");
  f.index.prepare("INSERT INTO thread_attachments VALUES(?,?,?)").run(crypto.randomUUID(), f.grandchild, '{"fixture":true}');
  f.index.prepare("INSERT INTO thread_read_receipts VALUES(?,?,?,?)").run(f.threadId, "turn-1", "revision-1", "turn-2");
  f.index.prepare("INSERT INTO thread_read_receipts VALUES(?,?,?,?)").run(f.unrelated, null, "untouched", null);
  const before = [f.file, f.childFile, f.grandchildFile].map((file) => fs.readFileSync(file, "utf8"));
  const candidate = listColdCandidates(f.roots).find((r) => r.conversationId === f.conversationId)!;
  assert.equal(candidate.eligible, true, candidate.reasons.join(",")); assert.equal(candidate.childRollouts, 2);
  const result = archiveConversation(f.roots, f.conversationId);
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM threads").get()!.n, 1, "cold threads do not retain broken local index paths");
  assert.ok(fs.existsSync(f.unrelatedFile));
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM thread_read_receipts").get()!.n, 1);
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.deepEqual([f.file, f.childFile, f.grandchildFile].map((file) => fs.readFileSync(file, "utf8")), before);
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM thread_spawn_edges").get()!.n, 2);
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM thread_dynamic_tools").get()!.n, 1);
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM thread_attachments").get()!.n, 1);
  assert.equal(f.index.prepare("SELECT revision FROM thread_read_receipts WHERE thread_id=?").get(f.threadId)!.revision, "revision-1");
  assert.equal(f.index.prepare("SELECT revision FROM thread_read_receipts WHERE thread_id=?").get(f.unrelated)!.revision, "untouched");
  assert.throws(() => garbageCollectConversationRecords(f.roots, f.conversationId, LEGACY_USER_ID), /tombstone/);
  f.db.beginConversationDeletion(f.conversationId, LEGACY_USER_ID);
  assert.equal(garbageCollectConversationRecords(f.roots, f.conversationId, LEGACY_USER_ID), 3);
  assert.equal(garbageCollectConversationRecords(f.roots, f.conversationId, LEGACY_USER_ID), 0);
  assert.ok(fs.existsSync(f.unrelatedFile)); assert.ok(!fs.existsSync(result.isolatedPath));
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM threads").get()!.n, 1);
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM thread_read_receipts").get()!.n, 1);
});

test("cold removal detects changed read receipts and leaves the entire index intact", t => {
  const f = lineageFixture(t);
  f.index.prepare("INSERT INTO thread_read_receipts VALUES(?,?,?,?)").run(f.threadId, "turn-1", "revision-1", "turn-2");
  const collected = collectConversationLineage(f.db.sqlite, { conversationId: f.conversationId, userId: LEGACY_USER_ID, executorId: "tenant-local", codexHome: f.home });
  assert.deepEqual(collected.reasons, []);
  f.index.prepare("UPDATE thread_read_receipts SET revision=? WHERE thread_id=?").run("revision-2", f.threadId);
  assert.throws(() => mutateThreadIndex(f.home, collected.lineage!.index, "remove"), /codex_index_changed/);
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM threads").get()!.n, 1);
  assert.equal(f.index.prepare("SELECT revision FROM thread_read_receipts WHERE thread_id=?").get(f.threadId)!.revision, "revision-2");
  f.index.prepare("UPDATE thread_read_receipts SET revision=? WHERE thread_id=?").run("revision-1", f.threadId);
  mutateThreadIndex(f.home, collected.lineage!.index, "remove");
  mutateThreadIndex(f.home, collected.lineage!.index, "remove");
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM thread_read_receipts").get()!.n, 0);
  mutateThreadIndex(f.home, collected.lineage!.index, "restore");
  assert.equal(f.index.prepare("SELECT revision FROM thread_read_receipts WHERE thread_id=?").get(f.threadId)!.revision, "revision-1");
});

test("cold parents merge newly discovered descendants without manual warm-up and keep the old generation on failure", (t) => {
  const f = lineageFixture(t);
  const original = archiveConversation(f.roots, f.conversationId);
  const child = crypto.randomUUID(), childFile = f.addThread(child, f.threadId);
  assert.equal(listColdCandidates(f.roots).find((r) => r.conversationId === f.conversationId)!.childRollouts, 1);
  const fail = executable(f.tools, "fail-upload", `const {execFileSync}=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='upload')process.exit(1);process.stdout.write(execFileSync(${JSON.stringify(f.roots.aliyunpan)},a));`);
  assert.throws(() => archiveConversation({ ...f.roots, aliyunpan: fail }, f.conversationId));
  assert.equal(f.db.getConversationStorage(f.conversationId)!.generation, original.generation);
  assert.ok(fs.existsSync(childFile)); assert.ok(fs.existsSync(f.file));
  const merged = archiveConversation(f.roots, f.conversationId);
  assert.equal(merged.generation, original.generation + 1);
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.ok(fs.existsSync(childFile));
  assert.equal(f.index.prepare("SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id=?").get(child)!.parent_thread_id, f.threadId);
});

test("conflicting parents, cycles, shared references and missing descendants fail closed", (t) => {
  const f = childGraph(t);
  const candidate = () => listColdCandidates(f.roots).find((r) => r.conversationId === f.conversationId)!;
  f.index.prepare("UPDATE thread_spawn_edges SET parent_thread_id=? WHERE child_thread_id=?").run(f.unrelated, f.child);
  assert.ok(candidate().reasons.includes("lineage_parent_conflict"));
  f.index.prepare("UPDATE thread_spawn_edges SET parent_thread_id=? WHERE child_thread_id=?").run(f.threadId, f.child);
  f.index.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,?)").run(f.grandchild, f.threadId, "open");
  assert.ok(candidate().reasons.includes("lineage_cycle"));
  f.index.prepare("DELETE FROM thread_spawn_edges WHERE child_thread_id=?").run(f.threadId);
  const other = crypto.randomUUID(); f.db.createConversation(other, "shared child");
  f.db.sqlite.prepare("UPDATE conversations SET codex_thread_id=? WHERE id=?").run(f.child, other);
  // Put the reference in another project but on the same account/executor.
  f.db.sqlite.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(f.projectId, other);
  assert.ok(candidate().reasons.includes("shared_codex_thread"));
  f.db.sqlite.prepare("DELETE FROM conversations WHERE id=?").run(other);
  fs.unlinkSync(f.grandchildFile);
  assert.ok(candidate().reasons.includes("lineage_rollout_missing"));
  assert.throws(() => archiveConversation(f.roots, f.conversationId), /lineage_rollout_missing/);
  assert.ok(fs.existsSync(f.file));
});

test("same UUID in another account or remote executor does not claim local records; historical segments do", (t) => {
  const f = lineageFixture(t), remote = crypto.randomUUID(), otherUser = crypto.randomUUID(), other = crypto.randomUUID();
  const now = new Date().toISOString();
  f.db.sqlite.prepare("INSERT INTO users(id,username,display_name,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(otherUser, "fixture", "fixture", "fixture", "member", "active", now, now);
  f.db.createConversation(other, "other scope", otherUser);
  f.db.sqlite.prepare("UPDATE conversations SET codex_thread_id=? WHERE id=?").run(f.threadId, other);
  const remoteProject = crypto.randomUUID();
  f.db.sqlite.prepare("INSERT INTO projects(id,user_id,name,root_path,executor_id,is_default,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?)").run(remoteProject, LEGACY_USER_ID, "remote", "remote", "remote:fixture", now, now);
  f.db.createConversation(remote, "remote"); f.db.sqlite.prepare("UPDATE conversations SET project_id=?,codex_thread_id=? WHERE id=?").run(remoteProject, f.threadId, remote);
  const old = crypto.randomUUID(); f.addThread(old);
  f.db.sqlite.exec("CREATE TABLE conversation_thread_segments(conversation_id TEXT,codex_thread_id TEXT)");
  f.db.sqlite.prepare("INSERT INTO conversation_thread_segments VALUES(?,?)").run(f.conversationId, old);
  const result = listColdCandidates(f.roots).find((r) => r.conversationId === f.conversationId)!;
  assert.equal(result.eligible, true, result.reasons.join(",")); assert.equal(result.lineageThreads, 2);
});

test("runtime lease blocks archive even with an idle parent and launches wait for exclusive maintenance", async (t) => {
  const f = childGraph(t);
  const child = spawnCodexRuntime(process.execPath, ["-e", "process.stdout.write('ready');process.stdin.resume()"], { env: { ...process.env, CODEX_HOME: f.home }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  assert.throws(() => archiveConversation(f.roots, f.conversationId), /codex_runtime_active/);
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve())); child.kill(); await ended;
  const release = acquireCodexLifecycleLock(f.home);
  const next = spawnCodexRuntime(process.execPath, ["-e", "process.stdout.write('ready')"], { env: { ...process.env, CODEX_HOME: f.home }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; next.stdout.on("data", (b) => { output += b; });
  await new Promise<void>((resolve) => setTimeout(resolve, 50)); assert.equal(output, "");
  const nextEnded = new Promise<void>((resolve) => next.once("exit", () => resolve())); release(); await nextEnded; assert.equal(output, "ready");
});

test("a changed rollout or new child during upload is retained and not silently evicted", (t) => {
  const f = lineageFixture(t);
  const mutate = executable(f.tools, "mutating-upload", `const fs=require('node:fs');const {execFileSync}=require('node:child_process');const a=process.argv.slice(2);process.stdout.write(execFileSync(${JSON.stringify(f.roots.aliyunpan)},a));if(a[0]==='upload')fs.appendFileSync(${JSON.stringify(f.file)},'new data\\n');`);
  assert.throws(() => archiveConversation({ ...f.roots, aliyunpan: mutate }, f.conversationId), /文件已变化|snapshot/);
  assert.ok(fs.readFileSync(f.file, "utf8").endsWith("new data\n"));
  assert.equal(f.index.prepare("SELECT count(*) AS n FROM threads").get()!.n, 1);
});

test("a restore index collision keeps the conversation unavailable and preserves the conflicting row", (t) => {
  const f = lineageFixture(t); archiveConversation(f.roots, f.conversationId);
  f.index.prepare("INSERT INTO threads(id,rollout_path,source,tokens_used) VALUES(?,?,?,?)").run(f.threadId, f.file, "exec", 999);
  assert.throws(() => restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID), /index_restore_conflict/);
  assert.equal(f.db.getConversationStorage(f.conversationId)!.state, "error");
  assert.equal(f.index.prepare("SELECT tokens_used FROM threads WHERE id=?").get(f.threadId)!.tokens_used, 999);
  f.index.prepare("DELETE FROM threads WHERE id=?").run(f.threadId);
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.equal(f.db.getConversationStorage(f.conversationId)!.state, "local");
});

test("legacy v1/v2 archives restore and interrupted eviction resumes using a stale-owner lock", (t) => {
  const f = childGraph(t);
  archiveConversation(f.roots, f.conversationId);
  const storage = f.db.getConversationStorage(f.conversationId)!;
  const original = JSON.parse(storage.manifest_json!) as ColdManifest;
  const cloudFile = path.join(f.root, "cloud", storage.remote_path!);
  // Existing v1/v2 kept their native indexes. Reproduce that exact shape.
  mutateThreadIndex(f.home, original.lineage!.index, "restore");
  for (const format of ["conversation-cold-storage-v1", "conversation-cold-storage-v2"] as const) {
    const unpack = path.join(f.root, `unpack-${format}`); fs.mkdirSync(unpack);
    execFileSync("tar", ["-xf", cloudFile, "-C", unpack]);
    const legacy: ColdManifest = { ...original, format }; delete legacy.lineage;
    const text = JSON.stringify(legacy); fs.writeFileSync(path.join(unpack, "manifest.json"), text);
    execFileSync("tar", ["-cf", cloudFile, "-C", unpack, "."]);
    f.db.sqlite.prepare("UPDATE conversation_storage SET state='evicting',manifest_json=?,manifest_sha256=?,archive_sha256=?,archive_bytes=? WHERE conversation_id=?")
      .run(text, crypto.createHash("sha256").update(text).digest("hex"), crypto.createHash("sha256").update(fs.readFileSync(cloudFile)).digest("hex"), fs.statSync(cloudFile).size, f.conversationId);
    const lock = path.join(path.dirname(f.roots.isolationRoot), "locks", f.conversationId); fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "2147483647\n2000-01-01\n");
    restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
    assert.ok(fs.existsSync(f.childFile)); assert.equal(f.db.getConversationStorage(f.conversationId)!.state, "local");
    for (const file of [f.file, f.childFile, f.grandchildFile]) fs.unlinkSync(file);
  }
});

test("new child during upload aborts the old snapshot and a retry captures it", (t) => {
  const f = lineageFixture(t), child = crypto.randomUUID();
  const file = path.join(f.home, "sessions", `rollout-${child}.jsonl`);
  const meta = JSON.stringify({ type: "session_meta", payload: { id: child, source: { subagent: { thread_spawn: { parent_thread_id: f.threadId } } } } }) + "\n";
  const mutate = executable(f.tools, "new-child-upload", `const fs=require('node:fs');const {execFileSync}=require('node:child_process');const a=process.argv.slice(2);process.stdout.write(execFileSync(${JSON.stringify(f.roots.aliyunpan)},a));if(a[0]==='upload')fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(meta)});`);
  assert.throws(() => archiveConversation({ ...f.roots, aliyunpan: mutate }, f.conversationId), /lineage_snapshot_changed/);
  assert.equal(f.db.getConversationStorage(f.conversationId)!.generation, 0);
  assert.ok(fs.existsSync(file)); assert.ok(fs.existsSync(f.file));
  archiveConversation(f.roots, f.conversationId);
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.equal(fs.readFileSync(file, "utf8"), meta);
});

test("partial final GC retries descendants from its durable receipt", (t) => {
  const f = childGraph(t); f.db.beginConversationDeletion(f.conversationId, LEGACY_USER_ID);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => { if (file === f.childFile) throw new Error("fixture unlink failure"); unlink(file); };
  try { assert.throws(() => garbageCollectConversationRecords(f.roots, f.conversationId, LEGACY_USER_ID), /fixture unlink/); }
  finally { fs.unlinkSync = unlink; }
  garbageCollectConversationRecords(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.ok(!fs.existsSync(f.grandchildFile)); assert.ok(fs.existsSync(f.unrelatedFile));
});

test("damaged metadata, unknown recovery material and restore symlinks are retained", (t) => {
  const f = lineageFixture(t);
  const bad = path.join(f.home, "sessions", "damaged.jsonl"); fs.writeFileSync(bad, "broken");
  assert.ok(listColdCandidates(f.roots).find((r) => r.conversationId === f.conversationId)!.reasons.includes("unclassified_session_material"));
  fs.unlinkSync(bad);
  f.index.exec("CREATE TABLE future_material(owner_id TEXT REFERENCES threads(id),data TEXT)");
  f.index.prepare("INSERT INTO future_material VALUES(?,?)").run(f.threadId, "required recovery data");
  assert.ok(listColdCandidates(f.roots).find((r) => r.conversationId === f.conversationId)!.reasons.includes("unsupported_thread_index_material"));
  f.index.exec("DROP TABLE future_material");
  archiveConversation(f.roots, f.conversationId);
  fs.rmdirSync(path.join(f.home, "sessions"));
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(f.home, "sessions"));
  assert.throws(() => restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(f.home, "sessions"));
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.ok(fs.existsSync(f.file));
});

test("tenant container paths survive recursive v3 archive/restore and another archive after resume", (t) => {
  const f = childGraph(t);
  const files = [f.file, f.childFile, f.grandchildFile];
  const containerHome = `/app/tenants/${LEGACY_USER_ID}/codex-home`;
  for (const file of files) f.index.prepare("UPDATE threads SET rollout_path=? WHERE rollout_path=?")
    .run(`${containerHome}/${path.relative(f.home, file)}`, file);
  const before = f.index.prepare("SELECT * FROM threads ORDER BY id").all();
  archiveConversation(f.roots, f.conversationId);
  const manifest = JSON.parse(f.db.getConversationStorage(f.conversationId)!.manifest_json!) as ColdManifest;
  assert.equal(manifest.format, COLD_STORAGE_FORMAT);
  assert.ok(manifest.lineage!.index.tables.threads.every((row) => String(row.rollout_path).startsWith(`${containerHome}/`)));
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.deepEqual(f.index.prepare("SELECT * FROM threads ORDER BY id").all(), before);
  // Model the container mount without creating an alias in the host filesystem.
  for (const row of manifest.lineage!.index.tables.threads) {
    const file = path.join(f.home, String(row.rollout_path).slice(containerHome.length + 1));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]).payload.id, row.id);
    fs.appendFileSync(file, JSON.stringify({ type: "response_item", payload: { resumed: row.id } }) + "\n");
  }
  archiveConversation(f.roots, f.conversationId);
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  for (const file of files) assert.match(fs.readFileSync(file, "utf8"), /resumed/);
  assert.ok(fs.existsSync(f.unrelatedFile));
});

test("tenant aliases reject cross-account, external, traversal, wrong relative path and executor claims", (t) => {
  const f = childGraph(t), relative = path.relative(f.home, f.file);
  const containerHome = `/app/tenants/${LEGACY_USER_ID}/codex-home`;
  const candidate = () => listColdCandidates(f.roots).find((r) => r.conversationId === f.conversationId)!;
  for (const bad of [
    `/app/tenants/${crypto.randomUUID()}/codex-home/${relative}`,
    `/outside/${relative}`, `${containerHome}/../codex-home/${relative}`,
    `${containerHome}//${relative}`, `${containerHome}/sessions/wrong/${path.basename(f.file)}`,
    `${f.home}/sessions/wrong/${path.basename(f.file)}`,
    `/home/cww/.codex/sessions/wrong/${path.basename(f.file)}`,
  ]) {
    f.index.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(bad, f.threadId);
    assert.ok(candidate().reasons.includes("lineage_index_path_conflict"), bad);
    assert.throws(() => archiveConversation(f.roots, f.conversationId), /lineage_index_path_conflict/);
    assert.ok(fs.existsSync(f.file));
  }
  f.index.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(`${containerHome}/${relative}`, f.threadId);
  assert.equal(candidate().eligible, true);
  const scope = { conversationId: f.conversationId, userId: LEGACY_USER_ID, executorId: "local-host", codexHome: f.home };
  const refs = new Map([[f.threadId, new Set([f.conversationId])]]);
  assert.ok(collectConversationLineage(f.db.sqlite, scope, [], undefined, refs).reasons.includes("lineage_index_path_conflict"));
  const duplicate = path.join(f.home, "sessions", "duplicate.jsonl"); fs.copyFileSync(f.file, duplicate);
  assert.ok(candidate().reasons.includes("lineage_duplicate_rollout")); fs.unlinkSync(duplicate);
  fs.linkSync(f.file, path.join(f.root, "shared.jsonl"));
  assert.ok(candidate().reasons.includes("rollout_shared_inode")); fs.unlinkSync(path.join(f.root, "shared.jsonl"));
  fs.renameSync(f.file, path.join(f.root, "outside.jsonl")); fs.symlinkSync(path.join(f.root, "outside.jsonl"), f.file);
  assert.ok(candidate().reasons.some((reason) => reason.includes("rollout_not_regular")));
});

test("restore revalidates tenant execution paths; old v3 native and legacy shared-Home snapshots remain supported", (t) => {
  const f = childGraph(t);
  f.index.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(`/home/cww/.codex/${path.relative(f.home, f.file)}`, f.threadId);
  archiveConversation(f.roots, f.conversationId);
  restoreColdConversation(f.roots, f.conversationId, LEGACY_USER_ID);
  assert.equal(f.index.prepare("SELECT rollout_path FROM threads WHERE id=?").get(f.threadId)!.rollout_path, f.file);
  const lineage = JSON.parse(f.db.getConversationStorage(f.conversationId)!.manifest_json!).lineage;
  validateRestoredLineage(f.home, lineage);
  const row = lineage.index.tables.threads.find((r: { id: string }) => r.id === f.child);
  row.rollout_path = `/app/tenants/${LEGACY_USER_ID}/codex-home/${path.relative(f.home, f.childFile)}`;
  validateRestoredLineage(f.home, lineage);
  row.rollout_path = `/app/tenants/${crypto.randomUUID()}/codex-home/${path.relative(f.home, f.childFile)}`;
  assert.throws(() => validateRestoredLineage(f.home, lineage), /lineage_index_path_conflict/);
});
