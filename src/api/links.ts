import type { Env } from '../env';
import { first } from '../lib/db';
import type { Channel, Offer } from '../types';

/**
 * Tracked click-through links on go.bbanetwork.org.
 *
 * Attribution only works if the click carries the channel and campaign all the
 * way through to the Stripe checkout session. Sending ads straight at the
 * landing page loses that, and the analyst then records every sale as
 * unattributed and the optimizer allocates on clicks instead of money.
 *
 * So ads point here instead, and this redirects to the real landing page with
 * the parameters appended. The landing page copies them onto the checkout
 * session; see docs/connecting-accounts.md.
 */

export interface LinkParams {
  channel?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  /** paid for ads, social for organic posts. */
  medium?: 'paid' | 'social' | null;
  /** Creative id, so a winning variant can be identified after the fact. */
  variant?: string | null;
}

/** The link an ad or a post should actually point at. */
export function buildTrackedLink(
  linkBase: string,
  offerSlug: string,
  params: LinkParams = {},
): string {
  const url = new URL(`/go/${encodeURIComponent(offerSlug)}`, ensureOrigin(linkBase));
  if (params.channel) url.searchParams.set('ch', params.channel);
  if (params.campaignId) url.searchParams.set('c', params.campaignId);
  if (params.medium) url.searchParams.set('m', params.medium);
  if (params.variant) url.searchParams.set('v', params.variant);
  return url.toString();
}

/**
 * Apply the tracking parameters to the destination.
 *
 * The destination always comes from the offers table, never from the request,
 * so there is no way to turn this into an open redirect.
 */
export function applyTracking(landingUrl: string, params: LinkParams): string {
  const url = new URL(landingUrl);
  const medium = params.medium ?? 'paid';

  if (params.channel) {
    url.searchParams.set('utm_source', params.channel);
    url.searchParams.set('bba_channel', params.channel);
  }
  url.searchParams.set('utm_medium', medium);
  if (params.campaignName ?? params.campaignId) {
    url.searchParams.set('utm_campaign', (params.campaignName ?? params.campaignId)!);
  }
  // The one the analyst actually keys attribution on.
  if (params.campaignId) url.searchParams.set('bba_campaign_id', params.campaignId);
  if (params.variant) url.searchParams.set('utm_content', params.variant);
  return url.toString();
}

/**
 * Handle GET /go/<offer-slug>. Unauthenticated by necessity: this is where the
 * ads point.
 *
 * The offer lookup is cached in KV so a click storm does not become a D1 read
 * per click, and nothing is written on this path at all. Click counts come
 * from the platforms during the metrics sync, which is more accurate than
 * anything measured here and cannot be inflated by a crawler.
 */
export async function handleGoLink(env: Env, url: URL, slug: string): Promise<Response> {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/i.test(slug)) {
    return new Response('not found', { status: 404 });
  }

  const cacheKey = `offer_link:${slug}`;
  let landingUrl = await env.CACHE.get(cacheKey);
  if (!landingUrl) {
    const offer = await first<Pick<Offer, 'landing_url' | 'status'>>(
      env,
      'SELECT landing_url, status FROM offers WHERE slug = ?',
      slug,
    );
    if (!offer || offer.status !== 'active') {
      return new Response('not found', { status: 404 });
    }
    landingUrl = offer.landing_url;
    await env.CACHE.put(cacheKey, landingUrl, { expirationTtl: 300 });
  }

  let destination: string;
  try {
    destination = applyTracking(landingUrl, {
      channel: url.searchParams.get('ch'),
      campaignId: url.searchParams.get('c'),
      medium: url.searchParams.get('m') === 'social' ? 'social' : 'paid',
      variant: url.searchParams.get('v'),
    });
  } catch {
    // A malformed landing_url should not take the link down.
    destination = landingUrl;
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: destination,
      // Ad platforms re-crawl destinations. Let them, but do not let a CDN
      // pin one campaign's parameters for every other campaign.
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer-when-downgrade',
    },
  });
}

/** Resolve the link base, falling back to the Worker origin. */
export function linkBase(env: Env): string {
  const configured = typeof env.LINK_BASE_URL === 'string' ? env.LINK_BASE_URL : '';
  return configured || env.PUBLIC_BASE_URL || '';
}

/** Convenience for the agents: the tracked link for an offer on a channel. */
export function offerLink(
  env: Env,
  offer: Pick<Offer, 'slug' | 'landing_url'>,
  params: LinkParams,
): string {
  const base = linkBase(env);
  // With no link domain configured, fall back to the raw landing page with the
  // parameters attached rather than producing a link that goes nowhere.
  if (!base) {
    try {
      return applyTracking(offer.landing_url, params);
    } catch {
      return offer.landing_url;
    }
  }
  return buildTrackedLink(base, offer.slug, params);
}

function ensureOrigin(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
}

export type { Channel };
