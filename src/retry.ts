export interface RetryOptions {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    isRetryable?: (err: unknown) => boolean;
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** Network failures, timeouts, 408, 429 and 5xx are worth retrying; 4xx validation errors are not. */
export function isTransientError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { status?: number; code?: string; name?: string; message?: string; cause?: unknown };
    if (typeof e.status === "number") return e.status === 408 || e.status === 429 || e.status >= 500;
    if (e.code && TRANSIENT_CODES.has(e.code)) return true;
    if (e.name === "AbortError" || e.name === "TimeoutError") return true;
    if (e.name === "TypeError" && /fetch failed/i.test(e.message ?? "")) return true;
    return e.cause ? isTransientError(e.cause) : false;
}

/** Retries `fn` with exponential backoff and full jitter. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const retries = options.retries ?? 3;
    const base = options.baseDelayMs ?? 500;
    const max = options.maxDelayMs ?? 8000;
    const retryable = options.isRetryable ?? isTransientError;
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            if (attempt >= retries || !retryable(err)) throw err;
            const delay = Math.random() * Math.min(max, base * 2 ** attempt);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}
