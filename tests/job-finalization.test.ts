import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, type JobFinalizationPayload } from "../server/db.js";
import { cleanupFinalizationDirectory, prepareFinalizationFiles, prepareJobFinalization, recoverPreparedFinalization, rollbackUncommittedFinalization, sweepFinalizationOrphans } from "../server/job-finalization.js";
import { snapshotDeliverables } from "../server/paths.js";

test("invalid web output preserves the answer, audio and safe attachment with durable warning across recovery", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-partial-delivery-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), db = new AppDatabase(data); context.after(() => db.close());
  const conversation = db.createConversation(crypto.randomUUID(), "delivery");
  const job = db.createJob(crypto.randomUUID(), conversation.id); db.updateJob(job.id, "running");
  const message = { id: crypto.randomUUID(), conversation_id: conversation.id, role: "assistant" as const, content: "四版音频已生成。", created_at: new Date().toISOString() };
  const bad = '<!doctype html><title>试听</title><audio src="data:audio/mpeg;base64,SUQz"></audio><a href="https://example.test/docs">来源</a>';
  const good = '<!doctype html><button onclick="this.textContent=1">点击</button>';
  const contents = new Map([
    ["audition.html", bad], ["audition.html.pp-agent.json", JSON.stringify({ presentation_mode: "web", sha256: crypto.createHash("sha256").update(bad).digest("hex") })],
    ["sample.mp3", "ID3sample"], ["good.html", good], ["good.html.pp-agent.json", JSON.stringify({ presentation_mode: "web", sha256: crypto.createHash("sha256").update(good).digest("hex") })],
  ]);
  const sources = [...contents].map(([name, content]) => {
    const id = crypto.randomUUID(), sourcePath = path.join(root, id); fs.writeFileSync(sourcePath, content);
    return { row: { id, conversation_id: conversation.id, message_id: message.id, original_name: name, relative_path: `deliverables/${id}/${name}`, mime_type: name.endsWith(".html") ? "text/html" : "audio/mpeg", size: Buffer.byteLength(content), kind: "output" as const, created_at: message.created_at }, sourcePath };
  });
  db.stageJobFinalization(job.id, { message, files: sources.map(s => s.row) });
  const ready = await prepareJobFinalization(data, job.id, message, sources);
  assert.match(ready.message.content, /四版音频已生成。/); assert.match(ready.message.content, /audition.html.*页内导航/);
  assert.match(ready.message.content, /普通附件.*脚本不会运行/);
  db.markJobFilesReady(job.id, ready);
  const recovered = await recoverPreparedFinalization(data, job.id, JSON.parse(db.getJob(job.id)!.finalization_payload!)); assert.ok(recovered);
  db.finalizeJob(job.id, conversation.id, recovered); db.finalizeJob(job.id, conversation.id, recovered); db.publishJobFinalization(job.id);
  assert.equal(db.getJob(job.id)?.status, "completed"); assert.equal(db.getConversation(conversation.id)?.status, "idle");
  const files = db.listFiles(conversation.id); assert.equal(files.length, 3);
  const fallback = files.find(f => f.original_name === "audition.html")!;
  assert.equal(fallback.presentation_mode, "reader"); assert.equal(fallback.presentation_manifest, null);
  assert.equal(fs.readFileSync(path.join(data, fallback.relative_path), "utf8"), bad);
  assert.equal(files.find(f => f.original_name === "good.html")!.presentation_mode, "web");
  assert.equal(fs.readFileSync(path.join(data, files.find(f => f.original_name === "sample.mp3")!.relative_path), "utf8"), "ID3sample");
  assert.equal(db.listMessages(conversation.id).length, 1); assert.equal(db.listMessages(conversation.id)[0].content, ready.message.content);
});

test("malformed or unmatched declarations cannot discard other results or grant execution", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-bad-declaration-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = '<button onclick="alert(1)">test</button>';
  const valid = JSON.stringify({ presentation_mode: "web", sha256: crypto.createHash("sha256").update(body).digest("hex") });
  for (const declarations of [["{"], ["x".repeat(4097)], [valid, valid], [JSON.stringify({ presentation_mode: { toString: 1 }, sha256: "0".repeat(64) })]]) {
    const sources = [["demo.html", body], ...declarations.map(text => ["demo.html.pp-agent.json", text])].map(([name, text]) => {
      const id = crypto.randomUUID(), sourcePath = path.join(root, id); fs.writeFileSync(sourcePath, text);
      return { row: { id, conversation_id: crypto.randomUUID(), message_id: null, original_name: name, relative_path: `deliverables/${id}/${name}`, mime_type: "text/html", size: Buffer.byteLength(text), kind: "output" as const, created_at: new Date().toISOString() }, sourcePath };
    });
    const result = await prepareFinalizationFiles(root, crypto.randomUUID(), sources);
    assert.equal(result.files.length, 1); assert.equal(result.files[0].presentation_mode, "reader"); assert.equal(result.files[0].presentation_manifest, null);
    assert.equal(result.warnings.length, 1);
    const orphan = await prepareFinalizationFiles(root, crypto.randomUUID(), sources.slice(1, 2));
    assert.equal(orphan.files.length, 0); assert.equal(orphan.warnings.length, 1);
  }
});

test("transport and disk failures still abort finalization instead of being hidden as presentation warnings", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-delivery-integrity-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function source(name: string, text: string) {
    const id = crypto.randomUUID(), sourcePath = path.join(root, id); fs.writeFileSync(sourcePath, text);
    return { row: { id, conversation_id: crypto.randomUUID(), message_id: null, original_name: name, relative_path: `deliverables/${id}/${name}`, mime_type: "text/html", size: Buffer.byteLength(text), kind: "output" as const, created_at: new Date().toISOString() }, sourcePath, expectedSha256: crypto.createHash("sha256").update(text).digest("hex") };
  }
  const html = source("demo.html", "<title>demo</title>"), sidecar = source("demo.html.pp-agent.json", "{}");
  sidecar.expectedSha256 = "0".repeat(64);
  await assert.rejects(prepareFinalizationFiles(root, crypto.randomUUID(), [html, sidecar]), /回传校验失败/);
  const missing = source("missing.html", "test"); fs.unlinkSync(missing.sourcePath);
  await assert.rejects(prepareFinalizationFiles(root, crypto.randomUUID(), [missing]), /ENOENT/);
  const truncated = source("truncated.mp3", "audio"); truncated.row.size++;
  await assert.rejects(prepareFinalizationFiles(root, crypto.randomUUID(), [truncated]), /size mismatch/);
});

test("managed web declaration survives output collection, recovery journal and atomic database commit", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-web-finalization-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new AppDatabase(path.join(root, "data")); context.after(() => db.close());
  const conversation = db.createConversation(crypto.randomUUID(), "web finalization");
  const job = db.createJob(crypto.randomUUID(), conversation.id); db.updateJob(job.id, "running");
  const message = { id: crypto.randomUUID(), conversation_id: conversation.id, role: "assistant" as const, content: "[作品](outputs/demo.html)", created_at: new Date().toISOString() };
  const body = '<!doctype html><title>作品</title><button onclick="this.textContent=1">点击</button>';
  fs.mkdirSync(path.join(root, "outputs")); fs.writeFileSync(path.join(root, "outputs/demo.html"), body);
  fs.writeFileSync(path.join(root, "outputs/demo.html.pp-agent.json"), JSON.stringify({ presentation_mode: "web", sha256: crypto.createHash("sha256").update(body).digest("hex") }));
  const outputs = await snapshotDeliverables(root); assert.equal(outputs.size, 2);
  const sources = [...outputs.keys()].map(relative => {
    const id = crypto.randomUUID(), name = path.basename(relative), sourcePath = path.join(root, relative);
    return { row: { id, conversation_id: conversation.id, message_id: message.id, original_name: name, relative_path: `deliverables/${id}/${name}`, mime_type: name.endsWith(".html") ? "text/html" : "application/json", size: fs.statSync(sourcePath).size, kind: "output" as const, created_at: message.created_at }, sourcePath };
  });
  db.stageJobFinalization(job.id, { message, files: sources.map(s => s.row) });
  const { files } = await prepareFinalizationFiles(path.join(root, "data"), job.id, sources);
  const ready = { message, files }; db.markJobFilesReady(job.id, ready);
  const journal = JSON.parse(db.getJob(job.id)!.finalization_payload!) as JobFinalizationPayload;
  const recovered = await recoverPreparedFinalization(path.join(root, "data"), job.id, journal); assert.ok(recovered);
  db.finalizeJob(job.id, conversation.id, recovered); db.finalizeJob(job.id, conversation.id, recovered);
  const stored = db.getFile(files[0].id)!;
  assert.equal(stored.presentation_mode, "web"); assert.equal(stored.presentation_manifest, files[0].presentation_manifest);
  assert.equal(stored.sha256, files[0].sha256); assert.equal(stored.previous_file_id, null);
  assert.equal(db.listFiles(conversation.id).length, 1); db.publishJobFinalization(job.id);
});

test("job finalization streams, hashes, atomically publishes files, and commits metadata once", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-finalization-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const source = path.join(root, "source.bin");
  const content = Buffer.alloc(4 * 1024 * 1024, 0x5a);
  fs.writeFileSync(source, content);
  const db = new AppDatabase(dataRoot);
  context.after(() => db.close());
  const conversation = db.createConversation(crypto.randomUUID(), "finalization");
  const job = db.createJob(crypto.randomUUID(), conversation.id);
  db.updateJob(job.id, "running");
  const messageId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const payload: JobFinalizationPayload = {
    message: { id: messageId, conversation_id: conversation.id, role: "assistant", content: "done", created_at: new Date().toISOString() },
    files: [{
      id: fileId, conversation_id: conversation.id, message_id: messageId,
      original_name: "result.bin", relative_path: `deliverables/${fileId}/result.bin`,
      mime_type: "application/octet-stream", size: content.length, kind: "output", created_at: new Date().toISOString(),
    }],
  };
  db.stageJobFinalization(job.id, payload);
  const { files } = await prepareFinalizationFiles(dataRoot, job.id, [{ row: payload.files[0], sourcePath: source }]);
  assert.equal(files[0].sha256, crypto.createHash("sha256").update(content).digest("hex"));
  assert.deepEqual(fs.readFileSync(path.join(dataRoot, files[0].relative_path)), content);
  const ready = { ...payload, files };
  db.markJobFilesReady(job.id, ready);
  db.finalizeJob(job.id, conversation.id, ready);
  db.finalizeJob(job.id, conversation.id, ready);
  assert.equal(db.getJob(job.id)?.status, "completed");
  assert.equal(db.getJob(job.id)?.finalization_state, "db_committed");
  assert.notEqual(db.getJob(job.id)?.finalization_payload, null);
  assert.equal(db.listMessages(conversation.id).filter((message) => message.id === messageId).length, 1);
  assert.equal(db.getConversation(conversation.id)?.unread_anchor_message_id, messageId);
  assert.equal(db.getFile(fileId)?.sha256, files[0].sha256);
  db.publishJobFinalization(job.id);
  assert.equal(db.getJob(job.id)?.finalization_state, "published");
  assert.equal(db.getJob(job.id)?.finalization_payload, null);
  db.publishJobFinalization(job.id);
  assert.equal(db.getJob(job.id)?.finalization_payload, null);
  await cleanupFinalizationDirectory(dataRoot, job.id);
});

test("terminal Jobs without a recovery journal are published immediately", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-terminal-finalization-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new AppDatabase(root, undefined, false);
  context.after(() => db.close());

  const cancelledConversation = db.createConversation(crypto.randomUUID(), "cancelled");
  const cancelled = db.createJob(crypto.randomUUID(), cancelledConversation.id);
  assert.equal(db.cancelQueuedJob(cancelled.id), true);
  assert.equal(db.getJob(cancelled.id)?.finalization_state, "published");

  const failedConversation = db.createConversation(crypto.randomUUID(), "failed");
  const failed = db.createJob(crypto.randomUUID(), failedConversation.id);
  db.updateJob(failed.id, "running");
  db.finishJob(failed.id, failedConversation.id, "failed", "boom");
  assert.equal(db.getJob(failed.id)?.finalization_state, "published");
  assert.equal(db.getJob(failed.id)?.finalization_payload, null);

  const legacyConversation = db.createConversation(crypto.randomUUID(), "legacy-completed");
  const legacy = db.createJob(crypto.randomUUID(), legacyConversation.id);
  db.updateJob(legacy.id, "completed");
  assert.equal(db.getJob(legacy.id)?.finalization_state, "published");

  const recoverableConversation = db.createConversation(crypto.randomUUID(), "recoverable-failure");
  const recoverable = db.createJob(crypto.randomUUID(), recoverableConversation.id);
  db.updateJob(recoverable.id, "running");
  db.stageJobFinalization(recoverable.id, {
    message: {
      id: crypto.randomUUID(), conversation_id: recoverableConversation.id, role: "assistant",
      content: "recover me", created_at: new Date().toISOString(),
    },
    files: [],
  });
  db.finishJob(recoverable.id, recoverableConversation.id, "failed", "publish interrupted");
  assert.equal(db.getJob(recoverable.id)?.finalization_state, "staging");
  assert.notEqual(db.getJob(recoverable.id)?.finalization_payload, null);
  assert.equal(db.listRecoverableJobFinalizations().some((job) => job.id === recoverable.id), true);
});

test("staged finalization recovery is all-or-nothing and rollback only touches UUID-owned paths", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-finalization-recovery-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const source = path.join(root, "source.txt");
  fs.writeFileSync(source, "recover me", "utf8");
  const jobId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const payload: JobFinalizationPayload = {
    message: { id: messageId, conversation_id: crypto.randomUUID(), role: "assistant", content: "done", created_at: new Date().toISOString() },
    files: [{ id: fileId, conversation_id: "owner", message_id: messageId, original_name: "result.txt", relative_path: `deliverables/${fileId}/result.txt`, mime_type: "text/plain", size: 10, kind: "output", created_at: new Date().toISOString() }],
  };
  const { files } = await prepareFinalizationFiles(dataRoot, jobId, [{ row: payload.files[0], sourcePath: source }]);
  const recovered = await recoverPreparedFinalization(dataRoot, jobId, { ...payload, files });
  assert.equal(recovered?.files[0].sha256, files[0].sha256);
  fs.truncateSync(path.join(dataRoot, files[0].relative_path), 2);
  assert.equal(await recoverPreparedFinalization(dataRoot, jobId, { ...payload, files }), null);
  await rollbackUncommittedFinalization(dataRoot, jobId, payload);
  assert.equal(fs.existsSync(path.join(dataRoot, `deliverables/${fileId}`)), false);
});

test("finalization orphan sweep preserves active, recent, non-UUID and symlink directories", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-finalization-sweep-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = path.join(root, "finalization");
  const old = crypto.randomUUID();
  const active = crypto.randomUUID();
  const recent = crypto.randomUUID();
  for (const name of [old, active, recent, "do-not-touch"]) fs.mkdirSync(path.join(staging, name), { recursive: true });
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1_000);
  fs.utimesSync(path.join(staging, old), oldTime, oldTime);
  fs.utimesSync(path.join(staging, active), oldTime, oldTime);
  const removed = await sweepFinalizationOrphans(root, new Set([active]));
  assert.deepEqual(removed, [old]);
  assert.equal(fs.existsSync(path.join(staging, active)), true);
  assert.equal(fs.existsSync(path.join(staging, recent)), true);
  assert.equal(fs.existsSync(path.join(staging, "do-not-touch")), true);
});
