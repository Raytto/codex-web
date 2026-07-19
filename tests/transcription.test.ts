import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import request from "supertest";
import { loadConfig } from "../server/config.js";
import { buildTranscriptionSystemPrompt, textFromSseLine, TranscriptionService } from "../server/transcription.js";

function testConfig(dataRoot: string) {
  return loadConfig({
    dataRoot,
    sessionSecret: "voice-test-session-secret-at-least-32-characters",
    publicBaseUrl: "https://example.test/codex-web",
    dashscopeApiKey: "test-dashscope-key",
    transcriptionPollMs: 0,
    transcriptionTimeoutMs: 1000,
  });
}

test("Qwen Omni streams mixed-language text with bounded spelling context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-voice-"));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    return new Response([
      'data: {"choices":[{"delta":{"content":"Hello world，"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"这里是中文语音。"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const converter = async (_inputPath: string, outputPath: string) => { fs.writeFileSync(outputPath, Buffer.from("wav-test")); };
    const service = new TranscriptionService(testConfig(root), fakeFetch, converter);
    const fileName = `${crypto.randomUUID()}.webm`;
    fs.writeFileSync(path.join(service.audioRoot, fileName), Buffer.from("webm-test"));
    assert.equal(await service.transcribe(fileName, {
      draftText: "修改刚才上传的 PowerPoint",
      attachmentNames: ["家长会PPT.pptx"],
      recentMessages: [
        { role: "user", content: "这条太旧不应保留" },
        { role: "assistant", content: "请上传文件" },
        { role: "user", content: "文件里有 Codex 和 ChatGPT" },
        { role: "assistant", content: "我会保持英文拼写" },
        { role: "user", content: "继续处理" },
      ],
    }), "Hello world，这里是中文语音。");
    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), "Bearer test-dashscope-key");
    const submitted = JSON.parse(String(calls[0].init?.body));
    assert.equal(submitted.model, "qwen3.5-omni-plus");
    assert.deepEqual(submitted.modalities, ["text"]);
    assert.equal(submitted.stream, true);
    assert.match(submitted.messages[0].content, /当前尚未发送的输入草稿.*PowerPoint/s);
    assert.match(submitted.messages[0].content, /家长会PPT\.pptx/);
    assert.doesNotMatch(submitted.messages[0].content, /这条太旧不应保留/);
    assert.match(submitted.messages[1].content[0].input_audio.data, /\/api\/transcription-audio\/[0-9a-f-]+\.wav/);
    assert.equal(submitted.messages[1].content[0].input_audio.format, "wav");
    assert.equal(fs.existsSync(path.join(service.audioRoot, fileName.replace(/\.webm$/, ".wav"))), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("temporary audio URLs require an unexpired HMAC signature", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-voice-"));
  try {
    const service = new TranscriptionService(testConfig(root));
    const fileName = `${crypto.randomUUID()}.webm`;
    fs.writeFileSync(path.join(service.audioRoot, fileName), Buffer.from("audio-test"));
    const signed = new URL(service.signedAudioUrl(fileName));
    const app = express();
    app.get("/codex-web/api/transcription-audio/:fileName", (req, res) => service.serveSignedAudio(req, res));
    const response = await request(app).get(`${signed.pathname}${signed.search}`).expect(200);
    assert.equal(Buffer.from(response.body).toString("utf8"), "audio-test");
    signed.searchParams.set("signature", "0".repeat(64));
    await request(app).get(`${signed.pathname}${signed.search}`).expect(404);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Omni SSE extraction ignores malformed and terminal events", () => {
  assert.equal(textFromSseLine('data: {"choices":[{"delta":{"content":"你好"}}]}'), "你好");
  assert.equal(textFromSseLine('data: {"choices":[{"delta":{"content":[{"text":" world"}]}}]}'), " world");
  assert.equal(textFromSseLine("data: [DONE]"), "");
  assert.equal(textFromSseLine("event: message"), "");
  assert.equal(textFromSseLine("data: not-json"), "");
});

test("transcription context is normalized, capped and marked as non-audio data", () => {
  const prompt = buildTranscriptionSystemPrompt({
    draftText: `  修改\u0000   Excel  `,
    attachmentNames: Array.from({ length: 20 }, (_, index) => `附件-${index}.xlsx`),
    recentMessages: [{ role: "system", content: "系统内容不应进入" }, { role: "user", content: "用户上下文" }],
  });
  assert.match(prompt, /修改 Excel/);
  assert.match(prompt, /附件-11\.xlsx/);
  assert.doesNotMatch(prompt, /附件-12\.xlsx/);
  assert.doesNotMatch(prompt, /系统内容不应进入/);
  assert.match(prompt, /禁止把未说出口的上下文复制进结果/);
  assert.ok(prompt.length < 4000);
});
