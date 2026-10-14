import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { createApp } from "../server/app.js";
import { TranscriptionService } from "../server/transcription.js";
import { VoiceSubmissionService } from "../server/voice-submissions.js";
import { resolveVoiceRecordingPath } from "../server/voice-recording.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-send-test-"));
  const config = loadConfig({ dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false });
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const db = new AppDatabase(config.dataRoot, undefined, false);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = db.createConversation(crypto.randomUUID(), "voice send");
  const filePath = path.join(root, "input.webm"); fs.writeFileSync(filePath, "audio fixture");
  const audioRoot = path.join(root, "voice-input"); fs.mkdirSync(audioRoot);
  const input = { conversation, recordingId: crypto.randomUUID(), filePath, mimeType: "audio/webm", content: "typed context", quote: "quote", selection: { model: "gpt-test", reasoningEffort: "low" }, voiceIds: [] as string[], maximumBytes: 1024 * 1024 };
  return { root, config, db, input, audioRoot };
}

test("accepted voice preserves draft attachments, blocks execution and later inputs, and acknowledges before recognition", async t => {
  const f = fixture(t);
  let resolve!: (text: string) => void;
  const deferred = new Promise<string>(r => { resolve = r; });
  let calls = 0;
  const service = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => { calls++; return deferred; } }, () => {}, () => {});
  const priorVoiceId = crypto.randomUUID();
  f.db.createVoiceTranscription({ id: priorVoiceId, userId: LEGACY_USER_ID, rawText: "prior speech", model: "test", promptVersion: "test", selectedTermIds: [] });
  f.input.voiceIds.push(priorVoiceId);
  f.db.saveComposerDraft(f.input.conversation.id, f.input.content, f.input.quote);
  const fileId = crypto.randomUUID();
  f.db.addFile({ id: fileId, conversation_id: f.input.conversation.id, message_id: null, composer_draft_id: f.input.conversation.id,
    original_name: "image.png", relative_path: "uploads/image.png", mime_type: "image/png", size: 3, kind: "upload", created_at: new Date().toISOString() });
  const accepted = service.accept(f.input)!;
  assert.equal(accepted.voiceSubmission?.state, "queued");
  assert.equal(accepted.status, "editing", "an older binary cannot dispatch unresolved audio after rollback"); assert.equal(accepted.files[0]?.id, fileId);
  assert.equal(f.db.getComposerDraft(f.input.conversation.id), undefined);
  const later = f.db.createPendingPrompt(crypto.randomUUID(), f.input.conversation.id, "later", f.input.selection);
  assert.deepEqual(f.db.listDispatchablePendingPrompts(), []);
  assert.equal(f.db.materializePendingPrompt(accepted.id, crypto.randomUUID(), crypto.randomUUID()), undefined);
  assert.equal(f.db.beginEditingPendingPrompt(accepted.id), undefined);
  assert.equal(f.db.restorePendingPrompt(accepted.id), undefined);
  assert.equal(f.db.updateEditingPendingPrompt(accepted.id, "must not replace accepted input", f.input.selection), undefined);
  assert.equal(f.db.getConversation(f.input.conversation.id)?.has_pending_work, 1);
  f.db.sqlite.prepare("INSERT INTO para_pending_context(pending_id,snapshot) VALUES(?,?)").run(accepted.id, '{"accepted":true}');
  const running = service.pump();
  assert.equal(service.accept(f.input)!.id, accepted.id);
  assert.equal(service.accept({ ...f.input, voiceIds: [] })!.id, accepted.id, "lost response then browser reload reuses the receipt even without in-memory prior voice IDs");
  f.db.saveComposerDraft(f.input.conversation.id, f.input.content, f.input.quote);
  service.accept(f.input);
  assert.equal(f.db.getComposerDraft(f.input.conversation.id), undefined, "pagehide cannot restore already-sent text after receipt retry");
  f.db.saveComposerDraft(f.input.conversation.id, "newer draft from another page", null);
  service.accept(f.input);
  assert.equal(f.db.getComposerDraft(f.input.conversation.id)?.content, "newer draft from another page");
  assert.equal(calls, 1);
  assert.throws(() => service.accept({ ...f.input, content: "changed" }), /不同发送内容/);
  resolve("recognized speech"); await running;
  const ready = f.db.getPendingPrompt(accepted.id)!;
  assert.equal(ready.content, "typed context\nrecognized speech"); assert.equal(ready.quote_excerpt, "quote");
  assert.equal(ready.voiceSubmission?.state, "completed");
  assert.equal((f.db.sqlite.prepare("SELECT snapshot FROM para_pending_context WHERE pending_id=?").get(accepted.id) as { snapshot: string }).snapshot, '{"accepted":true}');
  assert.deepEqual(f.db.listDispatchablePendingPrompts().map(p => p.id), [accepted.id, later.id]);
  const job = f.db.materializePendingPrompt(accepted.id, crypto.randomUUID(), crypto.randomUUID())!;
  assert.equal(f.db.getMessage(job.message_id!)!.content, ready.content);
  assert.equal(f.db.listFilesForMessage(job.message_id!)[0]?.id, fileId);
  assert.equal(service.accept(f.input), null, "retry after materialization does not enqueue twice");
});

test("database acceptance failure removes audio and leaves the composer intact", t => {
  const f = fixture(t);
  const service = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => "unused" }, () => {}, () => {});
  f.db.saveComposerDraft(f.input.conversation.id, "unsent text", "quote");
  const originalExec = f.db.sqlite.exec.bind(f.db.sqlite);
  const mocked = t.mock.method(f.db.sqlite, "exec", (sql: string) => {
    if (sql === "BEGIN IMMEDIATE") throw new Error("injected database busy");
    return originalExec(sql);
  });
  assert.throws(() => service.accept(f.input), /injected database busy/);
  mocked.mock.restore();
  assert.equal(f.db.getComposerDraft(f.input.conversation.id)?.content, "unsent text");
  assert.equal(f.db.listPendingPrompts(f.input.conversation.id).length, 0);
  const recordings = path.join(f.config.dataRoot, "voice-recordings");
  assert.deepEqual(fs.readdirSync(recordings, { recursive: true }).filter(p => fs.statSync(path.join(recordings, String(p))).isFile()), []);
});

test("server restart resumes a persisted processing receipt and recognized content is committed once", async t => {
  const f = fixture(t);
  const first = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => "unused" }, () => {}, () => {});
  const accepted = first.accept(f.input)!;
  f.db.sqlite.prepare("UPDATE voice_submissions SET state='processing'").run();
  first.stop();
  const reopened = new AppDatabase(f.config.dataRoot, undefined, false);
  try {
    const recovered = new VoiceSubmissionService(f.config, reopened, { audioRoot: f.audioRoot, transcribe: async () => "after restart" }, () => {}, () => {});
    await recovered.pump();
    assert.equal(reopened.getPendingPrompt(accepted.id)?.content, "typed context\nafter restart");
    await recovered.pump();
    assert.equal((reopened.sqlite.prepare("SELECT count(*) AS n FROM voice_transcriptions").get() as { n: number }).n, 1);
  } finally { reopened.close(); }
});

test("recognition failure retains audio, retry is explicit and tenant ownership is enforced", async t => {
  const f = fixture(t); let fail = true;
  const service = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => { if (fail) throw new Error("provider unavailable"); return "retry success"; } }, () => {}, () => {});
  const accepted = service.accept(f.input)!;
  await service.pump();
  assert.equal(f.db.getPendingPrompt(accepted.id)?.voiceSubmission?.state, "failed");
  const row = service.get(LEGACY_USER_ID, f.input.recordingId)!;
  assert.equal(fs.existsSync(resolveVoiceRecordingPath(f.config.dataRoot, JSON.parse(row.audio_json).relativePath)), true);
  assert.equal(service.retry(crypto.randomUUID(), accepted.id), false);
  fail = false; assert.equal(service.retry(LEGACY_USER_ID, accepted.id), true);
  await service.pump(); assert.equal(f.db.getPendingPrompt(accepted.id)?.voiceSubmission?.state, "completed");
});

test("deleting a pending voice while recognition is running prevents resurrection and removes owned audio", async t => {
  const f = fixture(t); let resolve!: (text: string) => void;
  const service = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: () => new Promise(r => { resolve = r; }) }, () => {}, () => {});
  const accepted = service.accept(f.input)!; const row = service.get(LEGACY_USER_ID, f.input.recordingId)!;
  const running = service.pump();
  service.cancel(accepted.id); f.db.deletePendingPrompt(accepted.id);
  resolve("must not run"); await running;
  assert.equal(service.get(LEGACY_USER_ID, f.input.recordingId)?.state, "cancelled");
  assert.equal(f.db.listMessages(f.input.conversation.id).length, 0);
  assert.equal(fs.existsSync(resolveVoiceRecordingPath(f.config.dataRoot, JSON.parse(row.audio_json).relativePath)), false);
});

test("real upload API returns202 while ASR is pending; refresh shows saved status and text plus files survives", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-send-api-"));
  let resolve!: (text: string) => void;
  const promise = new Promise<string>(r => { resolve = r; });
  t.mock.method(TranscriptionService.prototype, "transcribe", () => promise);
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "owner", passwordHash: bcrypt.hashSync("voice-send-test", 4), sessionSecret: "voice-send-test-session-secret-at-least32characters", queueAutoStart: false });
  t.after(async () => { resolve("accepted transcript"); instance.beginShutdown(); await instance.waitForBackgroundTasks(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "voice api");
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "owner", password: "voice-send-test" }).expect(200);
  const csrf = login.body.csrfToken;
  await agent.post(`/api/conversations/${conversation.id}/draft/files`).set("X-CSRF-Token", csrf).attach("files", Buffer.from("attachment text"), "context.txt").expect(201);
  const id = crypto.randomUUID();
  const send = () => agent.post(`/api/conversations/${conversation.id}/voice-messages`).set("X-CSRF-Token", csrf)
    .field("clientRecordingId", id).field("message", "typed input").field("quoteExcerpt", "quoted text")
    .attach("audio", Buffer.from("fake audio"), { filename: "recording.webm", contentType: "audio/webm" });
  const accepted = await send().expect(202); assert.equal(accepted.body.accepted, true);
  await agent.post(`/api/conversations/${conversation.id}/pending-prompts/${accepted.body.pendingPrompt.id}/restore`).set("X-CSRF-Token", csrf).expect(409);
  await agent.put(`/api/conversations/${conversation.id}/pending-prompts/${accepted.body.pendingPrompt.id}`).set("X-CSRF-Token", csrf).field("message", "cannot edit during recognition").expect(409);
  const refreshed = await agent.get(`/api/conversations/${conversation.id}`).expect(200);
  assert.ok(["queued", "processing"].includes(refreshed.body.pendingPrompts[0].voiceSubmission.state));
  assert.equal(refreshed.body.pendingPrompts[0].files[0].original_name, "context.txt");
  assert.equal((await send().expect(202)).body.pendingPrompt.id, accepted.body.pendingPrompt.id);
  await agent.post(`/api/conversations/${conversation.id}/pending-prompts/${accepted.body.pendingPrompt.id}/steer`).set("X-CSRF-Token", csrf).expect(409);
  resolve("accepted transcript"); await instance.waitForBackgroundTasks();
  assert.equal(instance.db.getPendingPrompt(accepted.body.pendingPrompt.id)?.content, "typed input\naccepted transcript");
});
