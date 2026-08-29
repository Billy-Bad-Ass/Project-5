import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { apiFetch } from '../src/lib/http';
import { PlatformError } from '../src/lib/errors';

/**
 * A write that fails without an answer must not be repeated.
 *
 * Publishing sends nine channels through apiFetch. Before this, a post that
 * the platform accepted but never acknowledged was retried three times here
 * and up to three more by the publisher — one scheduled post, up to nine
 * copies on the account.
 */

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  vi.restoreAllMocks();
});

/** Responds with `status` every time, counting the calls. */
function alwaysStatus(status: number) {
  const calls = { n: 0 };
  globalThis.fetch = vi.fn(async () => {
    calls.n++;
    return new Response('{"error":"upstream"}', { status });
  }) as unknown as typeof fetch;
  return calls;
}

function alwaysThrows() {
  const calls = { n: 0 };
  globalThis.fetch = vi.fn(async () => {
    calls.n++;
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  return calls;
}

const post = (extra: Record<string, unknown> = {}) =>
  apiFetch('https://example.invalid/publish', {
    method: 'POST',
    channel: 'instagram',
    attempts: 3,
    ...extra,
  });

describe('apiFetch does not repeat a write whose outcome is unknown', () => {
  it('stops after one attempt when a POST 500s', async () => {
    const calls = alwaysStatus(500);
    await expect(post()).rejects.toThrow(PlatformError);
    expect(calls.n).toBe(1);
  });

  it('stops after one attempt when a POST never answers', async () => {
    const calls = alwaysThrows();
    await expect(post()).rejects.toThrow(PlatformError);
    expect(calls.n).toBe(1);
  });

  it('marks that failure as unknown so the caller holds instead of retrying', async () => {
    alwaysStatus(502);
    const err = await post().catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).outcomeUnknown).toBe(true);
  });
});

describe('apiFetch still retries what is safe to retry', () => {
  it('retries a POST refused with 429 — the rate limiter did not run it', async () => {
    const calls = alwaysStatus(429);
    await expect(post()).rejects.toThrow(PlatformError);
    expect(calls.n).toBe(3);
  });

  it('does not treat a 429 as an unknown outcome', async () => {
    alwaysStatus(429);
    const err = await post().catch((e) => e);
    expect((err as PlatformError).outcomeUnknown).toBe(false);
  });

  it('retries a GET through 500s, because reading twice changes nothing', async () => {
    const calls = alwaysStatus(500);
    await expect(
      apiFetch('https://example.invalid/metrics', { channel: 'instagram', attempts: 3 }),
    ).rejects.toThrow(PlatformError);
    expect(calls.n).toBe(3);
  });

  it('retries a write the caller declares idempotent', async () => {
    const calls = alwaysStatus(500);
    await expect(post({ idempotent: true })).rejects.toThrow(PlatformError);
    expect(calls.n).toBe(3);
  });

  it('does not retry a 4xx on either a read or a write', async () => {
    const write = alwaysStatus(400);
    await expect(post()).rejects.toThrow(PlatformError);
    expect(write.n).toBe(1);

    const read = alwaysStatus(400);
    await expect(
      apiFetch('https://example.invalid/metrics', { channel: 'instagram', attempts: 3 }),
    ).rejects.toThrow(PlatformError);
    expect(read.n).toBe(1);
  });

  it('returns the body on success without any retry', async () => {
    const calls = { n: 0 };
    globalThis.fetch = vi.fn(async () => {
      calls.n++;
      return new Response('{"id":"abc"}', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(post()).resolves.toEqual({ id: 'abc' });
    expect(calls.n).toBe(1);
  });
});

/**
 * The adapter contract carries no idempotency key, on purpose.
 *
 * It used to, and the publisher's claim to be idempotent rested on it while
 * every adapter ignored it. Reintroducing a shared field that most adapters
 * would ignore rebuilds exactly that false floor, so this guards against it.
 *
 * Adding one for a platform *confirmed* to support it is fine — do it in that
 * adapter, against its own documentation, and set `idempotent: true` on the
 * apiFetch call. This test only fails the shared-contract version.
 */
describe('the shared publish contract makes no idempotency promise', () => {
  it('PublishInput declares no idempotency key', () => {
    const types = readFileSync(new URL('../src/platforms/types.ts', import.meta.url), 'utf8');
    const publishInput = types.slice(
      types.indexOf('export interface PublishInput'),
      types.indexOf('export interface PublishResult'),
    );
    expect(publishInput).not.toMatch(/^\s*idempotencyKey/m);
  });

  it('the publisher does not hand one to an adapter', () => {
    const publisher = readFileSync(new URL('../src/agents/publisher.ts', import.meta.url), 'utf8');
    expect(publisher).not.toMatch(/idempotencyKey:\s*post\./);
  });

  /** The database key is the one that does real work, and it stays. */
  it('keeps the unique column that stops a creative being scheduled twice', () => {
    const schema = readFileSync(new URL('../db/migrations/0001_init.sql', import.meta.url), 'utf8');
    expect(schema).toMatch(/idempotency_key\s+TEXT NOT NULL UNIQUE/);
  });
});
