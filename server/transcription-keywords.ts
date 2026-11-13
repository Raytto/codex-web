export const TRANSCRIPTION_FIXED_TERMS = ['Codex Web','Codex','ChatGPT','CODEX_WEB','PowerPoint','PPT','Excel','Word','PDF','OpenAI','Qwen','Omni','DashScope','GitHub','Docker','Linux','Windows','TypeScript','JavaScript','Python'];
export const TRANSCRIPTION_MAX_KEYWORDS = 200;
/** A malformed literal is rejected whole, never repaired into a different hint. */
export function normalizeTranscriptionKeyword(term: unknown): string | null {
  if (typeof term !== 'string' || /[<>\r\n\u0000-\u001f\u007f]/.test(term)) return null;
  const value = term.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return value && value.length <= 160 && !/[<>\r\n\u0000-\u001f\u007f]/.test(value) ? value : null;
}
