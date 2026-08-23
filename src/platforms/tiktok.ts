import { apiFetch, qs } from '../lib/http';
import { PlatformError } from '../lib/errors';
import { utcDate } from '../lib/time';
import type { MetricRow } from '../types';
import { credentialsFor } from './credentials';
import { captionFor } from './meta';
import {
  described,
  describedPublish,
  emptyMetric,
  type AdsAdapter,
  type OrganicAdapter,
  type VerifyResult,
} from './types';

/**
 * TikTok has two entirely separate APIs.
 *
 *  - Content Posting API (open.tiktokapis.com) for organic video and photo
 *    posts: developers.tiktok.com/doc/content-posting-api-get-started
 *  - Business API (business-api.tiktok.com) for ads:
 *    business-api.tiktok.com/portal/docs
 *
 * Note on the posting API: unaudited apps can only post to a private inbox for
 * the account owner to publish by hand. Direct Post needs the audited scope.
 */
const OPEN_API = 'https://open.tiktokapis.com/v2';
const BIZ_API = 'https://business-api.tiktok.com/open_api/v1.3';

export const tiktokOrganic: OrganicAdapter = {
  channel: 'tiktok',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<TikTokEnvelope<{ user?: { display_name?: string; open_id?: string } }>>(
      `${OPEN_API}/user/info/?${qs({ fields: 'open_id,display_name,username' })}`,
      { channel: 'tiktok', headers: { authorization: `Bearer ${token}` } },
    );
    assertOk('tiktok', data);
    const name = data.data?.user?.display_name;
    return { ok: Boolean(data.data?.user?.open_id), detail: name ? `connected as ${name}` : 'no user returned' };
  },

  async publish(ctx, account, input) {
    const token = credentialsFor(ctx.env, account).accessToken;
    const title = captionFor(input, { maxHashtags: 8 }).slice(0, 2200);
    const video = input.media.find((m) => m.kind === 'video');
    const photos = input.media.filter((m) => m.kind === 'image');

    if (ctx.dryRun) {
      return describedPublish('tiktok.publish', {
        open_id: account.external_id,
        title,
        media: input.media.map((m) => m.url),
      });
    }
    if (!video && photos.length === 0) {
      throw new PlatformError('tiktok', 'TikTok needs a video or at least one photo', 400);
    }

    const endpoint = video
      ? `${OPEN_API}/post/publish/video/init/`
      : `${OPEN_API}/post/publish/content/init/`;

    const body = video
      ? {
          post_info: {
            title,
            privacy_level: 'PUBLIC_TO_EVERYONE',
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
          },
          source_info: { source: 'PULL_FROM_URL', video_url: video.url },
        }
      : {
          media_type: 'PHOTO',
          post_mode: 'DIRECT_POST',
          post_info: {
            title: title.slice(0, 90),
            description: title,
            privacy_level: 'PUBLIC_TO_EVERYONE',
          },
          source_info: {
            source: 'PULL_FROM_URL',
            photo_cover_index: 0,
            photo_images: photos.map((p) => p.url),
          },
        };

    const init = await apiFetch<TikTokEnvelope<{ publish_id?: string }>>(endpoint, {
      channel: 'tiktok',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });
    assertOk('tiktok', init);
    const publishId = init.data?.publish_id;
    if (!publishId) throw new PlatformError('tiktok', 'publish init returned no publish_id', 502);

    // TikTok pulls the file itself, so the id we get back is the publish job.
    // The publisher records it and the metrics sync resolves the video id later.
    return { externalId: publishId, raw: init };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const ids = (opts.externalIds ?? []).filter((v) => !v.startsWith('dryrun:'));
    if (ids.length === 0) return [];

    const data = await apiFetch<TikTokEnvelope<{ videos?: TikTokVideo[] }>>(
      `${OPEN_API}/video/query/?${qs({
        fields: 'id,like_count,comment_count,share_count,view_count,create_time',
      })}`,
      {
        channel: 'tiktok',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ filters: { video_ids: ids.slice(0, 20) } }),
        tolerate: [400],
      },
    );

    return (data.data?.videos ?? []).map((v) => {
      const metric = emptyMetric('post', v.id ?? '', 'tiktok', utcDate(opts.until));
      metric.impressions = v.view_count ?? 0;
      metric.video_views = v.view_count ?? 0;
      metric.engagements = (v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0);
      metric.raw = v;
      return metric;
    });
  },
};

// ---------------------------------------------------------------------------
// TikTok Ads
// ---------------------------------------------------------------------------

const TIKTOK_OBJECTIVE: Record<string, string> = {
  conversions: 'CONVERSIONS',
  traffic: 'TRAFFIC',
  awareness: 'REACH',
  leads: 'LEAD_GENERATION',
  app_installs: 'APP_PROMOTION',
};

export const tiktokAds: AdsAdapter = {
  channel: 'tiktok',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<TikTokEnvelope<{ list?: { advertiser_name?: string; status?: string }[] }>>(
      `${BIZ_API}/advertiser/info/?${qs({
        advertiser_ids: JSON.stringify([account.external_id]),
      })}`,
      { channel: 'tiktok', headers: { 'Access-Token': token } },
    );
    assertOk('tiktok', data);
    const advertiser = data.data?.list?.[0];
    return {
      ok: Boolean(advertiser),
      detail: advertiser
        ? `advertiser ${advertiser.advertiser_name}, status ${advertiser.status}`
        : 'advertiser not found',
    };
  },

  async createCampaign(ctx, account, spec) {
    const token = credentialsFor(ctx.env, account).accessToken;
    const objective = TIKTOK_OBJECTIVE[spec.objective] ?? 'TRAFFIC';
    // TikTok budgets are in the account currency as a decimal, not cents.
    const dailyBudget = spec.dailyBudgetCents / 100;

    if (ctx.dryRun) {
      return {
        campaign: described('tiktok.createCampaign', { ...spec, objective }),
        adSet: described('tiktok.createAdGroup', { dailyBudget }),
      };
    }

    const campaign = await bizPost<{ campaign_id?: string }>(token, '/campaign/create/', {
      advertiser_id: account.external_id,
      campaign_name: spec.name,
      objective_type: objective,
      budget_mode: 'BUDGET_MODE_DAY',
      budget: dailyBudget,
      operation_status: 'DISABLE',
    });
    if (!campaign.campaign_id) {
      throw new PlatformError('tiktok', 'campaign create returned no campaign_id', 502);
    }

    const adGroup = await bizPost<{ adgroup_id?: string }>(token, '/adgroup/create/', {
      advertiser_id: account.external_id,
      campaign_id: campaign.campaign_id,
      adgroup_name: `${spec.name} / adgroup`,
      promotion_type: 'WEBSITE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      budget_mode: 'BUDGET_MODE_DAY',
      budget: dailyBudget,
      schedule_type: spec.endsAt ? 'SCHEDULE_START_END' : 'SCHEDULE_FROM_NOW',
      schedule_start_time: toTikTokTime(spec.startsAt),
      ...(spec.endsAt ? { schedule_end_time: toTikTokTime(spec.endsAt) } : {}),
      optimization_goal: objective === 'CONVERSIONS' ? 'CONVERT' : 'CLICK',
      billing_event: objective === 'CONVERSIONS' ? 'OCPM' : 'CPC',
      bid_type: 'BID_TYPE_NO_BID',
      operation_status: 'DISABLE',
      ...spec.targeting,
    });
    if (!adGroup.adgroup_id) {
      throw new PlatformError('tiktok', 'adgroup create returned no adgroup_id', 502);
    }

    return {
      campaign: { externalId: campaign.campaign_id, raw: campaign },
      adSet: { externalId: adGroup.adgroup_id, raw: adGroup },
    };
  },

  async createAd(ctx, account, adSetExternalId, spec) {
    const token = credentialsFor(ctx.env, account).accessToken;
    if (ctx.dryRun) return described('tiktok.createAd', { adSetExternalId, ...spec });

    const identityId = readMeta(account.meta, 'identity_id');
    if (!identityId) {
      throw new PlatformError('tiktok', 'ads account meta is missing identity_id', 400, {
        hint: 'Set accounts.meta to {"identity_id":"...","identity_type":"CUSTOMIZED_USER"}',
      });
    }

    const res = await bizPost<{ ad_ids?: string[] }>(token, '/ad/create/', {
      advertiser_id: account.external_id,
      adgroup_id: adSetExternalId,
      creatives: [
        {
          ad_name: (spec.headline ?? 'BBA ad').slice(0, 512),
          ad_format: 'SINGLE_VIDEO',
          identity_id: identityId,
          identity_type: readMeta(account.meta, 'identity_type') ?? 'CUSTOMIZED_USER',
          ad_text: spec.body.slice(0, 100),
          call_to_action: tiktokCta(spec.cta),
          landing_page_url: spec.landingUrl,
          ...(spec.sourcePostId ? { tiktok_item_id: spec.sourcePostId } : {}),
        },
      ],
    });
    const adId = res.ad_ids?.[0];
    if (!adId) throw new PlatformError('tiktok', 'ad create returned no ad id', 502);
    return { externalId: adId, raw: res };
  },

  async setBudget(ctx, account, adSetExternalId, dailyBudgetCents) {
    const token = credentialsFor(ctx.env, account).accessToken;
    if (ctx.dryRun) return described('tiktok.setBudget', { adSetExternalId, dailyBudgetCents });
    await bizPost(token, '/adgroup/budget/update/', {
      advertiser_id: account.external_id,
      budget_list: [{ adgroup_id: adSetExternalId, budget: dailyBudgetCents / 100 }],
    });
    return { externalId: adSetExternalId };
  },

  async setStatus(ctx, account, externalId, status, level) {
    const token = credentialsFor(ctx.env, account).accessToken;
    if (ctx.dryRun) return described('tiktok.setStatus', { externalId, status, level });
    const operation = status === 'active' ? 'ENABLE' : 'DISABLE';
    const path =
      level === 'campaign'
        ? '/campaign/status/update/'
        : level === 'adset'
          ? '/adgroup/status/update/'
          : '/ad/status/update/';
    const idField =
      level === 'campaign' ? 'campaign_ids' : level === 'adset' ? 'adgroup_ids' : 'ad_ids';
    await bizPost(token, path, {
      advertiser_id: account.external_id,
      [idField]: [externalId],
      operation_status: operation,
    });
    return { externalId };
  },

  async report(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<TikTokEnvelope<{ list?: TikTokReportRow[] }>>(
      `${BIZ_API}/report/integrated/get/?${qs({
        advertiser_id: account.external_id,
        report_type: 'BASIC',
        data_level: 'AUCTION_ADGROUP',
        dimensions: JSON.stringify(['adgroup_id', 'stat_time_day']),
        metrics: JSON.stringify([
          'spend',
          'impressions',
          'reach',
          'clicks',
          'video_play_actions',
          'conversion',
          'total_purchase_value',
        ]),
        start_date: opts.since,
        end_date: opts.until,
        page_size: 500,
      })}`,
      { channel: 'tiktok', headers: { 'Access-Token': token } },
    );
    assertOk('tiktok', data);

    return (data.data?.list ?? []).map((row) => {
      const metric = emptyMetric(
        'campaign_channel',
        String(row.dimensions?.adgroup_id ?? account.external_id),
        'tiktok',
        String(row.dimensions?.stat_time_day ?? opts.until).slice(0, 10),
      );
      const m = row.metrics ?? {};
      metric.spend_cents = Math.round(Number(m.spend ?? 0) * 100);
      metric.impressions = Number(m.impressions ?? 0);
      metric.reach = Number(m.reach ?? 0);
      metric.clicks = Number(m.clicks ?? 0);
      metric.video_views = Number(m.video_play_actions ?? 0);
      metric.conversions = Number(m.conversion ?? 0);
      metric.revenue_cents = Math.round(Number(m.total_purchase_value ?? 0) * 100);
      metric.currency = account.currency;
      metric.raw = row;
      return metric;
    });
  },
};

async function bizPost<T>(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await apiFetch<TikTokEnvelope<T>>(`${BIZ_API}${path}`, {
    channel: 'tiktok',
    method: 'POST',
    headers: { 'Access-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertOk('tiktok', res);
  return (res.data ?? {}) as T;
}

/** TikTok answers 200 with a non-zero `code` on failure, so check the body. */
function assertOk(channel: string, env: TikTokEnvelope<unknown>): void {
  if (env.code !== undefined && env.code !== 0) {
    throw new PlatformError(channel, `TikTok error ${env.code}: ${env.message ?? 'unknown'}`, 400, {
      code: env.code,
      request_id: env.request_id,
    });
  }
}

function toTikTokTime(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function tiktokCta(cta: string | null | undefined): string {
  const normalized = (cta ?? '').toUpperCase().replace(/[^A-Z]/g, '_');
  const allowed = new Set(['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'DOWNLOAD_NOW', 'CONTACT_US', 'APPLY_NOW', 'SUBSCRIBE']);
  return allowed.has(normalized) ? normalized : 'LEARN_MORE';
}

function readMeta(meta: string, key: string): string | undefined {
  try {
    const obj = JSON.parse(meta) as Record<string, unknown>;
    return typeof obj[key] === 'string' ? (obj[key] as string) : undefined;
  } catch {
    return undefined;
  }
}

interface TikTokEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

interface TikTokVideo {
  id?: string;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  view_count?: number;
}

interface TikTokReportRow {
  dimensions?: Record<string, string | number>;
  metrics?: Record<string, string | number>;
}
