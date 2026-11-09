import fs from "node:fs";
import https from "node:https";
import type { Agent } from "node:http";
import proxyAgent from "https-proxy-agent";
import { setTimeout as delay } from "node:timers/promises";
import { selectCodexEgress } from "./codex-egress.js";
import type { AppConfig } from "./config.js";

export class TranscriptionError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
export type TranscriptionOptions = { signal?: AbortSignal; onUsage?: (seconds: number) => void };
type Timing = (stage: string, details?: Record<string, number | string | boolean>) => void;
export const OPENAI_TRANSCRIPTION_MAX_BYTES = 25_000_000;

/** Explicit transport: Node fetch does not inherit HTTP_PROXY on supported runtimes.
 * Use the same CONNECT agent as Live, never redirect credentials or fall back direct. */
export async function openaiTranscriptionFetch(url: string, init: RequestInit, proxy: string): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(90_000);
  let proxyUrl: string | null = proxy === "direct" ? null : proxy;
  if (proxy === "codex") {
    const egress = await selectCodexEgress({ signal });
    if (!egress.proxyUrl) throw new TranscriptionError("语音识别代理未配置，已停止连接。", 503);
    proxyUrl = egress.proxyUrl;
  }
  const agent = proxyUrl ? proxyAgent(proxyUrl) : undefined;
  try {
    const wire = new Request(url, init);
    const body = Buffer.from(await wire.arrayBuffer());
    return await new Promise<Response>((resolve, reject) => {
      const req = https.request(url, {
        method: "POST", agent: agent as unknown as Agent | undefined, signal,
        headers: { ...Object.fromEntries(wire.headers), "content-length": String(body.length) },
      }, res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { res.destroy(new Error("Transcription response too large")); return; }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(new Response([204,205,304].includes(res.statusCode ?? 0) ? null : Buffer.concat(chunks), {
              status: res.statusCode ?? 502,
              headers: Object.fromEntries(Object.entries(res.headers).filter(([,v]) => v !== undefined).map(([k,v]) => [k, String(v)])),
            }));
          } catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  } finally { agent?.destroy(); }
}

export async function transcribeOpenAI(input: {
  config: AppConfig; filePath: string; prompt: string; keywords: string[];
  timing: Timing; retryDelays: readonly number[]; options: TranscriptionOptions;
  fetch?: typeof fetch;
}): Promise<string> {
  const { config, options, timing } = input;
  if (fs.statSync(input.filePath).size > OPENAI_TRANSCRIPTION_MAX_BYTES)
    throw new TranscriptionError("转换后的录音超过语音服务 25 MB 文件限制，请缩短录音后重试。", 413);
  if (!config.openaiTranscriptionModel.trim()) throw new TranscriptionError("OpenAI 语音识别模型尚未配置。", 503);
  let key = config.openaiTranscriptionApiKey;
  if (!key && config.openaiTranscriptionApiKeyFile) {
    try { key = fs.readFileSync(config.openaiTranscriptionApiKeyFile, "utf8").trim(); }
    catch { throw new TranscriptionError("OpenAI 语音识别密钥文件不可读取，请联系管理员。", 503); }
  }
  if (!key) throw new TranscriptionError("OpenAI 语音识别服务尚未配置密钥。", 503);
  const form = new FormData();
  form.append("model", config.openaiTranscriptionModel);
  form.append("response_format", "json");
  if (input.prompt) form.append("prompt", input.prompt);
  for (const keyword of input.keywords) form.append("keywords[]", keyword);
  for (const language of config.openaiTranscriptionLanguages) form.append("languages[]", language);
  form.append("file", new Blob([fs.readFileSync(input.filePath)], { type: "audio/wav" }), "recording.wav");
  const deadline = Date.now() + config.transcriptionTimeoutMs;
  const url = `${config.openaiTranscriptionBaseUrl}/audio/transcriptions`;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(90_000, deadline - Date.now()))), ...(options.signal ? [options.signal] : [])]);
    let failure: TranscriptionError;
    let retryable = false;
    try {
      timing("upstream_start", { attempt: attempt + 1, provider: "openai" });
      const init = { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal };
      const response = await (input.fetch ? input.fetch(url, init) : openaiTranscriptionFetch(url, init, config.openaiTranscriptionProxy));
      timing("upstream_headers", { attempt: attempt + 1, status: response.status });
      const payload = await response.json().catch(() => null) as { text?: unknown; usage?: { type?: string; seconds?: number }; error?: { code?: string; type?: string } } | null;
      if (response.ok) {
        if (payload?.usage?.type === "duration" && typeof payload.usage.seconds === "number" && Number.isFinite(payload.usage.seconds) && payload.usage.seconds >= 0) {
          options.onUsage?.(payload.usage.seconds);
          timing("usage", { usageType: "duration", seconds: payload.usage.seconds });
        }
        if (typeof payload?.text !== "string" || !payload.text.trim()) throw new TranscriptionError("没有识别到清晰语音，请靠近麦克风后重试。", 422);
        return payload.text.trim();
      }
      const exhausted = payload?.error?.code === "credit_balance_exhausted" || payload?.error?.code === "insufficient_quota" || payload?.error?.type === "insufficient_quota";
      if (exhausted) throw new TranscriptionError("OpenAI 语音识别额度不足，请联系管理员补充额度后重试。", 503);
      if ([401,403].includes(response.status)) throw new TranscriptionError("OpenAI 语音识别认证或访问权限失败，请联系管理员。", 503);
      if ([400,422].includes(response.status)) throw new TranscriptionError("OpenAI 拒绝了语音识别参数或音频，请管理员检查模型、关键词和语言配置。", 502);
      if (response.status === 413) throw new TranscriptionError("录音超过 OpenAI 文件大小限制，请缩短录音后重试。", 413);
      retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      failure = new TranscriptionError(response.status === 429 ? "语音识别请求过于频繁，请稍后重试。" : "OpenAI 语音识别服务暂时不可用，请稍后重试。", response.status === 429 ? 429 : 503);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof TranscriptionError) throw error;
      retryable = true;
      failure = new TranscriptionError(signal.aborted ? "语音识别超时，请稍后重试。" : "暂时无法连接语音识别服务，请稍后重试。", 503);
    }
    const wait = input.retryDelays[attempt];
    if (!retryable || wait === undefined || Date.now() + wait >= deadline) throw failure;
    timing("upstream_retry", { attempt: attempt + 1, status: failure.status });
    await delay(wait, undefined, { signal: options.signal });
  }
}
