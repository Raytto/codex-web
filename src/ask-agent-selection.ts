export const ASK_AGENT_SELECTION_MAX_CHARS = 4000;

export type SelectionRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function visibleSelectionBounds(rects: Iterable<SelectionRect>, viewport: SelectionRect): SelectionRect | null {
  let visible: SelectionRect | null = null;

  for (const rect of rects) {
    const clipped = {
      left: Math.max(rect.left, viewport.left),
      top: Math.max(rect.top, viewport.top),
      right: Math.min(rect.right, viewport.right),
      bottom: Math.min(rect.bottom, viewport.bottom),
    };
    if (clipped.right <= clipped.left || clipped.bottom <= clipped.top) continue;
    visible = visible
      ? {
          left: Math.min(visible.left, clipped.left),
          top: Math.min(visible.top, clipped.top),
          right: Math.max(visible.right, clipped.right),
          bottom: Math.max(visible.bottom, clipped.bottom),
        }
      : clipped;
  }

  return visible;
}

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
