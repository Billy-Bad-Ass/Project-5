/** An error we chose to raise, with a stable code the caller can branch on. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** A platform API said no. Keeps the upstream status and body for triage. */
export class PlatformError extends AppError {
  constructor(
    public readonly channel: string,
    message: string,
    status: number,
    context: Record<string, unknown> = {},
  ) {
    super('platform_error', message, status, context);
    this.name = 'PlatformError';
  }

  /**
   * 429 and 5xx are worth another attempt. 4xx means the request itself is
   * wrong and retrying only burns rate limit.
   */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('config_error', message, 503, context);
    this.name = 'ConfigError';
  }
}

export class GuardrailError extends AppError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super('guardrail_blocked', message, 409, context);
    this.name = 'GuardrailError';
  }
}

/**
 * An error rendered with the part that actually says what went wrong.
 *
 * `String(err)` on a PlatformError gives "PlatformError: POST <url> failed
 * with 400" and stops there — the upstream body, which apiFetch went to the
 * trouble of capturing, is dropped. On 2026-08-27 that was the entire record
 * of why every model call was failing: a status, and no reason. Finding the
 * cause meant reading the client and the vendor's changelog instead of
 * reading the error.
 *
 * So anything that persists or logs an error uses this instead.
 */
export function describeError(err: unknown, limit = 1000): string {
  if (!(err instanceof AppError)) {
    return String(err).slice(0, limit);
  }
  const parts = [`${err.name}: ${err.message}`];
  const body = err.context.body;
  if (typeof body === 'string' && body.trim()) {
    parts.push(`upstream: ${body.trim()}`);
  }
  return parts.join(' — ').slice(0, limit);
}
