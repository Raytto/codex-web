import type { Session } from "./api";

const DEFAULT_TRANSIENT_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000];
const DEFAULT_UNAUTHENTICATED_RETRY_DELAYS_MS = [150, 500];

type SessionRecoveryOptions = {
  signal?: AbortSignal;
  transientRetryDelaysMs?: number[];
  unauthenticatedRetryDelaysMs?: number[];
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

function abortedError(): DOMException {
  return new DOMException("Session recovery was aborted", "AbortError");
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(delays: number[], attempt: number): number {
  if (!delays.length) return 0;
  return delays[Math.min(attempt, delays.length - 1)];
}

/**
 * Mobile browsers can resume a discarded tab before networking and cookies are
 * fully available. Do not turn that transient startup state into a false logout.
 */
export async function recoverBrowserSession(
  load: () => Promise<Session>,
  options: SessionRecoveryOptions = {},
): Promise<Session> {
  const transientDelays = options.transientRetryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS;
  const unauthenticatedDelays = options.unauthenticatedRetryDelaysMs ?? DEFAULT_UNAUTHENTICATED_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitForRetry;
  let transientAttempt = 0;
  let unauthenticatedAttempt = 0;

  while (!options.signal?.aborted) {
    try {
      const session = await load();
      transientAttempt = 0;
      if (session.authenticated || unauthenticatedAttempt >= unauthenticatedDelays.length) return session;
      await wait(retryDelay(unauthenticatedDelays, unauthenticatedAttempt), options.signal);
      unauthenticatedAttempt += 1;
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw abortedError();
      await wait(retryDelay(transientDelays, transientAttempt), options.signal);
      transientAttempt += 1;
    }
  }
  throw abortedError();
}
