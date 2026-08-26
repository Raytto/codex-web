import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import request from "supertest";
import { loadConfig } from "../server/config.js";
import {
  buildTranscriptionContextBlock,
  buildTranscriptionSystemPrompt,
  estimateTranscriptionTokens,
  textFromSseLine,
  TranscriptionService,
  type TranscriptionContext,
  type TranscriptionImagePreparer,
} from "../server/transcription.js";

function testConfig(dataRoot: string) {
  return loadConfig({
    dataRoot,
    sessionSecret: "voice-test-session-secret-at-least-32-characters",
    publicBaseUrl: "https://example.test",
    dashscopeApiKey: "test-dashscope-key",
    dashscopeBaseUrl: "https://example.test/v1",
    transcriptionPollMs: 0,
    transcriptionTimeoutMs: 1000,
  });
}

function testWavBuffer(durationMs = 500): Buffer {
  const sampleRate = 8_000;
  const sampleCount = Math.round(sampleRate * durationMs / 1_000);
  const output = Buffer.alloc(44 + sampleCount * 2);
  output.write("RIFF", 0, 4, "ascii");
  output.writeUInt32LE(36 + sampleCount * 2, 4);
  output.write("WAVEfmt ", 8, 8, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, 4, "ascii");
  output.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    output.writeInt16LE(Math.round(Math.sin(index * Math.PI * 2 * 220 / sampleRate) * 3_000), 44 + index * 2);
  }
  return output;
}

function testWavWithLongSilence(): Buffer {
  const output = testWavBuffer(8_000);
  const sampleRate = output.readUInt32LE(24);
  const sampleCount = output.readUInt32LE(40) / 2;
  let noiseState = 0x23456789;
  for (let index = 0; index < sampleCount; index += 1) {
    const voiced = index < sampleRate || index >= sampleRate * 7;
    noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) | 0;
    const sample = voiced
      ? Math.round(Math.sin(index * Math.PI * 2 * 220 / sampleRate) * 3_000)
      : Math.round((((noiseState >>> 0) / 0xffffffff) * 2 - 1) * 50);
    output.writeInt16LE(sample, 44 + index * 2);
  }
  return output;
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
    const converter = async (_inputPath: string, outputPath: string) => { fs.writeFileSync(outputPath, testWavBuffer()); };
    let imageOptions: { tokenBudget: number; maxImages: number; maxImageBytes: number } | undefined;
    const imagePreparer: TranscriptionImagePreparer = async (attachments, options) => {
      imageOptions = options;
      return attachments.filter((attachment) => attachment.mimeType?.startsWith("image/")).slice(0, options.maxImages).map((attachment, index) => ({
        name: attachment.name,
        dataUrl: `data:image/png;base64,image-${index}`,
        tokenCost: 80,
      }));
    };
    const service = new TranscriptionService(testConfig(root), fakeFetch, converter, imagePreparer);
    const fileName = `${crypto.randomUUID()}.webm`;
    fs.writeFileSync(path.join(service.audioRoot, fileName), Buffer.from("webm-test"));
    const firstText = path.join(root, "first.txt");
    const secondText = path.join(root, "second.md");
    fs.writeFileSync(firstText, `第一份文件开头 AlphaName ${"甲".repeat(2000)} 第一份文件结尾不应出现`, "utf8");
    fs.writeFileSync(secondText, `第二份文件开头 BetaName ${"乙".repeat(2000)} 第二份文件结尾不应出现`, "utf8");
    assert.equal(await service.transcribe(fileName, {
      draftText: "修改刚才上传的 PowerPoint",
      attachmentNames: ["first.txt", "second.md", "one.png", "two.png", "three.png"],
      attachments: [
        { name: "first.txt", filePath: firstText, mimeType: "text/plain", size: fs.statSync(firstText).size },
        { name: "second.md", filePath: secondText, mimeType: "text/markdown", size: fs.statSync(secondText).size },
        { name: "one.png", filePath: "/unused/one.png", mimeType: "image/png", size: 100 },
        { name: "two.png", filePath: "/unused/two.png", mimeType: "image/png", size: 100 },
        { name: "three.png", filePath: "/unused/three.png", mimeType: "image/png", size: 100 },
      ],
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
    assert.match(submitted.messages[0].content, /第一份文件开头 AlphaName/);
    assert.match(submitted.messages[0].content, /第二份文件开头 BetaName/);
    assert.doesNotMatch(submitted.messages[0].content, /文件结尾不应出现/);
    assert.doesNotMatch(submitted.messages[0].content, /这条太旧不应保留/);
    assert.equal(imageOptions?.tokenBudget, 500);
    assert.equal(imageOptions?.maxImages, 2);
    assert.equal(submitted.messages[1].content.filter((part: { type: string }) => part.type === "image_url").length, 2);
    assert.match(submitted.messages[1].content[2].input_audio.data, /\/api\/transcription-audio\/[0-9a-f-]+\.wav/);
    assert.equal(submitted.messages[1].content[2].input_audio.format, "wav");
    assert.match(submitted.messages[1].content[3].text, /不要描述图片/);
    assert.equal(fs.existsSync(path.join(service.audioRoot, fileName.replace(/\.webm$/, ".wav"))), false);
    assert.deepEqual(fs.readdirSync(service.audioRoot).filter((name) => name.endsWith(".wav")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Qwen Omni receives the silence-trimmed WAV and temporary audio is removed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-voice-"));
  const logs = t.mock.method(console, "info", () => undefined);
  let submittedDurationMs = 0;
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const submitted = JSON.parse(String(init?.body));
    const audioUrl = new URL(submitted.messages[1].content[0].input_audio.data);
    const fileName = path.basename(audioUrl.pathname);
    const audio = fs.readFileSync(path.join(root, "voice-input", fileName));
    submittedDurationMs = Math.round(audio.readUInt32LE(40) / 2 * 1_000 / audio.readUInt32LE(24));
    return new Response('data: {"choices":[{"delta":{"content":"裁剪成功"}}]}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  try {
    const service = new TranscriptionService(
      testConfig(root),
      fakeFetch,
      async (_inputPath, outputPath) => fs.writeFileSync(outputPath, testWavWithLongSilence()),
      async () => [],
    );
    const sourceName = `${crypto.randomUUID()}.webm`;
    fs.writeFileSync(path.join(service.audioRoot, sourceName), Buffer.from("webm-test"));
    assert.equal(await service.transcribe(sourceName), "裁剪成功");
    assert.ok(Math.abs(submittedDurationMs - 2_700) <= 50);
    assert.equal(logs.mock.callCount(), 1);
    assert.ok(logs.mock.calls[0].arguments[1].removedDurationMs > 5_200);
    assert.deepEqual(fs.readdirSync(service.audioRoot), [sourceName]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Qwen Omni retries transient HTTP and connection failures within a bounded attempt budget", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-voice-"));
  const warnings = t.mock.method(console, "warn", () => undefined);
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response("temporarily unavailable", { status: 503, headers: { "x-request-id": "voice-retry-test" } });
    if (calls === 2) throw new DOMException("timed out", "TimeoutError");
    return new Response('data: {"choices":[{"delta":{"content":"恢复成功"}}]}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  try {
    const service = new TranscriptionService(
      testConfig(root),
      fakeFetch,
      async () => undefined,
      async () => [],
      [0, 0],
    );
    const fileName = `${crypto.randomUUID()}.wav`;
    fs.writeFileSync(path.join(service.audioRoot, fileName), testWavBuffer());
    assert.equal(await service.transcribe(fileName), "恢复成功");
    assert.equal(calls, 3);
    assert.equal(warnings.mock.callCount(), 2);
    assert.equal(warnings.mock.calls[0].arguments[1].upstreamStatus, 503);
    assert.equal(warnings.mock.calls[0].arguments[1].requestId, "voice-retry-test");
    assert.equal(warnings.mock.calls[1].arguments[1].errorName, "TimeoutError");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Qwen Omni does not retry permanent upstream errors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-voice-"));
  const warnings = t.mock.method(console, "warn", () => undefined);
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  try {
    const service = new TranscriptionService(
      testConfig(root),
      fakeFetch,
      async () => undefined,
      async () => [],
      [0, 0],
    );
    const fileName = `${crypto.randomUUID()}.wav`;
    fs.writeFileSync(path.join(service.audioRoot, fileName), testWavBuffer());
    await assert.rejects(() => service.transcribe(fileName), /语音识别服务暂时不可用/);
    assert.equal(calls, 1);
    assert.equal(warnings.mock.callCount(), 0);
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
    app.get("/api/transcription-audio/:fileName", (req, res) => service.serveSignedAudio(req, res));
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
  const context: TranscriptionContext = {
    draftText: `  修改\u0000   Excel  `,
    attachmentNames: Array.from({ length: 20 }, (_, index) => `附件-${index}.xlsx`),
    attachmentTexts: [
      { name: "甲.txt", content: `甲文件开头 ${"甲".repeat(2000)} 甲文件末尾` },
      { name: "乙.txt", content: `乙文件开头 ${"乙".repeat(2000)} 乙文件末尾` },
    ],
    recentMessages: [{ role: "system", content: "系统内容不应进入" }, { role: "user", content: "用户上下文" }],
    personalizedTerms: ["Codex Web", "Example Product"],
  };
  const prompt = buildTranscriptionSystemPrompt(context, 500, 80);
  const contextBlock = buildTranscriptionContextBlock(context, 500);
  assert.match(prompt, /修改 Excel/);
  assert.doesNotMatch(prompt, /附件-12\.xlsx/);
  assert.doesNotMatch(prompt, /系统内容不应进入/);
  assert.match(prompt, /甲文件开头/);
  assert.match(prompt, /乙文件开头/);
  assert.doesNotMatch(prompt, /甲文件末尾|乙文件末尾/);
  assert.match(prompt, /禁止把未说出口的上下文复制进结果/);
  assert.match(prompt, /Codex Web/);
  assert.doesNotMatch(prompt, /CWA|历史项目/);
  assert.match(prompt, /不得因为词表存在就把任何词插入转写/);
  assert.ok(estimateTranscriptionTokens(contextBlock) <= 500);
  assert.ok(prompt.length < 2500);
});

test("personalized lexicon includes only desired canonical terms and no historical ASR errors", () => {
  const prompt = buildTranscriptionSystemPrompt({
    personalizedTerms: ["会话"],
    recentMessages: [{ role: "user", content: "请打开刚才的会话" }],
  }, 500, 80);
  assert.match(prompt, /只包含希望优先保留的常用标准术语/);
  assert.match(prompt, /会话/);
  assert.doesNotMatch(prompt, /绘画|历史错误样例.*绘画/);
});
