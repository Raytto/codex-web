export const TRANSIENT_RETRY_DELAYS_MS = [15_000, 45_000, 120_000] as const;
export const MODEL_CAPACITY_INITIAL_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000] as const;
export const MODEL_CAPACITY_STEADY_RETRY_DELAY_MS = 5 * 60_000;
export const MODEL_CAPACITY_LONG_RETRY_AFTER_MS = 60 * 60_000;
export const MODEL_CAPACITY_LONG_RETRY_DELAY_MS = 30 * 60_000;

/** Capacity retries never exhaust. The elapsed clock starts at the first
 * capacity rejection so a user can stop the Job at any point via AbortSignal.
 */
export function modelCapacityRetryDelayMs(retryAttempt: number, elapsedMs: number): number {
  if (elapsedMs >= MODEL_CAPACITY_LONG_RETRY_AFTER_MS) return MODEL_CAPACITY_LONG_RETRY_DELAY_MS;
  return MODEL_CAPACITY_INITIAL_RETRY_DELAYS_MS[retryAttempt] ?? MODEL_CAPACITY_STEADY_RETRY_DELAY_MS;
}

export function upstreamErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isModelCapacityError(error: unknown): boolean {
  return /selected model is at capacity|model (?:is )?at capacity/i.test(upstreamErrorMessage(error));
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

/** Errors that mean the upstream transport itself broke after a turn started.
 * Model capacity is retryable before execution, but it is not a connection
 * interruption and must not be rewritten as one in the final job status.
 */
export function isConnectionInterruptionError(error: unknown): boolean {
  const message = upstreamErrorMessage(error).toLowerCase();
  return [
    /stream disconnected before completion/,
    /websocket closed by server before response\.completed/,
    /connection reset by peer/,
    /socket hang up/,
    /\beconnreset\b/,
    /\betimedout\b/,
    /request timed out/,
  ].some((pattern) => pattern.test(message));
}

type RetryNotice = {
  attempt: number;
  maxAttempts?: number;
  delayMs: number;
  message: string;
};

export async function runWithTransientRetries<T>(
  operation: (retryAttempt: number) => Promise<T>,
  options: {
    signal: AbortSignal;
    delaysMs?: readonly number[];
    capacityDelayMs?: (retryAttempt: number, elapsedMs: number) => number;
    onRetry?: (notice: RetryNotice) => void;
    /** A whole-operation retry is only safe while the caller can prove no work started. */
    canRetry?: (error: unknown, retryAttempt: number) => boolean;
  },
): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  let capacityRetryStartedAt: number | undefined;
  for (let retryAttempt = 0; ; retryAttempt += 1) {
    try {
      return await operation(retryAttempt);
    } catch (error) {
      if (options.signal.aborted) throw abortError();
      const capacityError = isModelCapacityError(error);
      if ((!capacityError && (!isRetryableUpstreamError(error) || retryAttempt >= delays.length))
        || options.canRetry?.(error, retryAttempt) === false) throw error;
      if (capacityError && capacityRetryStartedAt === undefined) capacityRetryStartedAt = Date.now();
      const delayMs = capacityError
        ? (options.capacityDelayMs ?? modelCapacityRetryDelayMs)(retryAttempt, Date.now() - capacityRetryStartedAt!)
        : delays[retryAttempt];
      options.onRetry?.({
        attempt: retryAttempt + 1,
        ...(!capacityError ? { maxAttempts: delays.length } : {}),
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
