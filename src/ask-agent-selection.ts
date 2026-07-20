export const ASK_AGENT_SELECTION_MAX_CHARS = 4000;

export function normalizeAskAgentSelection(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildAskAgentDraft(currentDraft: string, selectedText: string): string {
  const normalized = normalizeAskAgentSelection(selectedText);
  if (!normalized) return currentDraft;

  const truncated = normalized.length > ASK_AGENT_SELECTION_MAX_CHARS;
  const excerpt = normalized.slice(0, ASK_AGENT_SELECTION_MAX_CHARS).trimEnd();
  const quote = excerpt.split("\n").map((line) => `> ${line}`).join("\n");
  const question = currentDraft.trim();
  const prompt = [
    "请结合以下引用回答我的问题：",
    "",
    quote,
    ...(truncated ? ["> …（引用内容过长，已截断）"] : []),
    "",
    ...(question ? ["我的问题：", question] : ["请解释这段引用。"]),
  ].join("\n");
  return prompt;
}
