import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { AppDatabase, LEGACY_USER_ID, type VoiceTranscriptionRow } from "../server/db.js";
import { TranscriptionService } from "../server/transcription.js";

test("recognized draft survives a fresh browser and sends its original transcription without browser IDs", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "composer-voice-"));
  t.mock.method(TranscriptionService.prototype, "transcribe", async () => "safe spoken fixture");
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "tester", passwordHash: bcrypt.hashSync("draft-voice-test", 4), sessionSecret: "draft-voice-test-session-secret-at-least32characters", queueAutoStart: false });
  t.after(async () => { instance.beginShutdown(); await instance.waitForBackgroundTasks(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const first = request.agent(instance.app);
  const login = await first.post("/api/auth/login").send({ username: "tester", password: "draft-voice-test" }).expect(200);
  const csrf = login.body.csrfToken;
  const conversation = instance.db.createConversation(crypto.randomUUID(), "draft voice fixture");
  const transcript = await first.post("/api/transcriptions").set("X-CSRF-Token", csrf)
    .field("conversationId", conversation.id).field("clientRecordingId", crypto.randomUUID())
    .attach("audio", Buffer.from("isolated adapter fixture"), { filename: "recording.webm", contentType: "audio/webm" }).expect(200);
  const voiceId = transcript.body.transcriptionId as string;
  const save = (id: string, ids: string[]) => first.put(`/api/conversations/${id}/draft`).set("X-CSRF-Token", csrf)
    .send({ content: transcript.body.text, voiceTranscriptionIds: ids });
  await save(conversation.id, [voiceId]).expect(200);
  const other = instance.db.createConversation(crypto.randomUUID(), "other draft");
  await save(other.id, [voiceId]).expect(400);
  const foreignId = crypto.randomUUID();
  instance.db.createVoiceTranscription({ id: foreignId, userId: LEGACY_USER_ID, conversationId: other.id,
    rawText: "foreign fixture", model: "fixture", promptVersion: "fixture", selectedTermIds: [] });
  await save(conversation.id, [foreignId]).expect(400);
  // Also reject a record belonging to another account, even if the draft text
  // and request contain a valid UUID. No other account's text is returned.
  const otherUser = crypto.randomUUID(), now = new Date().toISOString();
  instance.db.sqlite.prepare("INSERT INTO users(id,username,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run(otherUser, "other-draft-fixture", "Other", "unused", now, now);
  const privateId = crypto.randomUUID();
  instance.db.createVoiceTranscription({ id: privateId, userId: otherUser, rawText: "private fixture", model: "fixture", promptVersion: "fixture", selectedTermIds: [] });
  await save(conversation.id, [privateId]).expect(400);
  const second = request.agent(instance.app);
  const secondLogin = await second.post("/api/auth/login").send({ username: "tester", password: "draft-voice-test" }).expect(200);
  const detail = await second.get(`/api/conversations/${conversation.id}`).expect(200);
  assert.equal(detail.body.composerDraft.content, "safe spoken fixture");
  // Ordinary autosave does not carry the old browser's in-memory voice IDs.
  await second.put(`/api/conversations/${conversation.id}/draft`).set("X-CSRF-Token", secondLogin.body.csrfToken)
    .send({ content: "edited safe spoken fixture" }).expect(200);
  const sent = await second.post(`/api/conversations/${conversation.id}/messages`).set("X-CSRF-Token", secondLogin.body.csrfToken)
    .field("message", "edited safe spoken fixture").field("useComposerDraft", "true").expect(202);
  assert.equal((instance.db.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE id=?").get(voiceId) as VoiceTranscriptionRow | undefined)?.message_id, sent.body.message.id);
  assert.equal(instance.db.getComposerDraft(conversation.id), undefined);
  await save(conversation.id, [voiceId]).expect(400);
  assert.equal((instance.db.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE id=?").get(voiceId) as VoiceTranscriptionRow | undefined)?.raw_text, "safe spoken fixture");

  // A second recognized draft while the first job is queued must carry its
  // link into the pending prompt, with no client ID required on Send either.
  const nextId = crypto.randomUUID();
  instance.db.createVoiceTranscription({ id: nextId, userId: LEGACY_USER_ID, conversationId: conversation.id,
    rawText: "next speech", model: "fixture", promptVersion: "fixture", selectedTermIds: [] });
  await save(conversation.id, [nextId]).expect(200);
  const queued = await second.post(`/api/conversations/${conversation.id}/messages`).set("X-CSRF-Token", secondLogin.body.csrfToken)
    .field("message", "next speech").field("useComposerDraft", "true").expect(202);
  assert.equal((instance.db.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE id=?").get(nextId) as VoiceTranscriptionRow | undefined)?.pending_prompt_id, queued.body.pendingPrompt.id);
});

test("draft voice links survive database reopening and clear without deleting original history", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "draft-voice-restart-"));
  let db = new AppDatabase(root, undefined, false);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = db.createConversation(crypto.randomUUID(), "voice restart fixture"), id = crypto.randomUUID();
  db.createVoiceTranscription({ id, userId: LEGACY_USER_ID, conversationId: conversation.id,
    rawText: "safe text", model: "fixture", promptVersion: "fixture", selectedTermIds: [] });
  db.saveComposerDraft(conversation.id, "safe text", null, [id]);
  db.close(); db = new AppDatabase(root, undefined, false);
  assert.deepEqual(db.getComposerDraftVoiceTranscriptionIds(conversation.id), [id]);
  db.saveComposerDraft(conversation.id, "", "retained quote");
  assert.deepEqual(db.getComposerDraftVoiceTranscriptionIds(conversation.id), []);
  assert.ok((db.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE id=?").get(id) as VoiceTranscriptionRow | undefined));
  db.saveComposerDraft(conversation.id, "safe text", null, [id]);
  db.deleteComposerDraft(conversation.id);
  assert.deepEqual(db.getComposerDraftVoiceTranscriptionIds(conversation.id), []);
  assert.ok((db.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE id=?").get(id) as VoiceTranscriptionRow | undefined));
});
