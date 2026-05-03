/**
 * Promise/timeout helper for ACP RPC calls.
 *
 * Races a promise against a timer; if the timer fires first, rejects with a
 * deterministic error containing the operation label and configured budget.
 * Accepts injected timer functions so tests can drive timers directly without
 * relying on `bun:test` fake timers (which interact poorly with subprocess IO).
 */

export interface TimerFns {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: TimerFns = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AcpTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`ACP ${label} timed out after ${timeoutMs}ms`);
    this.name = 'AcpTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  timerFns: TimerFns = realTimers,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let handle: unknown;
  let settled = false;
  const timer = new Promise<T>((_resolve, reject) => {
    handle = timerFns.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new AcpTimeoutError(label, timeoutMs));
      }
    }, timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => {
    settled = true;
    if (handle !== undefined) timerFns.clearTimeout(handle);
  });
}
