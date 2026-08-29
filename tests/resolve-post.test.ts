import { describe, expect, it } from 'vitest';
import { resolutionFor } from '../src/api/resolve-post';

/**
 * The one endpoint that can mark a post published on a person's word rather
 * than a platform's. It exists because the publisher refuses to guess when a
 * platform accepts a post and never answers — but a way in for an honest
 * answer is also a way in for a wrong one, so the rule is narrow.
 */

const NOW = '2026-08-29T07:00:00.000Z';
const held = (body: Record<string, unknown>) => resolutionFor('needs_reconcile', body, NOW);

describe('only a held post can be resolved', () => {
  for (const status of ['scheduled', 'publishing', 'published', 'failed', 'cancelled']) {
    it(`refuses a ${status} post`, () => {
      const out = resolutionFor(status, { outcome: 'published' }, NOW);
      expect(out).toEqual({ error: `post is ${status}, not held for review`, status: 409 });
    });
  }

  it('accepts a held post', () => {
    expect(held({ outcome: 'cancelled' })).not.toHaveProperty('error');
  });
});

describe('the outcome has to be one of the two answers', () => {
  for (const outcome of [undefined, '', 'maybe', 'publishing', 42, null]) {
    it(`refuses ${JSON.stringify(outcome)}`, () => {
      const out = held({ outcome });
      expect(out).toHaveProperty('status', 400);
    });
  }
});

describe('it did not post', () => {
  it('cancels without inventing a published time', () => {
    expect(held({ outcome: 'cancelled' })).toEqual({
      patch: { status: 'cancelled', last_error: null },
    });
  });

  it('ignores a permalink on a cancellation', () => {
    const out = held({ outcome: 'cancelled', permalink: 'https://example.test/p/1' });
    expect(out).toEqual({ patch: { status: 'cancelled', last_error: null } });
  });
});

describe('it posted', () => {
  it('records the platform id and link when given', () => {
    const out = held({
      outcome: 'published',
      externalId: '18001',
      permalink: 'https://example.test/p/1',
    });
    expect(out).toEqual({
      patch: {
        status: 'published',
        last_error: null,
        published_at: NOW,
        external_id: '18001',
        permalink: 'https://example.test/p/1',
      },
    });
  });

  // Metrics are fetched by external id, so a post recorded without one is live
  // and permanently invisible to reporting. Say so rather than hide it.
  it('warns when no platform id was given', () => {
    const out = held({ outcome: 'published' });
    expect(out).toHaveProperty('warning');
    expect((out as { warning: string }).warning).toMatch(/metrics will not sync/);
  });

  it('does not warn when a platform id was given', () => {
    expect(held({ outcome: 'published', externalId: '18001' })).not.toHaveProperty('warning');
  });

  it('treats blank and non-string ids as absent rather than storing them', () => {
    for (const externalId of ['', '   ', 42, null, {}]) {
      const out = held({ outcome: 'published', externalId }) as { patch: Record<string, unknown> };
      expect(out.patch).not.toHaveProperty('external_id');
    }
  });

  it('trims what it stores', () => {
    const out = held({ outcome: 'published', externalId: '  18001  ' }) as {
      patch: Record<string, unknown>;
    };
    expect(out.patch.external_id).toBe('18001');
  });
});
