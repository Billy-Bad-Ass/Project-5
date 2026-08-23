import { PlatformError } from './errors';

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** Total attempts including the first. Only retryable failures retry. */
  attempts?: number;
  timeoutMs?: number;
  /** Channel name used to tag errors and rate limit buckets. */
  channel: string;
  /** Treat these upstream statuses as success and return the parsed body. */
  tolerate?: number[];
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * fetch with a timeout, bounded retries on 429/5xx, and errors that carry the
 * upstream body. Every platform client goes through this so retry and logging
 * behaviour is identical across channels.
 */
export async function apiFetch<T = unknown>(
  url: string,
  opts: FetchOptions,
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: PlatformError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body ?? null,
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = parseBody(text);

      if (res.ok || opts.tolerate?.includes(res.status)) {
        return parsed as T;
      }

      lastError = new PlatformError(
        opts.channel,
        `${opts.method ?? 'GET'} ${redactUrl(url)} failed with ${res.status}`,
        res.status,
        { body: truncate(text, 1200), attempt },
      );
      if (!lastError.retryable || attempt === attempts) throw lastError;
      await backoff(attempt, res.headers.get('retry-after'));
    } catch (err) {
      if (err instanceof PlatformError) {
        if (!err.retryable || attempt === attempts) throw err;
        lastError = err;
        continue;
      }
      // Network failure or abort.
      lastError = new PlatformError(
        opts.channel,
        `${opts.method ?? 'GET'} ${redactUrl(url)} threw: ${String(err)}`,
        599,
        { attempt },
      );
      if (attempt === attempts) throw lastError;
      await backoff(attempt, null);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new PlatformError(opts.channel, 'request failed', 599);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Exponential backoff with jitter, capped, honouring Retry-After. */
async function backoff(attempt: number, retryAfter: string | null): Promise<void> {
  let waitMs = Math.min(8_000, 2 ** attempt * 250);
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) waitMs = Math.min(20_000, seconds * 1000);
  }
  const jitter = Math.floor(Math.random() * 250);
  await new Promise((r) => setTimeout(r, waitMs + jitter));
}

/** Never let an access_token in a query string reach the logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/token|secret|key|signature|sig/i.test(key)) u.searchParams.set(key, 'REDACTED');
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...[${s.length - n} more]` : s;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
