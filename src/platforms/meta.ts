import { apiFetch, qs } from '../lib/http';
import { PlatformError } from '../lib/errors';
import { utcDate } from '../lib/time';
import { id } from '../lib/ids';
import type { Account, Channel, MetricRow } from '../types';
import { credentialsFor } from './credentials';
import {
  described,
  describedPublish,
  emptyMetric,
  type AdsAdapter,
  type OrganicAdapter,
  type PublishInput,
  type PublishResult,
  type VerifyResult,
} from './types';

/**
 * Meta covers four surfaces on one credential: Facebook Pages, Instagram,
 * Threads (a separate host, same token family) and Meta Ads.
 *
 * Docs:
 *  - Instagram Content Publishing: developers.facebook.com/docs/instagram-platform/content-publishing
 *  - Threads API:                  developers.facebook.com/docs/threads
 *  - Marketing API:                developers.facebook.com/docs/marketing-apis
 */
const GRAPH = 'https://graph.facebook.com';
const THREADS = 'https://graph.threads.net';
const V = 'v23.0';
const TV = 'v1.0';

function graphUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
  const query = qs(params);
  return `${GRAPH}/${V}/${path}${query ? `?${query}` : ''}`;
}

function form(fields: Record<string, unknown>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    fd.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return fd;
}

// ---------------------------------------------------------------------------
// Instagram (feed posts and Reels)
// ---------------------------------------------------------------------------

export const instagramOrganic: OrganicAdapter = {
  channel: 'instagram',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<{ id?: string; username?: string }>(
      graphUrl(account.external_id, { fields: 'id,username', access_token: token }),
      { channel: 'instagram' },
    );
    return {
      ok: Boolean(data.id),
      detail: data.username ? `connected as @${data.username}` : 'no username returned',
    };
  },

  async publish(ctx, account, input): Promise<PublishResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const caption = captionFor(input);
    const primary = input.media[0];
    if (!primary) {
      throw new PlatformError('instagram', 'Instagram requires at least one image or video', 400);
    }

    if (ctx.dryRun) {
      return describedPublish('instagram.publish', {
        ig_user_id: account.external_id,
        caption,
        media: input.media.map((m) => m.url),
      });
    }

    // Two-step: create a container, then publish it. Video containers need a
    // moment to finish processing before publish will accept them.
    const container = await apiFetch<{ id?: string }>(
      graphUrl(`${account.external_id}/media`),
      {
        channel: 'instagram',
        method: 'POST',
        body: form({
          ...(primary.kind === 'video'
            ? { media_type: 'REELS', video_url: primary.url }
            : { image_url: primary.url }),
          caption,
          access_token: token,
        }),
      },
    );
    if (!container.id) {
      throw new PlatformError('instagram', 'media container creation returned no id', 502);
    }

    if (primary.kind === 'video') {
      await waitForContainer(container.id, token);
    }

    const published = await apiFetch<{ id?: string }>(
      graphUrl(`${account.external_id}/media_publish`),
      {
        channel: 'instagram',
        method: 'POST',
        body: form({ creation_id: container.id, access_token: token }),
      },
    );
    if (!published.id) {
      throw new PlatformError('instagram', 'media_publish returned no id', 502);
    }
    return {
      externalId: published.id,
      permalink: `https://www.instagram.com/p/${published.id}/`,
      raw: published,
    };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const ids = opts.externalIds ?? [];
    const out: MetricRow[] = [];
    for (const mediaId of ids) {
      try {
        const data = await apiFetch<{ data?: MetaInsight[] }>(
          graphUrl(`${mediaId}/insights`, {
            metric: 'reach,likes,comments,saved,shares,views',
            access_token: token,
          }),
          { channel: 'instagram', tolerate: [400] },
        );
        out.push(toPostMetric('instagram', mediaId, data.data ?? [], opts.until));
      } catch (err) {
        ctx.log.warn('instagram insights failed', { media_id: mediaId, err: String(err) });
      }
    }
    return out;
  },
};

async function waitForContainer(containerId: string, token: string): Promise<void> {
  // Reels transcoding is usually seconds. Give up rather than hold the Worker
  // open, the publisher will retry the job.
  for (let attempt = 0; attempt < 10; attempt++) {
    const status = await apiFetch<{ status_code?: string }>(
      graphUrl(containerId, { fields: 'status_code', access_token: token }),
      { channel: 'instagram' },
    );
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR') {
      throw new PlatformError('instagram', 'media container failed to process', 502, {
        container_id: containerId,
      });
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new PlatformError('instagram', 'media container still processing, will retry', 503, {
    container_id: containerId,
  });
}

// ---------------------------------------------------------------------------
// Facebook Page
// ---------------------------------------------------------------------------

export const facebookOrganic: OrganicAdapter = {
  channel: 'facebook',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<{ id?: string; name?: string }>(
      graphUrl(account.external_id, { fields: 'id,name', access_token: token }),
      { channel: 'facebook' },
    );
    return { ok: Boolean(data.id), detail: data.name ? `page: ${data.name}` : 'no page name' };
  },

  async publish(ctx, account, input): Promise<PublishResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const message = captionFor(input);
    const photo = input.media.find((m) => m.kind === 'image');
    const video = input.media.find((m) => m.kind === 'video');

    if (ctx.dryRun) {
      return describedPublish('facebook.publish', {
        page_id: account.external_id,
        message,
        media: input.media.map((m) => m.url),
        link: input.linkUrl,
      });
    }

    let endpoint = `${account.external_id}/feed`;
    let body: Record<string, unknown> = { message, access_token: token };
    if (video) {
      endpoint = `${account.external_id}/videos`;
      body = { description: message, file_url: video.url, access_token: token };
    } else if (photo) {
      endpoint = `${account.external_id}/photos`;
      body = { caption: message, url: photo.url, access_token: token };
    } else if (input.linkUrl) {
      body.link = input.linkUrl;
    }

    const res = await apiFetch<{ id?: string; post_id?: string }>(graphUrl(endpoint), {
      channel: 'facebook',
      method: 'POST',
      body: form(body),
    });
    const postId = res.post_id ?? res.id;
    if (!postId) throw new PlatformError('facebook', 'publish returned no post id', 502);
    return {
      externalId: postId,
      permalink: `https://www.facebook.com/${postId}`,
      raw: res,
    };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const out: MetricRow[] = [];
    for (const postId of opts.externalIds ?? []) {
      try {
        const data = await apiFetch<{ data?: MetaInsight[] }>(
          graphUrl(`${postId}/insights`, {
            metric: 'post_impressions,post_impressions_unique,post_clicks,post_engaged_users',
            access_token: token,
          }),
          { channel: 'facebook', tolerate: [400] },
        );
        out.push(toPostMetric('facebook', postId, data.data ?? [], opts.until));
      } catch (err) {
        ctx.log.warn('facebook insights failed', { post_id: postId, err: String(err) });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export const threadsOrganic: OrganicAdapter = {
  channel: 'threads',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<{ id?: string; username?: string }>(
      `${THREADS}/${TV}/${account.external_id}?${qs({
        fields: 'id,username',
        access_token: token,
      })}`,
      { channel: 'threads' },
    );
    return {
      ok: Boolean(data.id),
      detail: data.username ? `connected as @${data.username}` : 'no username returned',
    };
  },

  async publish(ctx, account, input): Promise<PublishResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    // Threads caps a post at 500 characters and treats hashtags as noise.
    const text = captionFor(input, { maxHashtags: 1 }).slice(0, 500);
    const primary = input.media[0];

    if (ctx.dryRun) {
      return describedPublish('threads.publish', {
        threads_user_id: account.external_id,
        text,
        media: input.media.map((m) => m.url),
      });
    }

    const container = await apiFetch<{ id?: string }>(
      `${THREADS}/${TV}/${account.external_id}/threads`,
      {
        channel: 'threads',
        method: 'POST',
        body: form({
          media_type: primary ? (primary.kind === 'video' ? 'VIDEO' : 'IMAGE') : 'TEXT',
          text,
          ...(primary?.kind === 'image' ? { image_url: primary.url } : {}),
          ...(primary?.kind === 'video' ? { video_url: primary.url } : {}),
          access_token: token,
        }),
      },
    );
    if (!container.id) throw new PlatformError('threads', 'container returned no id', 502);

    // Threads asks for a short pause between container creation and publish.
    if (primary) await new Promise((r) => setTimeout(r, 5000));

    const published = await apiFetch<{ id?: string }>(
      `${THREADS}/${TV}/${account.external_id}/threads_publish`,
      {
        channel: 'threads',
        method: 'POST',
        body: form({ creation_id: container.id, access_token: token }),
      },
    );
    if (!published.id) throw new PlatformError('threads', 'publish returned no id', 502);
    return { externalId: published.id, raw: published };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const out: MetricRow[] = [];
    for (const mediaId of opts.externalIds ?? []) {
      try {
        const data = await apiFetch<{ data?: MetaInsight[] }>(
          `${THREADS}/${TV}/${mediaId}/insights?${qs({
            metric: 'views,likes,replies,reposts,quotes',
            access_token: token,
          })}`,
          { channel: 'threads', tolerate: [400] },
        );
        out.push(toPostMetric('threads', mediaId, data.data ?? [], opts.until));
      } catch (err) {
        ctx.log.warn('threads insights failed', { media_id: mediaId, err: String(err) });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Meta Ads (Facebook and Instagram placements)
// ---------------------------------------------------------------------------

const OBJECTIVE_MAP: Record<string, string> = {
  conversions: 'OUTCOME_SALES',
  traffic: 'OUTCOME_TRAFFIC',
  awareness: 'OUTCOME_AWARENESS',
  leads: 'OUTCOME_LEADS',
  app_installs: 'OUTCOME_APP_PROMOTION',
};

export const metaAds: AdsAdapter = {
  channel: 'facebook',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<{ id?: string; name?: string; account_status?: number }>(
      graphUrl(actId(account), {
        fields: 'id,name,account_status,currency',
        access_token: token,
      }),
      { channel: 'facebook' },
    );
    return {
      ok: data.account_status === 1,
      detail: `ad account ${data.name ?? account.external_id}, status ${data.account_status ?? 'unknown'}`,
    };
  },

  async createCampaign(ctx, account, spec) {
    const token = credentialsFor(ctx.env, account).accessToken;
    const objective = OBJECTIVE_MAP[spec.objective] ?? 'OUTCOME_TRAFFIC';

    if (ctx.dryRun) {
      return {
        campaign: described('meta.createCampaign', { ...spec, objective }),
        adSet: described('meta.createAdSet', { daily_budget: spec.dailyBudgetCents }),
      };
    }

    const campaign = await apiFetch<{ id?: string }>(graphUrl(`${actId(account)}/campaigns`), {
      channel: 'facebook',
      method: 'POST',
      body: form({
        name: spec.name,
        objective,
        // New campaigns start paused. The mediabuyer activates them only after
        // the guardian and the human approval have both cleared.
        status: 'PAUSED',
        special_ad_categories: [],
        access_token: token,
      }),
    });
    if (!campaign.id) throw new PlatformError('facebook', 'campaign create returned no id', 502);

    const adSet = await apiFetch<{ id?: string }>(graphUrl(`${actId(account)}/adsets`), {
      channel: 'facebook',
      method: 'POST',
      body: form({
        name: `${spec.name} / adset`,
        campaign_id: campaign.id,
        daily_budget: spec.dailyBudgetCents,
        billing_event: 'IMPRESSIONS',
        optimization_goal: objective === 'OUTCOME_SALES' ? 'OFFSITE_CONVERSIONS' : 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: spec.targeting,
        status: 'PAUSED',
        ...(spec.startsAt ? { start_time: spec.startsAt } : {}),
        ...(spec.endsAt ? { end_time: spec.endsAt } : {}),
        access_token: token,
      }),
    });
    if (!adSet.id) throw new PlatformError('facebook', 'adset create returned no id', 502);

    return {
      campaign: { externalId: campaign.id, raw: campaign },
      adSet: { externalId: adSet.id, raw: adSet },
    };
  },

  async createAd(ctx, account, adSetExternalId, spec) {
    const token = credentialsFor(ctx.env, account).accessToken;
    const pageId = readMeta(account.meta, 'page_id');

    if (ctx.dryRun) {
      return described('meta.createAd', { adSetExternalId, ...spec });
    }
    if (!pageId) {
      throw new PlatformError('facebook', 'ad account meta is missing page_id', 400, {
        hint: 'Set accounts.meta to {"page_id":"..."} for the Meta ads account',
      });
    }

    const creative = await apiFetch<{ id?: string }>(graphUrl(`${actId(account)}/adcreatives`), {
      channel: 'facebook',
      method: 'POST',
      body: form({
        name: `creative ${id('cr')}`,
        object_story_spec: {
          page_id: pageId,
          link_data: {
            message: spec.body,
            link: spec.landingUrl,
            ...(spec.headline ? { name: spec.headline } : {}),
            ...(spec.cta ? { call_to_action: { type: metaCta(spec.cta), value: { link: spec.landingUrl } } } : {}),
            ...(spec.media[0] ? { picture: spec.media[0].url } : {}),
          },
        },
        access_token: token,
      }),
    });
    if (!creative.id) throw new PlatformError('facebook', 'adcreative returned no id', 502);

    const ad = await apiFetch<{ id?: string }>(graphUrl(`${actId(account)}/ads`), {
      channel: 'facebook',
      method: 'POST',
      body: form({
        name: spec.headline ?? 'BBA ad',
        adset_id: adSetExternalId,
        creative: { creative_id: creative.id },
        status: 'PAUSED',
        access_token: token,
      }),
    });
    if (!ad.id) throw new PlatformError('facebook', 'ad create returned no id', 502);
    return { externalId: ad.id, raw: ad };
  },

  async setBudget(ctx, account, adSetExternalId, dailyBudgetCents) {
    const token = credentialsFor(ctx.env, account).accessToken;
    if (ctx.dryRun) {
      return described('meta.setBudget', { adSetExternalId, dailyBudgetCents });
    }
    await apiFetch(graphUrl(adSetExternalId), {
      channel: 'facebook',
      method: 'POST',
      body: form({ daily_budget: dailyBudgetCents, access_token: token }),
    });
    return { externalId: adSetExternalId };
  },

  async setStatus(ctx, account, externalId, status) {
    const token = credentialsFor(ctx.env, account).accessToken;
    if (ctx.dryRun) return described('meta.setStatus', { externalId, status });
    await apiFetch(graphUrl(externalId), {
      channel: 'facebook',
      method: 'POST',
      body: form({ status: status === 'active' ? 'ACTIVE' : 'PAUSED', access_token: token }),
    });
    return { externalId };
  },

  async report(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<{ data?: MetaInsightRow[] }>(
      graphUrl(`${actId(account)}/insights`, {
        level: 'adset',
        fields:
          'adset_id,impressions,reach,clicks,spend,actions,action_values,date_start,date_stop',
        time_range: JSON.stringify({ since: opts.since, until: opts.until }),
        time_increment: 1,
        limit: 500,
        access_token: token,
      }),
      { channel: 'facebook' },
    );
    return (data.data ?? []).map((row) => {
      const metric = emptyMetric(
        'campaign_channel',
        row.adset_id ?? account.external_id,
        'facebook',
        row.date_start ?? opts.until,
      );
      metric.impressions = int(row.impressions);
      metric.reach = int(row.reach);
      metric.clicks = int(row.clicks);
      metric.spend_cents = Math.round(float(row.spend) * 100);
      metric.currency = account.currency;
      metric.conversions = actionValue(row.actions, ['purchase', 'offsite_conversion.fb_pixel_purchase', 'lead']);
      metric.revenue_cents = Math.round(
        actionFloat(row.action_values, ['purchase', 'offsite_conversion.fb_pixel_purchase']) * 100,
      );
      metric.raw = row;
      return metric;
    });
  },
};

/** accounts.meta is operator-supplied JSON, so never let it throw. */
function readMeta(meta: string, key: string): string | undefined {
  try {
    const obj = JSON.parse(meta) as Record<string, unknown>;
    return typeof obj[key] === 'string' ? (obj[key] as string) : undefined;
  } catch {
    return undefined;
  }
}

function actId(account: Account): string {
  return account.external_id.startsWith('act_') ? account.external_id : `act_${account.external_id}`;
}

function metaCta(cta: string): string {
  const normalized = cta.toUpperCase().replace(/[^A-Z]/g, '_');
  const allowed = new Set([
    'SHOP_NOW',
    'LEARN_MORE',
    'SIGN_UP',
    'SUBSCRIBE',
    'BOOK_TRAVEL',
    'DOWNLOAD',
    'GET_OFFER',
    'CONTACT_US',
    'APPLY_NOW',
  ]);
  return allowed.has(normalized) ? normalized : 'LEARN_MORE';
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

interface MetaInsight {
  name?: string;
  values?: { value?: number }[];
}

interface MetaInsightRow {
  adset_id?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  spend?: string;
  date_start?: string;
  date_stop?: string;
  actions?: { action_type?: string; value?: string }[];
  action_values?: { action_type?: string; value?: string }[];
}

function toPostMetric(
  channel: Channel,
  externalId: string,
  insights: MetaInsight[],
  date: string,
): MetricRow {
  const metric = emptyMetric('post', externalId, channel, utcDate(date));
  const get = (name: string) =>
    Number(insights.find((i) => i.name === name)?.values?.[0]?.value ?? 0);

  metric.impressions = get('impressions') || get('views') || get('post_impressions');
  metric.reach = get('reach') || get('post_impressions_unique');
  metric.clicks = get('post_clicks');
  metric.video_views = get('views');
  metric.engagements =
    get('likes') +
    get('comments') +
    get('saved') +
    get('shares') +
    get('replies') +
    get('reposts') +
    get('quotes') +
    get('post_engaged_users');
  return metric;
}

function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function float(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function actionValue(
  actions: { action_type?: string; value?: string }[] | undefined,
  types: string[],
): number {
  if (!actions) return 0;
  return actions
    .filter((a) => a.action_type && types.includes(a.action_type))
    .reduce((sum, a) => sum + int(a.value), 0);
}

function actionFloat(
  actions: { action_type?: string; value?: string }[] | undefined,
  types: string[],
): number {
  if (!actions) return 0;
  return actions
    .filter((a) => a.action_type && types.includes(a.action_type))
    .reduce((sum, a) => sum + float(a.value), 0);
}

/** Assemble the visible caption from hook, body, CTA and hashtags. */
export function captionFor(input: PublishInput, opts: { maxHashtags?: number } = {}): string {
  const parts: string[] = [];
  if (input.hook) parts.push(input.hook.trim());
  parts.push(input.body.trim());
  if (input.cta) parts.push(input.cta.trim());
  const tags = (input.hashtags ?? []).slice(0, opts.maxHashtags ?? 30);
  if (tags.length) {
    parts.push(tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' '));
  }
  return parts.filter(Boolean).join('\n\n');
}
