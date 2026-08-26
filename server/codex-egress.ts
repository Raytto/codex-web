import http from "node:http";

export const CODEX_EGRESS_FALLBACK_NOTICE = "BossLive 日本节点 10 秒内不可用，本次任务已切换到备用日本服务器。";

export type CodexEgressKind = "primary" | "backup" | "unchanged";

export type CodexEgressChoice = {
  kind: CodexEgressKind;
  proxyUrl: string | null;
};

type EgressSelectionOptions = {
  primaryProxyUrl?: string;
  backupProxyUrl?: string;
  timeoutMs?: number;
  signal: AbortSignal;
  probe?: (proxyUrl: string, timeoutMs: number, signal: AbortSignal) => Promise<void>;
};

export async function selectCodexEgress(options: EgressSelectionOptions): Promise<CodexEgressChoice> {
  const primaryProxyUrl = normalizeProxyUrl(options.primaryProxyUrl ?? process.env.CODEX_PRIMARY_HTTP_PROXY);
  const backupProxyUrl = normalizeProxyUrl(options.backupProxyUrl ?? process.env.CODEX_BACKUP_HTTP_PROXY);
  if (!primaryProxyUrl) return { kind: "unchanged", proxyUrl: null };
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? Number(process.env.CODEX_PRIMARY_CONNECT_TIMEOUT_MS || "10000"));
  try {
    await (options.probe ?? probeOpenAIConnect)(primaryProxyUrl, timeoutMs, options.signal);
    return { kind: "primary", proxyUrl: primaryProxyUrl };
  } catch (error) {
    if (options.signal.aborted) throw abortError();
    if (!backupProxyUrl) throw error;
    return { kind: "backup", proxyUrl: backupProxyUrl };
  }
}

export function resolveCodexEgressChoice(
  kind: CodexEgressKind,
  primaryProxyUrl = process.env.CODEX_PRIMARY_HTTP_PROXY,
  backupProxyUrl = process.env.CODEX_BACKUP_HTTP_PROXY,
): CodexEgressChoice {
  if (kind === "unchanged") return { kind, proxyUrl: null };
  const proxyUrl = normalizeProxyUrl(kind === "primary" ? primaryProxyUrl : backupProxyUrl);
  if (!proxyUrl) throw new Error(`Pinned Codex ${kind} proxy is unavailable`);
  return { kind, proxyUrl };
}

export function applyCodexProxyEnvironment<T extends Record<string, string | undefined>>(env: T, proxyUrl: string | null): T {
  if (!proxyUrl) return env;
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) throw new Error("Invalid Codex proxy URL");
  const mutable = env as Record<string, string | undefined>;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    mutable[key] = normalized;
  }
  const bypass = ["127.0.0.1", "localhost", "::1"];
  const existing = mutable.NO_PROXY || mutable.no_proxy || "";
  const noProxy = [...new Set([...existing.split(",").map((value) => value.trim()).filter(Boolean), ...bypass])].join(",");
  mutable.NO_PROXY = noProxy;
  mutable.no_proxy = noProxy;
  return env;
}

export function probeOpenAIConnect(proxyUrl: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:") return Promise.reject(new Error("Codex egress probe requires an HTTP proxy"));
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || "80"),
      method: "CONNECT",
      path: "api.openai.com:443",
      headers: { Host: "api.openai.com:443" },
      timeout: timeoutMs,
    });
    const aborted = () => {
      const error = abortError();
      request.destroy(error);
      finish(error);
    };
    signal.addEventListener("abort", aborted, { once: true });
    request.once("connect", (response, socket) => {
      socket.destroy();
      if (response.statusCode === 200) finish();
      else finish(new Error(`Primary Codex egress CONNECT returned HTTP ${response.statusCode ?? "unknown"}`));
    });
    request.once("timeout", () => request.destroy(new Error(`Primary Codex egress timed out after ${timeoutMs}ms`)));
    request.once("error", (error) => finish(error));
    request.end();
  });
}

function normalizeProxyUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Invalid Codex proxy URL"); }
  if (parsed.protocol !== "http:" || !parsed.hostname || !parsed.port) throw new Error("Invalid Codex proxy URL");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeTimeout(value: number): number {
  return Number.isFinite(value) && value >= 1000 && value <= 30_000 ? Math.round(value) : 10_000;
}

function abortError(): Error {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}
