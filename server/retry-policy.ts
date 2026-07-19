export const TRANSIENT_RETRY_DELAYS_MS = [15_000, 45_000, 120_000] as const;

export function upstreamErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isRetryableUpstreamError(error: unknown): boolean {
  const message = upstreamErrorMessage(error).toLowerCase();
  return [
    /stream disconnected before completion/,
    /websocket closed by server before response\.completed/,
    /falling back from websockets? to https transport/,
    /connection reset by peer/,
    /socket hang up/,
    /\beconnreset\b/,
    /\betimedout\b/,
    /request timed out/,
    /server[- ]overload/,
    /model (?:is )?at capacity/,
    /\bhttp (?:429|502|503|504)\b/,
  ].some((pattern) => pattern.test(message));
}

type RetryNotice = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  message: string;
};

export async function runWithTransientRetries<T>(
  operation: (retryAttempt: number) => Promise<T>,
  options: {
    signal: AbortSignal;
    delaysMs?: readonly number[];
    onRetry?: (notice: RetryNotice) => void;
  },
): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  for (let retryAttempt = 0; ; retryAttempt += 1) {
    try {
      return await operation(retryAttempt);
    } catch (error) {
      if (options.signal.aborted) throw abortError();
      if (retryAttempt >= delays.length || !isRetryableUpstreamError(error)) throw error;
      const delayMs = delays[retryAttempt];
      options.onRetry?.({
        attempt: retryAttempt + 1,
        maxAttempts: delays.length,
        delayMs,
        message: upstreamErrorMessage(error),
      });
      await abortableDelay(delayMs, options.signal);
    }
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", cancelled, { once: true });
    function done() { signal.removeEventListener("abort", cancelled); resolve(); }
    function cancelled() { clearTimeout(timer); reject(abortError()); }
  });
}

function abortError(): Error {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}
