import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { AppDatabase, LEGACY_USER_ID, type VoiceTranscriptionRow } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { createApp } from "../server/app.js";
import { selectTranscriptionKeywords, TranscriptionService } from "../server/transcription.js";
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

test("OpenAI submission uses account enabled terms, excludes later messages, persists provider and duration and switches back", async t => {
  const f=fixture(t); f.config.transcriptionProvider="openai"; f.config.openaiTranscriptionModel="gpt-transcribe";
  const other=crypto.randomUUID(); f.db.sqlite.prepare("INSERT INTO users(id,username,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(other,"other-fixture","Other fixture","unused",new Date().toISOString(),new Date().toISOString());
  const insert=f.db.sqlite.prepare("INSERT INTO voice_lexicon_terms(id,user_id,canonical_key,canonical_text,status,pinned,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)");
  const now=new Date().toISOString(), term=crypto.randomUUID();
  insert.run(term,LEGACY_USER_ID,"atlas","AtlasWidget","active",now,now);
  insert.run(crypto.randomUUID(),other,"private","OtherTenantTerm","active",now,now);
  f.db.setVoiceLexiconTermDisabled(LEGACY_USER_ID,term,true);
  let calls=0;
  const service=new VoiceSubmissionService(f.config,f.db,{audioRoot:f.audioRoot,transcribe:async(_file,context,options)=>{
    const words=selectTranscriptionKeywords(context?.personalizedTerms??[]).values;
    assert.equal(words.includes("OtherTenantTerm"),false);
    assert.equal(words.includes("AtlasWidget"),calls!==0);
    assert.equal(context?.recentMessages?.some(m=>m.content==="future-message"),false);
    options?.onUsage?.(3); calls++;return "识别文本";
  }},()=>{},()=>{});
  const first=service.accept(f.input)!;
  f.db.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)").run(crypto.randomUUID(),f.input.conversation.id,"user","future-message","2099-01-01T00:00:00.000Z");
  await service.pump();const row=f.db.getVoiceTranscriptionByClientRecordingId(LEGACY_USER_ID,f.input.recordingId)!;
  assert.equal(row.provider,"openai");assert.equal(row.model,"gpt-transcribe");assert.equal(row.usage_seconds,3);
  assert.match(row.prompt_version,/openai/);assert.equal(service.accept(f.input)!.id,first.id);assert.equal(calls,1);
  f.db.setVoiceLexiconTermDisabled(LEGACY_USER_ID,term,false);f.config.transcriptionProvider="dashscope";
  const next={...f.input,recordingId:crypto.randomUUID()}; service.accept(next);await service.pump();
  assert.equal(f.db.getVoiceTranscriptionByClientRecordingId(LEGACY_USER_ID,next.recordingId)?.provider,"dashscope");
  assert.equal(f.db.getVoiceTranscriptionByClientRecordingId(LEGACY_USER_ID,next.recordingId)?.model,f.config.dashscopeModel);
});

test("new voice submission recovers prior recognized draft links after reload and retries only once", t => {
  const f = fixture(t), priorId = crypto.randomUUID();
  f.db.createVoiceTranscription({ id: priorId, userId: LEGACY_USER_ID, conversationId: f.input.conversation.id,
    rawText: "prior speech", model: "fixture", promptVersion: "fixture", selectedTermIds: [] });
  f.db.saveComposerDraft(f.input.conversation.id, f.input.content, f.input.quote, [priorId]);
  const service = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => "next speech" }, () => {}, () => {});
  const accepted = service.accept(f.input)!; // The new browser supplies no IDs.
  assert.equal((f.db.sqlite.prepare("SELECT * FROM voice_transcriptions WHERE id=?").get(priorId) as VoiceTranscriptionRow | undefined)?.pending_prompt_id, accepted.id);
  assert.equal(f.db.getComposerDraft(f.input.conversation.id), undefined);
  assert.equal(service.accept(f.input)?.id, accepted.id);
  assert.equal(f.db.listPendingPrompts(f.input.conversation.id).length, 1);
  // A late acknowledgement for the old recording must not discard a newer
  // recognized draft even when it happens to contain identical text.
  const newerId = crypto.randomUUID();
  f.db.createVoiceTranscription({ id: newerId, userId: LEGACY_USER_ID, conversationId: f.input.conversation.id,
    rawText: f.input.content, model: "fixture", promptVersion: "fixture", selectedTermIds: [] });
  f.db.saveComposerDraft(f.input.conversation.id, f.input.content, f.input.quote, [newerId]);
  assert.equal(service.accept(f.input)?.id, accepted.id);
  assert.deepEqual(f.db.getComposerDraftVoiceTranscriptionIds(f.input.conversation.id), [newerId]);
});

test("cancelling queued recognition aborts its upstream signal without resurrecting results", async t=>{
  const f=fixture(t);let aborted=false;
  const service=new VoiceSubmissionService(f.config,f.db,{audioRoot:f.audioRoot,transcribe:async(_f,_c,options)=>new Promise((_resolve,reject)=>{
    options!.signal!.addEventListener("abort",()=>{aborted=true;reject(options!.signal!.reason);},{once:true});
  })},()=>{},()=>{});
  const pending=service.accept(f.input)!;const running=service.pump();service.cancel(pending.id);await running;
  assert.equal(aborted,true);assert.equal(service.get(LEGACY_USER_ID,f.input.recordingId)?.state,"cancelled");
  assert.equal(f.db.getVoiceTranscriptionByClientRecordingId(LEGACY_USER_ID,f.input.recordingId),undefined);
});

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
  const steer = () => agent.post(`/api/conversations/${conversation.id}/pending-prompts/${accepted.body.pendingPrompt.id}/steer`).set("X-CSRF-Token", csrf);
  const armed = await steer().expect(202);
  assert.equal(armed.body.mode, "deferred");
  assert.equal(armed.body.pendingPrompt.voiceSubmission.steer_state, "requested");
  await steer().expect(202);
  assert.equal((await agent.get(`/api/conversations/${conversation.id}`).expect(200)).body.pendingPrompts[0].voiceSubmission.steer_state, "requested");
  resolve("accepted transcript"); await instance.waitForBackgroundTasks();
  assert.equal(instance.db.getPendingPrompt(accepted.body.pendingPrompt.id), undefined);
  const messages = instance.db.listMessages(conversation.id);
  assert.equal(messages.length, 1); assert.equal(messages[0].content, "typed input\naccepted transcript");
  assert.equal(instance.db.listFilesForMessage(messages[0].id)[0].original_name, "context.txt");
  assert.equal(instance.db.listActiveJobsForConversation(conversation.id).length, 1);
});

test("deferred steer is durable, idempotent, and reserved from ordinary dispatch until delivery", async t => {
  const f = fixture(t);
  const first = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => "unused" }, () => {}, () => {});
  const pending = first.accept(f.input)!;
  assert.throws(() => first.requestSteer(crypto.randomUUID(), pending.id, "steer"));
  first.requestSteer(LEGACY_USER_ID, pending.id, "steer"); first.requestSteer(LEGACY_USER_ID, pending.id, "steer");
  f.db.sqlite.prepare("UPDATE voice_submissions SET state='processing' WHERE id=?").run(pending.voiceSubmission!.id);
  first.stop();
  const reopened = new AppDatabase(f.config.dataRoot, undefined, false);
  let calls = 0;
  try {
    const recovered = new VoiceSubmissionService(f.config, reopened, { audioRoot: f.audioRoot, transcribe: async () => "recognized after restart" }, () => {}, () => {}, async ready => {
      calls++; assert.equal(ready.content, "typed context\nrecognized after restart"); assert.equal(ready.quote_excerpt, "quote");
      assert.equal(reopened.getPendingPrompt(ready.id)?.voiceSubmission?.steer_state, "sending");
      assert.deepEqual(reopened.listDispatchablePendingPrompts(), []);
      assert.equal(reopened.getNextDispatchablePendingPrompt(), undefined);
      assert.equal(reopened.beginEditingPendingPrompt(ready.id), undefined);
      assert.equal(reopened.restorePendingPrompt(ready.id), undefined);
      assert.equal(recovered.requestSteer(LEGACY_USER_ID, ready.id, "steer").voiceSubmission?.steer_state, "sending");
      assert.ok(reopened.materializeSteeredPrompt(ready.id, crypto.randomUUID()));
    });
    await recovered.pump(); await recovered.pump();
    assert.equal(calls, 1); assert.equal(reopened.listMessages(f.input.conversation.id).length, 1);
    assert.equal(reopened.getPendingPrompt(pending.id), undefined);
  } finally { reopened.close(); }
});

test("recognition retry retains deferred steer; deleting an armed recording prevents late delivery", async t => {
  const f = fixture(t); let fail = true, calls = 0;
  const service = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => { if (fail) throw new Error("ASR failure"); return "retry text"; } }, () => {}, () => {}, async pending => {
    calls++; f.db.materializeSteeredPrompt(pending.id, crypto.randomUUID());
  });
  const pending = service.accept(f.input)!; service.requestSteer(LEGACY_USER_ID, pending.id, "steer");
  await service.pump(); assert.equal(calls, 0);
  assert.equal(f.db.getPendingPrompt(pending.id)?.voiceSubmission?.steer_state, "requested");
  fail = false; assert.equal(service.retry(LEGACY_USER_ID, pending.id), true); await service.pump(); assert.equal(calls, 1);
  let resolve!: (text: string) => void;
  const cancel = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: () => new Promise(r => { resolve = r; }) }, () => {}, () => {}, async () => { calls++; });
  const second = cancel.accept({ ...f.input, recordingId: crypto.randomUUID() })!;
  const work = cancel.pump(); cancel.requestSteer(LEGACY_USER_ID, second.id, "steer");
  cancel.cancel(second.id); f.db.deletePendingPrompt(second.id); resolve("must never deliver"); await work;
  assert.equal(calls, 1);
});

test("ambiguous automatic delivery stays held across restart and requires explicit retry or edit", async t => {
  const f = fixture(t); let calls = 0;
  const service = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => "recognized" }, () => {}, () => {}, async () => { calls++; throw new Error("delivery acknowledgement timed out"); });
  const pending = service.accept(f.input)!; service.requestSteer(LEGACY_USER_ID, pending.id, "steer");
  await service.pump(); await service.pump(); assert.equal(calls, 1);
  assert.equal(f.db.getPendingPrompt(pending.id)?.voiceSubmission?.steer_state, "failed");
  assert.deepEqual(f.db.listDispatchablePendingPrompts(), []);
  // Simulate the crash boundary after claiming, before recording the reply.
  f.db.sqlite.prepare("UPDATE voice_submissions SET steer_state='sending' WHERE id=?").run(pending.voiceSubmission!.id);
  const recovered = new VoiceSubmissionService(f.config, f.db, { audioRoot: f.audioRoot, transcribe: async () => { throw new Error("must not recognize again"); } }, () => {}, () => {}, async () => { calls++; });
  await recovered.pump(); assert.equal(calls, 1);
  assert.match(f.db.getPendingPrompt(pending.id)!.voiceSubmission!.steer_error!, /未确认/);
  assert.deepEqual(f.db.listDispatchablePendingPrompts(), []);
  assert.ok(f.db.beginEditingPendingPrompt(pending.id));
  assert.equal(f.db.getPendingPrompt(pending.id)?.voiceSubmission?.steer_state, null);
  assert.ok(f.db.restorePendingPrompt(pending.id)); assert.equal(f.db.listDispatchablePendingPrompts()[0]?.id, pending.id);
});

test("API defers running-turn steering, rejects incompatible models, and never sends incomplete speech", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-steer-api-"));
  let resolve!: (text: string) => void, deliveryResolve!: () => void, entered!: () => void;
  const recognized = new Promise<string>(r => { resolve = r; });
  const delivering = new Promise<void>(r => { entered = r; });
  const delivered = new Promise<void>(r => { deliveryResolve = r; });
  t.mock.method(TranscriptionService.prototype, "transcribe", () => recognized);
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "pp", passwordHash: bcrypt.hashSync("voice-steer-test", 4), sessionSecret: "voice-steer-test-session-secret-at-least32characters", queueAutoStart: false });
  t.after(async () => { resolve("recognized"); deliveryResolve(); instance.beginShutdown(); await instance.waitForBackgroundTasks(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app), login = await agent.post("/api/auth/login").send({ username: "pp", password: "voice-steer-test" }).expect(200);
  const csrf = login.body.csrfToken;
  const conversation = (await agent.post("/api/conversations").set("X-CSRF-Token", csrf).expect(201)).body.conversation;
  const job = instance.db.createJob(crypto.randomUUID(), conversation.id, null, { model: conversation.agent_model, reasoningEffort: conversation.reasoning_effort });
  instance.db.updateJob(job.id, "running");
  const receipt = await agent.post(`/api/conversations/${conversation.id}/voice-messages`).set("X-CSRF-Token", csrf)
    .field("clientRecordingId", crypto.randomUUID()).field("message", "typed context").field("quoteExcerpt", "quote")
    .attach("audio", Buffer.from("fake audio"), { filename: "recording.webm", contentType: "audio/webm" }).expect(202);
  const id = receipt.body.pendingPrompt.id, url = `/api/conversations/${conversation.id}/pending-prompts/${id}`;
  instance.db.sqlite.prepare("UPDATE jobs SET agent_model='antigravity:test' WHERE id=?").run(job.id);
  await agent.post(url + "/steer").set("X-CSRF-Token", csrf).expect(409);
  assert.equal(instance.db.getPendingPrompt(id)?.voiceSubmission?.steer_state, null);
  instance.db.sqlite.prepare("UPDATE jobs SET agent_model=? WHERE id=?").run(conversation.agent_model, job.id);
  let calls = 0;
  instance.runner.steer = async (jobId, text) => {
    calls++; assert.equal(jobId, job.id); assert.match(text, /typed context\nrecognized/); assert.match(text, /quote/);
    entered(); await delivered; return "turn-fixture";
  };
  await agent.post(url + "/steer").set("X-CSRF-Token", csrf).expect(202);
  await agent.post(url + "/steer").set("X-CSRF-Token", csrf).expect(202); assert.equal(calls, 0);
  resolve("recognized"); await delivering;
  await agent.delete(url).set("X-CSRF-Token", csrf).expect(409);
  await agent.post(url + "/edit").set("X-CSRF-Token", csrf).expect(409);
  await agent.post(url + "/steer").set("X-CSRF-Token", csrf).expect(202);
  deliveryResolve(); await instance.waitForBackgroundTasks();
  assert.equal(calls, 1); assert.equal(instance.db.listMessages(conversation.id).length, 1);
  assert.equal(instance.db.getPendingPrompt(id), undefined);
});
