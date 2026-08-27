import type { PDFDataRangeTransport } from "pdfjs-dist";

/**
 * Keep the browser-side PDF transport aligned with the server's hard byte
 * ceiling.  PDF.js may coalesce adjacent internal chunks into one logical
 * range, so this adapter splits that logical request into bounded HTTP
 * requests and joins the result before handing it back to PDF.js.
 */
export const READER_PDF_RANGE_BYTES = 1 * 1024 * 1024;

type TransportConstructor = new (
  length: number,
  initialData: Uint8Array | null,
  progressiveDone?: boolean,
  contentDispositionFilename?: string,
) => PDFDataRangeTransport;

export type ReaderPdfRangeTransportOptions = {
  url: string;
  length: number;
  filename?: string | null;
  maxRangeBytes?: number;
  maxConcurrent?: number;
  credentials?: RequestCredentials;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
};

type SlotWaiter = { resolve: () => void; reject: (error: unknown) => void };

function abortError(): Error {
  const error = new Error("PDF Range transport 已取消。");
  error.name = "AbortError";
  return error;
}

function responseError(status: number): Error {
  return new Error(`PDF Range 请求失败（HTTP ${status}）。`);
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger)) return null;
  return { start, end, total };
}

/**
 * Construct a PDFDataRangeTransport only after pdfjs-dist has been loaded.
 * Keeping the base class as an argument avoids pulling the PDF.js runtime into
 * the initial application chunk.
 */
export function createReaderPdfRangeTransport(
  BaseTransport: TransportConstructor,
  options: ReaderPdfRangeTransportOptions,
): PDFDataRangeTransport {
  if (!Number.isSafeInteger(options.length) || options.length <= 0) {
    throw new Error("PDF 文件大小无效。");
  }
  const requestedRangeBytes = Number(options.maxRangeBytes);
  const maxRangeBytes = Number.isSafeInteger(requestedRangeBytes) && requestedRangeBytes > 0
    ? Math.min(requestedRangeBytes, READER_PDF_RANGE_BYTES) : READER_PDF_RANGE_BYTES;
  const requestedConcurrency = Number(options.maxConcurrent);
  const maxConcurrent = Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(requestedConcurrency, 4) : 4;
  const fetchImpl = options.fetchImpl ?? fetch;

  class ReaderPdfRangeTransport extends BaseTransport {
    private stopped = false;
    private failed = false;
    private active = 0;
    private readonly waiters: SlotWaiter[] = [];
    private readonly controllers = new Set<AbortController>();
    /** Only in-flight ranges are retained; PDF.js owns the durable chunk cache. */
    private readonly inFlight = new Map<string, Promise<Uint8Array>>();

    constructor() {
      super(options.length, null, false, options.filename ?? undefined);
    }

    requestDataRange(begin: number, end: number): void {
      if (this.stopped || this.failed) return;
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > options.length) {
        this.fail(new Error("PDF Range 区间无效。"));
        return;
      }
      const segments: Array<[number, number]> = [];
      for (let cursor = begin; cursor < end; cursor += maxRangeBytes) {
        segments.push([cursor, Math.min(end, cursor + maxRangeBytes)]);
      }
      void Promise.all(segments.map(([segmentBegin, segmentEnd]) => this.segment(segmentBegin, segmentEnd)))
        .then((parts) => {
          if (this.stopped || this.failed) return;
          const joined = new Uint8Array(end - begin);
          let offset = 0;
          for (const part of parts) {
            joined.set(part, offset);
            offset += part.byteLength;
          }
          try {
            this.onDataRange(begin, joined);
          } catch (error) {
            this.fail(error);
          }
        })
        .catch((error: unknown) => this.fail(error));
    }

    abort(): void {
      if (this.stopped) return;
      this.stopped = true;
      const error = abortError();
      for (const controller of this.controllers) controller.abort(error);
      while (this.waiters.length) this.waiters.shift()?.reject(error);
      this.inFlight.clear();
    }

    private async acquireSlot(): Promise<void> {
      if (this.stopped) throw abortError();
      if (this.active < maxConcurrent) {
        this.active += 1;
        return;
      }
      await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
      if (this.stopped) throw abortError();
      this.active += 1;
    }

    private releaseSlot(): void {
      this.active = Math.max(0, this.active - 1);
      const waiter = this.waiters.shift();
      if (waiter) {
        // Transfer the slot directly to the waiter; acquireSlot increments it
        // after the promise resolves.
        waiter.resolve();
      }
    }

    private segment(begin: number, end: number): Promise<Uint8Array> {
      const key = `${begin}:${end}`;
      const existing = this.inFlight.get(key);
      if (existing) return existing;
      const request = this.fetchSegment(begin, end);
      this.inFlight.set(key, request);
      void request.finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      }).catch(() => undefined);
      return request;
    }

    private async fetchSegment(begin: number, end: number): Promise<Uint8Array> {
      await this.acquireSlot();
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        let response: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          response = await fetchImpl(this.url, {
            method: "GET",
            headers: { Range: `bytes=${begin}-${end - 1}` },
            credentials: options.credentials ?? "include",
            signal: controller.signal,
          });
          if (![202, 429, 503].includes(response.status) || attempt === 2) break;
          try { await response.body?.cancel(); } catch { /* the retry is still safe */ }
          const retryAfter = Number(response.headers.get("Retry-After"));
          const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(2_000, retryAfter * 1_000) : 250 * (attempt + 1);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            if (controller.signal.aborted) {
              clearTimeout(timer);
              reject(abortError());
              return;
            }
            controller.signal.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true });
          });
        }
        if (!response || response.status !== 206) throw responseError(response?.status ?? 0);
        const contentRange = parseContentRange(response.headers.get("Content-Range"));
        if (!contentRange || contentRange.start !== begin || contentRange.end !== end - 1 || contentRange.total !== options.length) {
          throw new Error("PDF Range 响应的 Content-Range 不匹配。");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== end - begin) throw new Error("PDF Range 响应长度不匹配。");
        return bytes;
      } finally {
        this.controllers.delete(controller);
        this.releaseSlot();
      }
    }

    private fail(error: unknown): void {
      if (this.stopped || this.failed) return;
      this.failed = true;
      this.abort();
      options.onError?.(error);
    }

    private get url(): string {
      return options.url;
    }
  }

  return new ReaderPdfRangeTransport();
}
