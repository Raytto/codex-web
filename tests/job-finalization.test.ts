import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, type JobFinalizationPayload } from "../server/db.js";
import { cleanupFinalizationDirectory, prepareFinalizationFiles, recoverPreparedFinalization, rollbackUncommittedFinalization, sweepFinalizationOrphans } from "../server/job-finalization.js";

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
  const files = await prepareFinalizationFiles(dataRoot, job.id, [{ row: payload.files[0], sourcePath: source }]);
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
  const files = await prepareFinalizationFiles(dataRoot, jobId, [{ row: payload.files[0], sourcePath: source }]);
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
