export type TranscriptionConfig = {
  transcriptionProvider: "dashscope" | "openai";
  openaiTranscriptionModel: string;
  openaiTranscriptionBaseUrl: string;
  openaiTranscriptionApiKey: string;
  openaiTranscriptionApiKeyFile: string;
  /** codex selects the existing primary/backup egress; direct must be explicit. */
  openaiTranscriptionProxy: string;
  openaiTranscriptionLanguages: string[];
};

export function loadTranscriptionConfig(overrides: Partial<TranscriptionConfig>): TranscriptionConfig {
  const provider = overrides.transcriptionProvider ?? process.env.TRANSCRIPTION_PROVIDER ?? "dashscope";
  if (provider !== "dashscope" && provider !== "openai") throw new Error("TRANSCRIPTION_PROVIDER must be dashscope or openai");
  const languages = overrides.openaiTranscriptionLanguages ?? (process.env.OPENAI_TRANSCRIPTION_LANGUAGES ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (languages.some(s => !/^[a-z]{2}$/.test(s))) throw new Error("OPENAI_TRANSCRIPTION_LANGUAGES must contain ISO-639-1 codes separated by commas");
  const base = (overrides.openaiTranscriptionBaseUrl ?? process.env.OPENAI_TRANSCRIPTION_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  let validBase = false;
  try {
    const url = new URL(base);
    validBase = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { /* never echo a potentially credential-bearing value */ }
  if (!validBase) throw new Error("OPENAI_TRANSCRIPTION_BASE_URL must be an HTTPS base URL without credentials or query");
  const proxy = overrides.openaiTranscriptionProxy ?? process.env.OPENAI_TRANSCRIPTION_PROXY ?? "direct";
  if (!["codex", "direct"].includes(proxy)) {
    let valid = false;
    try { valid = ["http:", "https:"].includes(new URL(proxy).protocol); } catch { /* sanitized error below */ }
    if (!valid) throw new Error("OPENAI_TRANSCRIPTION_PROXY must be codex, direct or an HTTP(S) proxy URL");
  }
  return {
    transcriptionProvider: provider,
    openaiTranscriptionModel: overrides.openaiTranscriptionModel ?? process.env.OPENAI_TRANSCRIPTION_MODEL ?? "",
    openaiTranscriptionBaseUrl: base,
    openaiTranscriptionApiKey: overrides.openaiTranscriptionApiKey ?? process.env.OPENAI_TRANSCRIPTION_API_KEY ?? "",
    openaiTranscriptionApiKeyFile: overrides.openaiTranscriptionApiKeyFile ?? process.env.OPENAI_TRANSCRIPTION_API_KEY_FILE ?? "",
    openaiTranscriptionProxy: proxy,
    openaiTranscriptionLanguages: [...new Set(languages)],
  };
}
