import { describe, expect, it } from 'vitest';
import { isUnfundedOrUnauthorised, researchDecision } from '../src/agents/scout';

/**
 * The scout used to be the single point of failure for everything that writes.
 * On this deployment it failed on every attempt it ever made, eleven of them,
 * against an unfunded account, and opened a new error incident each time.
 *
 * Two things fix that and both are pure, so they are tested directly.
 */
describe('research decision', () => {
  it('does not call a model when the claim list is already loaded', () => {
    const d = researchDecision({ claimsOnFile: 34, hasKey: true });
    expect(d.act).toBe(false);
    expect(d.reason).toContain('34 claims already on file');
  });

  it('re-derives when explicitly forced, even with claims on file', () => {
    expect(researchDecision({ claimsOnFile: 34, hasKey: true, force: true }).act).toBe(true);
  });

  it('skips rather than fails when there is no claim list and no model', () => {
    const d = researchDecision({ claimsOnFile: 0, hasKey: false });
    expect(d.act).toBe(false);
    expect(d.reason).toContain('build-claims');
  });

  it('still researches when there is nothing on file and a model to ask', () => {
    expect(researchDecision({ claimsOnFile: 0, hasKey: true }).act).toBe(true);
  });
});

describe('unfunded account detection', () => {
  // The exact string this deployment returned, eleven times.
  const real =
    'PlatformError: POST https://api.anthropic.com/v1/messages failed with 400 — upstream: ' +
    '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is ' +
    'too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

  it('recognises the error that actually happened', () => {
    expect(isUnfundedOrUnauthorised(real)).toBe(true);
  });

  it('recognises a rejected key', () => {
    expect(isUnfundedOrUnauthorised('failed with 401 invalid x-api-key')).toBe(true);
  });

  it('does not swallow a real bug', () => {
    expect(isUnfundedOrUnauthorised(new TypeError('reading undefined of claims'))).toBe(false);
    expect(isUnfundedOrUnauthorised('failed with 500 upstream: internal server error')).toBe(false);
    expect(isUnfundedOrUnauthorised('failed with 529 overloaded_error')).toBe(false);
  });
});
