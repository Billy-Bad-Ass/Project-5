import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCredentials } from '../src/platforms/credentials';
import { percentEncode } from '../src/lib/oauth1';
import { verifyWebhook, attributionFrom } from '../src/integrations/stripe';
import { CRON_PLANS } from '../src/orchestrator/schedule';
import { describeRegistry } from '../src/orchestrator/registry';
import { daysAgoUtc, isDue, localDate, utcDate } from '../src/lib/time';
import { CHANNEL_LIMITS } from '../src/editorial/voice';
import { CHANNELS } from '../src/types';

describe('credentials', () => {
  it('treats a bare string as an access token', () => {
    expect(parseCredentials('  abc123 ')).toEqual({ accessToken: 'abc123', extra: {} });
  });

  it('reads a JSON credential with refresh material', () => {
    const creds = parseCredentials(
      JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt',
        client_id: 'cid',
        client_secret: 'cs',
        login_customer_id: '123-456',
      }),
    );
    expect(creds.accessToken).toBe('at');
    expect(creds.refreshToken).toBe('rt');
    expect(creds.extra.login_customer_id).toBe('123-456');
  });

  it('rejects JSON with no access token', () => {
    expect(() => parseCredentials('{"refresh_token":"rt"}')).toThrow();
  });

  it('falls back to the raw value when the JSON is malformed', () => {
    expect(parseCredentials('{not json').accessToken).toBe('{not json');
  });
});

describe('oauth1 percent encoding', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(percentEncode("!*'()")).toBe('%21%2A%27%28%29');
  });

  it('leaves unreserved characters untouched', () => {
    expect(percentEncode('aZ0-._~')).toBe('aZ0-._~');
  });

  it('encodes spaces as %20, not +', () => {
    expect(percentEncode('a b')).toBe('a%20b');
  });
});

describe('stripe webhook verification', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  async function sign(timestamp: number, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('accepts a correctly signed recent payload', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${await sign(ts, payload)}`;
    expect(await verifyWebhook(payload, header, secret)).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${await sign(ts, payload)}`;
    expect(await verifyWebhook(`${payload} `, header, secret)).toBe(false);
  });

  it('rejects a replayed old signature', async () => {
    const ts = Math.floor(Date.now() / 1000) - 4000;
    const header = `t=${ts},v1=${await sign(ts, payload)}`;
    expect(await verifyWebhook(payload, header, secret)).toBe(false);
  });

  it('rejects a missing header', async () => {
    expect(await verifyWebhook(payload, null, secret)).toBe(false);
  });
});

describe('attribution', () => {
  it('reports unattributed when there is no metadata', () => {
    expect(attributionFrom(undefined).model).toBe('unattributed');
  });

  it('prefers an explicit campaign id over utm values', () => {
    const result = attributionFrom({ utm_source: 'tiktok', bba_campaign_id: 'cmp_1' });
    expect(result.model).toBe('manual');
    expect(result.campaignId).toBe('cmp_1');
  });

  it('falls back to utm values', () => {
    const result = attributionFrom({ utm_source: 'instagram', utm_campaign: 'spring' });
    expect(result.model).toBe('utm');
    expect(result.channel).toBe('instagram');
  });
});

describe('schedule wiring', () => {
  // A cron in wrangler.toml with no plan behind it fires and silently does
  // nothing, which is the worst possible failure for an automated system.
  const crons = [...readFileSync('wrangler.toml', 'utf8').matchAll(/^\s*"([^"]+)",?\s*(?:#.*)?$/gm)]
    .map((m) => m[1]!)
    .filter((value) => /^[\d*\/, -]+$/.test(value) && value.split(' ').length === 5);

  it('finds the cron list in wrangler.toml', () => {
    expect(crons.length).toBeGreaterThan(0);
  });

  it('has a plan for every cron trigger', () => {
    for (const cron of crons) {
      expect(Object.keys(CRON_PLANS)).toContain(cron);
    }
  });

  it('has a cron trigger for every plan', () => {
    for (const cron of Object.keys(CRON_PLANS)) {
      expect(crons).toContain(cron);
    }
  });

  it('only schedules tasks that a registered agent can actually run', () => {
    const registry = new Map(describeRegistry().map((a) => [a.agent, a.tasks]));
    const now = new Date().toISOString();
    for (const [cron, build] of Object.entries(CRON_PLANS)) {
      for (const task of build(now).tasks) {
        expect(registry.has(task.agent), `${cron} references unknown agent ${task.agent}`).toBe(true);
        expect(
          registry.get(task.agent)!,
          `${cron} references unknown task ${task.agent}.${task.task}`,
        ).toContain(task.task);
      }
    }
  });
});

describe('time helpers', () => {
  it('formats a UTC date', () => {
    expect(utcDate(new Date('2026-03-04T23:59:00Z'))).toBe('2026-03-04');
  });

  it('walks back whole days', () => {
    expect(daysAgoUtc(2, new Date('2026-03-04T12:00:00Z'))).toBe('2026-03-02');
  });

  it('treats a null schedule as due now', () => {
    expect(isDue(null)).toBe(true);
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(localDate('Not/AZone', new Date('2026-03-04T12:00:00Z'))).toBe('2026-03-04');
  });
});

describe('channel coverage', () => {
  it('has a character limit for every declared channel', () => {
    for (const channel of CHANNELS) {
      expect(CHANNEL_LIMITS[channel]?.maxChars).toBeGreaterThan(0);
    }
  });
});
