import { describe, expect, it } from 'vitest';
import { baseBody, MODELS } from '../src/integrations/anthropic';
import { describeError, PlatformError } from '../src/lib/errors';

/**
 * Claude 5 removed the sampling parameters and rejects any request carrying
 * one with a 400 — it does not ignore them. This client sent `temperature` on
 * every call, so once the API key was finally set on 2026-08-27 every model
 * call in the system failed, and the failure looked like a key problem rather
 * than a request problem.
 *
 * These are cheap tests for an expensive silence.
 */

/** Parameters this generation of models rejects outright. */
const REJECTED = ['temperature', 'top_p', 'top_k', 'budget_tokens'];

describe('the Anthropic request body', () => {
  const opts = { system: 'be brief', prompt: 'hello' };

  for (const param of REJECTED) {
    it(`never sends ${param}`, () => {
      expect(Object.keys(baseBody(opts))).not.toContain(param);
    });
  }

  it('sends what the API does require', () => {
    const body = baseBody(opts);
    expect(body.model).toBe(MODELS.writer);
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('lets a caller choose the cheaper model and its own token ceiling', () => {
    const body = baseBody({ ...opts, model: MODELS.worker, maxTokens: 1500 });
    expect(body.model).toBe(MODELS.worker);
    expect(body.max_tokens).toBe(1500);
  });

  // If a model here is ever not a Claude 5, the rule above stops applying and
  // this test is the prompt to revisit it rather than assume.
  it('is aimed at the model generation those rules describe', () => {
    expect(Object.values(MODELS).every((m) => m.includes('-5'))).toBe(true);
  });
});

describe('describeError', () => {
  it('keeps the upstream body, which is the only part that says what is wrong', () => {
    const err = new PlatformError('anthropic', 'POST /v1/messages failed with 400', 400, {
      body: '{"error":{"message":"temperature: unexpected parameter"}}',
    });
    const described = describeError(err);
    expect(described).toContain('failed with 400');
    expect(described).toContain('unexpected parameter');
  });

  it('is unbothered by an error with no upstream body', () => {
    expect(describeError(new PlatformError('x', 'boom', 500))).toBe('PlatformError: boom');
  });

  it('still handles something that is not an Error at all', () => {
    expect(describeError('plain string')).toBe('plain string');
  });

  it('respects the limit it is given', () => {
    const err = new PlatformError('x', 'a'.repeat(200), 400, { body: 'b'.repeat(200) });
    expect(describeError(err, 50)).toHaveLength(50);
  });
});
