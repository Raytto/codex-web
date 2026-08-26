import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection } from "./ask-agent-selection.js";

export type ParsedResponseAnnotatedRequest = {
  content: string;
  quoteExcerpt: string;
};

type ResponseAnnotation = {
  text: string;
  comment?: string;
};

const WRAPPED_REQUEST = /^#{1,6}[ \t]+Response annotations:[ \t]*\n[\s\S]*?<response-annotations>[ \t]*\n?([\s\S]*?)\n?<\/response-annotations>[ \t]*\n+#{1,6}[ \t]+My request for Codex:[ \t]*(?:\n([\s\S]*))?$/;

/**
 * Codex App stores "ask about this response" input as a transport wrapper.
 * Remote imports turn that transport representation back into Codex Web's
 * native quote + user-message fields. Malformed or partial wrappers are left
 * untouched by returning null.
 */
export function parseResponseAnnotatedRequest(value: string): ParsedResponseAnnotatedRequest | null {
  const normalizedValue = value.replace(/\r\n?/g, "\n").trim();
  const match = normalizedValue.match(WRAPPED_REQUEST);
  if (!match) return null;

  let rawAnnotations: unknown;
  try {
    rawAnnotations = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (!Array.isArray(rawAnnotations) || rawAnnotations.length === 0) return null;

  const annotations: ResponseAnnotation[] = [];
  for (const raw of rawAnnotations) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== "string" || (item.comment !== undefined && item.comment !== null && typeof item.comment !== "string")) return null;
    const text = normalizeAskAgentSelection(item.text);
    if (!text) return null;
    const comment = typeof item.comment === "string" ? normalizeAskAgentSelection(item.comment) : "";
    annotations.push({ text, ...(comment ? { comment } : {}) });
  }

  const quote = annotations.length === 1
    ? annotations[0].text
    : annotations.map((annotation, index) => `引用 ${index + 1}：\n${annotation.text}`).join("\n\n");
  const commentSections = annotations.flatMap((annotation, index) => annotation.comment
    ? [annotations.length === 1 ? annotation.comment : `对引用 ${index + 1} 的批注：\n${annotation.comment}`]
    : []);
  const request = normalizeAskAgentSelection(match[2] ?? "");
  if (request && !commentSections.includes(request)) commentSections.push(request);

  return {
    content: commentSections.join("\n\n"),
    quoteExcerpt: truncateQuoteExcerpt(quote),
  };
}

function truncateQuoteExcerpt(value: string): string {
  if (value.length <= ASK_AGENT_SELECTION_MAX_CHARS) return value;
  return `${value.slice(0, ASK_AGENT_SELECTION_MAX_CHARS - 1).trimEnd()}…`;
}
