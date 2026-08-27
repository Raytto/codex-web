export const READER_RANGE_MAX_BYTES = 1 * 1024 * 1024;

export type ReaderByteRange = { start: number; end: number; length: number };

export type ReaderRangeErrorCode = "invalid" | "unsatisfiable" | "too_large";

export class ReaderRangeError extends Error {
  constructor(readonly code: ReaderRangeErrorCode, message: string, readonly resourceSize?: number) {
    super(message);
    this.name = "ReaderRangeError";
  }
}

/** Parse one RFC 9110 byte range.  Multi-range responses are intentionally
 * rejected: the reader only needs deterministic, bounded random access. */
export function parseReaderRange(value: string | undefined, size: number, maximum = READER_RANGE_MAX_BYTES): ReaderByteRange | null {
  if (!value) return null;
  if (!Number.isSafeInteger(size) || size < 0) throw new ReaderRangeError("invalid", "资源大小无效。");
  const match = /^bytes=([^,]+)$/i.exec(value.trim());
  if (!match) throw new ReaderRangeError("invalid", "只支持单个 bytes Range。");
  const spec = match[1].trim();
  const parts = spec.split("-", 2);
  if (parts.length !== 2) throw new ReaderRangeError("invalid", "Range 格式无效。");
  const [startText, endText] = parts;
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ReaderRangeError("invalid", "Range 后缀无效。");
    if (size === 0) throw new ReaderRangeError("unsatisfiable", "Range 超出资源范围。", size);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) throw new ReaderRangeError("unsatisfiable", "Range 超出资源范围。", size);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(end) || end < start) throw new ReaderRangeError("invalid", "Range 结束位置无效。");
    end = Math.min(end, size - 1);
  }
  const length = end - start + 1;
  if (length > maximum) throw new ReaderRangeError("too_large", `单次读取不能超过 ${maximum} 字节。`);
  return { start, end, length };
}

/** Per-user in-flight read limiter.  It is deliberately request scoped; a
 * released slot is always returned even when streaming fails. */
export class ReaderReadLimiter {
  private readonly active = new Map<string, number>();
  constructor(private readonly maximum = 5) {}

  tryAcquire(userId: string): (() => void) | null {
    const count = this.active.get(userId) ?? 0;
    if (count >= this.maximum) return null;
    this.active.set(userId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(userId) ?? 1) - 1;
      if (next > 0) this.active.set(userId, next);
      else this.active.delete(userId);
    };
  }

  activeFor(userId: string): number { return this.active.get(userId) ?? 0; }
}
