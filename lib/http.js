'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A wall-clock budget for a serverless invocation.
 *
 * The old worker had no notion of time: it started an 80-draw backfill and hoped
 * it would finish before Vercel killed the function at maxDuration. When it did
 * not, the whole invocation was lost — including draws already fetched. Every
 * long loop now checks `deadline.expired` and stops cleanly with partial progress
 * committed.
 */
class Deadline {
  constructor(budgetMs) {
    this.startedAt = Date.now();
    this.budgetMs = budgetMs;
  }

  get elapsed() { return Date.now() - this.startedAt; }

  get remaining() { return Math.max(0, this.budgetMs - this.elapsed); }

  get expired() { return this.remaining <= 0; }

  /** True when there is not enough time left to be worth starting another unit. */
  spent(reserveMs = 0) { return this.remaining <= reserveMs; }
}

/** Run `fn` over `items` with at most `limit` in flight. Preserves input order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

class HttpError extends Error {
  constructor(status, message, { retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterToMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * fetch with a hard per-attempt timeout, capped exponential backoff, full
 * jitter, and Retry-After support.
 *
 * The timeout matters more than it looks: without AbortController a single
 * stalled connection to the lottery site could consume the entire function
 * duration while the remaining draws never got a chance to run.
 */
async function fetchWithRetry(url, {
  attempts = 3,
  timeoutMs = 12000,
  baseDelayMs = 200,
  maxDelayMs = 4000,
  deadline = null,
  headers = {},
  signal = null,
} = {}) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (deadline?.expired) throw lastError || new Error('Time budget exhausted before request completed');

    const controller = new AbortController();
    const budget = deadline ? Math.min(timeoutMs, deadline.remaining) : timeoutMs;
    const timer = setTimeout(() => controller.abort(), Math.max(1, budget));
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; HotSpotTracker/3.0)',
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          ...headers,
        },
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new HttpError(response.status, `Source responded ${response.status}`, {
          retryable,
          retryAfterMs: retryAfterToMs(response.headers.get('retry-after')),
        });
      }
      return response;
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts - 1;
      const fatal = error instanceof HttpError && !error.retryable;
      if (isLast || fatal) break;

      // Full jitter: random in [0, cap]. Avoids synchronised retry storms when
      // several draws fail at once behind the same concurrency pool.
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const wait = error?.retryAfterMs ?? Math.random() * cap;
      if (deadline && wait > deadline.remaining) break;
      await sleep(wait);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  throw lastError || new Error('Request failed');
}

module.exports = { sleep, Deadline, mapLimit, fetchWithRetry, HttpError, retryAfterToMs };
