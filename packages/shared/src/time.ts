export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Exponential backoff with jitter, used by queue retries and provider calls. */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 5 * 60_000): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = raw * 0.2 * Math.random();
  return Math.round(raw - raw * 0.1 + jitter);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs an async operation with retries and exponential backoff. */
export async function retry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; onError?: (error: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      options.onError?.(error, attempt);
      if (attempt < attempts) await sleep(backoffMs(attempt, options.baseMs ?? 250, 10_000));
    }
  }
  throw lastError;
}
