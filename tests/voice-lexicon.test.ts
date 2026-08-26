import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../server/config.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { canonicalVoiceTermKey, formatVoiceLexiconTerms, isSpecializedVoiceTerm, VoiceLexiconReviewer, VoiceLexiconService } from "../server/voice-lexicon.js";
import { codexVoiceReviewArguments, VOICE_LEXICON_CODEX_MODEL, VOICE_LEXICON_REASONING_EFFORT, VOICE_LEXICON_OUTPUT_SCHEMA, validateCodexVoiceReviewRequest } from "../server/codex-voice-review.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-voice-lexicon-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new AppDatabase(root, undefined, false);
  t.after(() => db.close());
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "Codex Web", path.join(root, "project"));
  const conversation = db.createConversation(crypto.randomUUID(), "语音测试", undefined, LEGACY_USER_ID, project.id);
  return { root, db, project, conversation };
}

test("specialized-term gate rejects fillers while retaining product and code terminology", () => {
  assert.equal(isSpecializedVoiceTerm("嗯"), false);
  assert.equal(isSpecializedVoiceTerm("好的"), false);
  assert.equal(isSpecializedVoiceTerm("Codex Web"), true);
  assert.equal(isSpecializedVoiceTerm("qwen3.5-omni-plus"), true);
  assert.equal(isSpecializedVoiceTerm("语音词库"), true);
  assert.equal(canonicalVoiceTermKey(" Codex Web "), "codexweb");
});

test("account settings exposes a mobile-ready voice keyword viewer with ranking metrics", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
  const dialogSource = fs.readFileSync(path.join(process.cwd(), "src/voice-lexicon-dialog.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8");
  assert.match(appSource, /<span>语音关键词<\/span>/);
  for (const label of ["已选词", "候选词", "综合权重", "衰减使用数", "使用强度", "加权误识别", "可靠误识别率"]) {
    assert.match(dialogSource, new RegExp(label));
  }
  assert.match(styles, /\.voice-keyword-metrics \{ display:grid; grid-template-columns:repeat\(6/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.voice-keyword-metrics \{ grid-template-columns:repeat\(2/);
});

test("voice lexicon selection is hard-capped to the top one hundred active terms", (t) => {
  const { db, project } = fixture(t);
  const insert = db.sqlite.prepare(`
    INSERT INTO voice_lexicon_terms(
      id,user_id,project_id,canonical_key,canonical_text,status,rank_index,created_at,updated_at
    ) VALUES(?,?,?,?,?,'active',?,?,?)
  `);
  const now = new Date().toISOString();
  for (let index = 0; index < 105; index += 1) {
    insert.run(crypto.randomUUID(), LEGACY_USER_ID, project.id, `term-${index}`, `Term ${index}`, index, now, now);
  }
  assert.equal(loadConfig({ voiceLexiconMaxTerms: 500 }).voiceLexiconMaxTerms, 100);
  const selected = db.listVoiceLexiconTerms(LEGACY_USER_ID, project.id, 500);
  assert.equal(selected.length, 100);
  assert.equal(selected[0]?.canonical_text, "Term 104");
  assert.equal(selected.at(-1)?.canonical_text, "Term 5");
});

test("submitted voice events follow pending prompts into messages and rank errors above raw popularity", (t) => {
  const { db, project, conversation } = fixture(t);
  const firstId = crypto.randomUUID();
  db.createVoiceTranscription({ id: firstId, userId: LEGACY_USER_ID, rawText: "检查一下 CWA", model: "test", promptVersion: "test" });
  const pending = db.createPendingPrompt(crypto.randomUUID(), conversation.id, "检查一下 CWA", { model: "gpt-test", reasoningEffort: "medium" });
  assert.equal(db.attachVoiceTranscriptions({ ids: [firstId], userId: LEGACY_USER_ID, conversationId: conversation.id, pendingPromptId: pending.id }), 1);
  const messageId = crypto.randomUUID();
  const job = db.materializePendingPrompt(pending.id, messageId, crypto.randomUUID());
  assert.ok(job);
  db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id);
  const source = db.listPendingVoiceReviews(LEGACY_USER_ID, new Date().toISOString(), null, 20);
  assert.equal(source[0]?.message_id, messageId);

  db.markVoiceReviewsProcessing([firstId]);
  db.applyVoiceTermEvidence(LEGACY_USER_ID, [{
    transcriptionId: firstId, canonicalText: "Codex Web", canonicalKey: "codex-web", observedText: "CWA",
    termKind: "product_name", confidence: 0.96, useWeight: 1, errorWeight: 0.8,
  }]);
  db.markVoiceReviewsProcessed([firstId], new Date().toISOString());
  const selected = db.listVoiceLexiconTerms(LEGACY_USER_ID, project.id, 200);
  assert.equal(selected[0]?.canonical_text, "Codex Web");
  assert.ok((selected[0]?.reliable_error_rate ?? 0) > 0.05);
  assert.ok((selected[0]?.rank_index ?? 0) > 0);
  assert.deepEqual(formatVoiceLexiconTerms(selected).lines, ["Codex Web"]);
});

test("reviewer accepts supported correction evidence and ignores generic words", async () => {
  const config = loadConfig();
  let executedUserId = "";
  let executedPrompt = "";
  const reviewer = new VoiceLexiconReviewer(config, async (userId, prompt) => {
    executedUserId = userId;
    executedPrompt = prompt;
    return JSON.stringify({ reviews: [
    { transcription_id: "voice-1", observed: "CWA", intended: "Codex Web", is_term: true, is_error: true, confidence: 0.95, term_kind: "product_name" },
    { transcription_id: "voice-1", observed: "好的", intended: "好的", is_term: true, is_error: false, confidence: 1, term_kind: "generic" },
    { transcription_id: "voice-1", observed: "worker", intended: "worker", is_term: true, is_error: false, confidence: 0.99, term_kind: "技术角色" },
    { transcription_id: "voice-1", observed: "Codex", intended: "Codex", is_term: true, is_error: false, confidence: 0.99, term_kind: "产品名" },
    ] });
  });
  const fakeDb = { listMessages: () => [] } as unknown as AppDatabase;
  const evidence = await reviewer.review([{
    id: "voice-1", user_id: LEGACY_USER_ID, conversation_id: "conversation-1", project_id: null,
    message_id: "message-1", pending_prompt_id: null, raw_text: "CWA token=example-key-placeholder", model: "test", prompt_version: "test",
    selected_terms_json: "[]", status: "pending", attempts: 0, next_attempt_at: null, last_error: null,
    created_at: new Date().toISOString(), submitted_at: new Date().toISOString(), reviewed_at: null,
    conversation_title: "测试", message_content: "Codex Web",
  }], fakeDb);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].canonicalText, "Codex Web");
  assert.equal(evidence[0].errorWeight, 0.8);
  assert.equal(evidence[1].canonicalText, "Codex");
  assert.equal(executedUserId, LEGACY_USER_ID);
  assert.match(executedPrompt, /待复核数据/);
  assert.match(executedPrompt, /\[REDACTED\]/);
  assert.doesNotMatch(executedPrompt, /example-key-placeholder/);
});

test("Codex voice review is locked to Luna with a schema-constrained ephemeral request", () => {
  assert.equal(VOICE_LEXICON_CODEX_MODEL, "gpt-5.6-luna");
  assert.equal(VOICE_LEXICON_REASONING_EFFORT, "medium");
  assert.deepEqual((VOICE_LEXICON_OUTPUT_SCHEMA as { required: string[] }).required, ["reviews"]);
  const args = codexVoiceReviewArguments("schema.json", "output.json");
  for (const required of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "features.shell_tool=false", "tools.web_search=false", "history.persistence=\"none\""]) {
    assert.ok(args.includes(required), `missing isolated Codex argument: ${required}`);
  }
  assert.doesNotThrow(() => validateCodexVoiceReviewRequest({ userId: LEGACY_USER_ID, prompt: "review", timeoutMs: 180_000 }, LEGACY_USER_ID));
  assert.throws(() => validateCodexVoiceReviewRequest({ userId: LEGACY_USER_ID, prompt: "review", timeoutMs: 5_000 }, LEGACY_USER_ID));
});

test("service waits below threshold and reviews immediately at threshold", async (t) => {
  const { root, db, conversation } = fixture(t);
  const messageIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const messageId = crypto.randomUUID();
    db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: "CWA", created_at: new Date().toISOString() });
    const voiceId = crypto.randomUUID();
    db.createVoiceTranscription({ id: voiceId, userId: LEGACY_USER_ID, conversationId: conversation.id, rawText: "CWA", model: "test", promptVersion: "test" });
    db.attachVoiceTranscriptions({ ids: [voiceId], userId: LEGACY_USER_ID, conversationId: conversation.id, messageId });
    messageIds.push(voiceId);
  }
  let calls = 0;
  const execute = async () => {
    calls += 1;
    return '{"reviews":[]}';
  };
  const config = loadConfig({
    dataRoot: root,
    voiceLexiconBatchThreshold: 2, voiceLexiconBatchSize: 20, voiceLexiconDelayMs: 60 * 60_000,
  });
  const service = new VoiceLexiconService(config, db, execute);
  await service.pump();
  assert.equal(calls, 1);
  assert.equal(db.voiceReviewQueueStats(LEGACY_USER_ID, new Date().toISOString()).pending, 0);
  service.stop();
});
