export type ChronologicalMessage = { id: string; created_at: string };
export type ConversationMessage = ChronologicalMessage & { role: "user" | "assistant" | "system" };

export function mergeMessagePages<T extends ChronologicalMessage>(...pages: ReadonlyArray<readonly T[]>): T[] {
  const messages = new Map<string, T>();
  for (const page of pages) {
    for (const message of page) messages.set(message.id, message);
  }
  return [...messages.values()].sort((left, right) => (
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
  ));
}

export function preservePrependedScrollTop(previousTop: number, previousHeight: number, nextHeight: number): number {
  return Math.max(0, previousTop + nextHeight - previousHeight);
}

export function resolveUnreadScrollTarget(
  messages: readonly ConversationMessage[],
  unreadAnchorMessageId: string,
  hasOlderMessages: boolean,
): string | null {
  const anchorIndex = messages.findIndex((message) => message.id === unreadAnchorMessageId);
  if (anchorIndex < 0) return null;
  const prompt = messages.slice(0, anchorIndex).findLast((message) => message.role === "user");
  if (prompt) return prompt.id;
  return hasOlderMessages ? null : unreadAnchorMessageId;
}
