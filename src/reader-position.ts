export type ReaderPosition = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  updatedAt: number;
};

const STORAGE_PREFIX = "cww:file-reader-position:v1:";

function storageKey(fileId: string): string {
  return `${STORAGE_PREFIX}${fileId}`;
}

export function readReaderPosition(storage: Storage | null | undefined, fileId: string): ReaderPosition | null {
  if (!storage || !fileId) return null;
  try {
    const raw = storage.getItem(storageKey(fileId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ReaderPosition>;
    const scrollTop = typeof value.scrollTop === "number" ? value.scrollTop : NaN;
    const scrollHeight = typeof value.scrollHeight === "number" ? value.scrollHeight : NaN;
    const clientHeight = typeof value.clientHeight === "number" ? value.clientHeight : NaN;
    const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : 0;
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
    return {
      scrollTop,
      scrollHeight: Number.isFinite(scrollHeight) && scrollHeight >= 0 ? scrollHeight : 0,
      clientHeight: Number.isFinite(clientHeight) && clientHeight >= 0 ? clientHeight : 0,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeReaderPosition(storage: Storage | null | undefined, fileId: string, position: ReaderPosition): void {
  if (!storage || !fileId || !Number.isFinite(position.scrollTop) || position.scrollTop < 0) return;
  try {
    storage.setItem(storageKey(fileId), JSON.stringify(position));
  } catch {
    // Private browsing and quota errors must never break the reader.
  }
}

/** Rebase a saved offset when the viewport/document dimensions changed. */
export function restoreReaderScrollTop(saved: ReaderPosition, currentScrollHeight: number, currentClientHeight: number): number {
  const currentMax = Math.max(0, currentScrollHeight - currentClientHeight);
  if (currentMax === 0) return 0;
  const savedMax = Math.max(0, saved.scrollHeight - saved.clientHeight);
  if (savedMax > 0 && currentScrollHeight !== saved.scrollHeight) {
    return Math.min(currentMax, Math.max(0, (saved.scrollTop / savedMax) * currentMax));
  }
  return Math.min(currentMax, Math.max(0, saved.scrollTop));
}
