export type ChronologicalMessage = { id: string; created_at: string };

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
