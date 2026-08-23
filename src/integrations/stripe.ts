import type { Env } from '../env';
import { apiFetch, qs } from '../lib/http';
import { ConfigError } from '../lib/errors';
import { insert } from '../lib/db';
import { id } from '../lib/ids';
import { nowIso } from '../lib/time';

/**
 * Stripe, used for two things:
 *  1. revenue truth for ROAS and CAC (the analyst agent), and
 *  2. attribution, by reading UTM values off the checkout session metadata.
 *
 * Only reads and webhook verification live here. Nothing in this system
 * initiates a charge or a refund.
 */
const API = 'https://api.stripe.com/v1';

function key(env: Env): string {
  const value = env.STRIPE_SECRET_KEY;
  if (!value) throw new ConfigError('STRIPE_SECRET_KEY is not set');
  return value;
}

function headers(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${key(env)}`,
    'stripe-version': '2025-01-27.acacia',
  };
}

export interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  created: number;
  refunded?: boolean;
  amount_refunded?: number;
  customer?: string | null;
  metadata?: Record<string, string>;
  payment_intent?: string | null;
}

/** Charges created in a window, paginated. */
export async function listCharges(
  env: Env,
  opts: { since: Date; until: Date; limit?: number },
): Promise<StripeCharge[]> {
  const out: StripeCharge[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < 20; page++) {
    const data = await apiFetch<{ data?: StripeCharge[]; has_more?: boolean }>(
      `${API}/charges?${qs({
        limit: opts.limit ?? 100,
        'created[gte]': Math.floor(opts.since.getTime() / 1000),
        'created[lte]': Math.floor(opts.until.getTime() / 1000),
        starting_after: startingAfter,
      })}`,
      { channel: 'stripe', headers: headers(env) },
    );
    const batch = data.data ?? [];
    out.push(...batch);
    if (!data.has_more || batch.length === 0) break;
    startingAfter = batch[batch.length - 1]?.id;
  }
  return out;
}

export async function balanceSummary(env: Env): Promise<{
  availableCents: number;
  pendingCents: number;
  currency: string;
}> {
  const data = await apiFetch<{
    available?: { amount: number; currency: string }[];
    pending?: { amount: number; currency: string }[];
  }>(`${API}/balance`, { channel: 'stripe', headers: headers(env) });
  const available = data.available?.[0];
  const pending = data.pending?.[0];
  return {
    availableCents: available?.amount ?? 0,
    pendingCents: pending?.amount ?? 0,
    currency: available?.currency ?? 'usd',
  };
}

/**
 * Attribution comes from metadata the landing page writes onto the checkout
 * session. Without it a sale is recorded as unattributed rather than guessed at.
 */
export interface Attribution {
  channel: string | null;
  campaignId: string | null;
  model: 'utm' | 'manual' | 'unattributed';
}

export function attributionFrom(metadata: Record<string, string> | undefined): Attribution {
  if (!metadata) return { channel: null, campaignId: null, model: 'unattributed' };
  const channel = metadata.utm_source ?? metadata.bba_channel ?? null;
  const campaignId = metadata.bba_campaign_id ?? metadata.utm_campaign ?? null;
  if (metadata.bba_campaign_id) {
    return { channel, campaignId, model: 'manual' };
  }
  if (channel || campaignId) return { channel, campaignId, model: 'utm' };
  return { channel: null, campaignId: null, model: 'unattributed' };
}

/**
 * Verify a Stripe webhook signature.
 *
 * Stripe signs `${timestamp}.${payload}` with HMAC-SHA256. Compare in constant
 * time and reject anything older than the tolerance to stop replays.
 */
export async function verifyWebhook(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, ...rest] = p.split('=');
      return [k?.trim() ?? '', rest.join('=')];
    }),
  );
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(`${timestamp}.${payload}`));
  const computed = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(computed, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Record a Stripe event as revenue. Ignores duplicates by stripe_event_id. */
export async function recordRevenueEvent(
  env: Env,
  event: {
    eventId: string;
    objectId: string;
    kind: 'payment' | 'refund' | 'subscription_cycle' | 'dispute';
    amountCents: number;
    currency: string;
    customerId?: string | null;
    occurredAt: string;
    metadata?: Record<string, string>;
    raw?: unknown;
  },
): Promise<void> {
  const attribution = attributionFrom(event.metadata);
  await insert(
    env,
    'revenue_events',
    {
      id: id('rev'),
      stripe_event_id: event.eventId,
      stripe_object_id: event.objectId,
      kind: event.kind,
      amount_cents: event.amountCents,
      currency: event.currency,
      customer_id: event.customerId ?? null,
      offer_id: null,
      attributed_channel: attribution.channel,
      attributed_campaign_id: attribution.campaignId,
      attribution_model: attribution.model,
      occurred_at: event.occurredAt,
      raw: JSON.stringify(event.raw ?? {}).slice(0, 20_000),
      created_at: nowIso(),
    },
    { orIgnore: true },
  );
}
