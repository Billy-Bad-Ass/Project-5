import { apiFetch, qs } from '../lib/http';
import { PlatformError } from '../lib/errors';
import { utcDate } from '../lib/time';
import type { MetricRow } from '../types';
import { credentialsFor } from './credentials';
import {
  described,
  describedPublish,
  emptyMetric,
  type AdsAdapter,
  type OrganicAdapter,
  type VerifyResult,
} from './types';

/** Pinterest API v5. developers.pinterest.com/docs/api/v5 */
const API = 'https://api.pinterest.com/v5';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

export const pinterestOrganic: OrganicAdapter = {
  channel: 'pinterest',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<{ username?: string; id?: string }>(`${API}/user_account`, {
      channel: 'pinterest',
      headers: auth(token),
    });
    return { ok: Boolean(data.id), detail: data.username ? `connected as ${data.username}` : 'no account returned' };
  },

  async publish(ctx, account, input) {
    const token = credentialsFor(ctx.env, account).accessToken;
    const boardId = input.destination ?? readMeta(account.meta, 'board_id');
    const title = (input.title ?? input.hook ?? input.body).slice(0, 100);
    const description = input.body.slice(0, 500);
    const media = input.media[0];

    if (ctx.dryRun) {
      return describedPublish('pinterest.publish', { boardId, title, description, media: media?.url });
    }
    if (!boardId) {
      throw new PlatformError('pinterest', 'no board id: set accounts.meta {"board_id":"..."}', 400);
    }
    if (!media) throw new PlatformError('pinterest', 'a pin needs an image or video', 400);

    const res = await apiFetch<{ id?: string }>(`${API}/pins`, {
      channel: 'pinterest',
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        board_id: boardId,
        title,
        description,
        ...(input.linkUrl ? { link: input.linkUrl } : {}),
        media_source:
          media.kind === 'video'
            ? { source_type: 'video_id', media_id: media.url }
            : { source_type: 'image_url', url: media.url },
      }),
    });
    if (!res.id) throw new PlatformError('pinterest', 'pin create returned no id', 502);
    return { externalId: res.id, permalink: `https://www.pinterest.com/pin/${res.id}/`, raw: res };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const out: MetricRow[] = [];
    for (const pinId of (opts.externalIds ?? []).filter((v) => !v.startsWith('dryrun:'))) {
      try {
        const data = await apiFetch<PinAnalytics>(
          `${API}/pins/${pinId}/analytics?${qs({
            start_date: opts.since,
            end_date: opts.until,
            metric_types: 'IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE',
          })}`,
          { channel: 'pinterest', headers: auth(token), tolerate: [400, 404] },
        );
        const summary = data.all?.summary_metrics ?? {};
        const metric = emptyMetric('post', pinId, 'pinterest', utcDate(opts.until));
        metric.impressions = Number(summary.IMPRESSION ?? 0);
        metric.clicks = Number(summary.OUTBOUND_CLICK ?? summary.PIN_CLICK ?? 0);
        metric.engagements = Number(summary.SAVE ?? 0) + Number(summary.PIN_CLICK ?? 0);
        metric.raw = data;
        out.push(metric);
      } catch (err) {
        ctx.log.warn('pinterest insights failed', { pin_id: pinId, err: String(err) });
      }
    }
    return out;
  },
};

const PINTEREST_OBJECTIVE: Record<string, string> = {
  conversions: 'WEB_CONVERSION',
  traffic: 'WEB_SESSIONS',
  awareness: 'AWARENESS',
  leads: 'WEB_CONVERSION',
  app_installs: 'APP_INSTALL',
};

export const pinterestAds: AdsAdapter = {
  channel: 'pinterest',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<{ name?: string; id?: string }>(
      `${API}/ad_accounts/${account.external_id}`,
      { channel: 'pinterest', headers: auth(token) },
    );
    return { ok: Boolean(data.id), detail: data.name ? `ad account ${data.name}` : 'ad account not found' };
  },

  async createCampaign(ctx, account, spec) {
    const objective = PINTEREST_OBJECTIVE[spec.objective] ?? 'WEB_SESSIONS';
    if (ctx.dryRun) {
      return {
        campaign: described('pinterest.createCampaign', { ...spec, objective }),
        adSet: described('pinterest.createAdGroup', { dailyBudgetCents: spec.dailyBudgetCents }),
      };
    }
    const token = credentialsFor(ctx.env, account).accessToken;

    const campaigns = await apiFetch<PinterestBatch>(
      `${API}/ad_accounts/${account.external_id}/campaigns`,
      {
        channel: 'pinterest',
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify([
          {
            ad_account_id: account.external_id,
            name: spec.name,
            objective_type: objective,
            status: 'PAUSED',
            daily_spend_cap: spec.dailyBudgetCents * 10_000,
          },
        ]),
      },
    );
    const campaignId = campaigns.items?.[0]?.data?.id;
    if (!campaignId) throw new PlatformError('pinterest', 'campaign create returned no id', 502);

    const adGroups = await apiFetch<PinterestBatch>(
      `${API}/ad_accounts/${account.external_id}/ad_groups`,
      {
        channel: 'pinterest',
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify([
          {
            ad_account_id: account.external_id,
            campaign_id: campaignId,
            name: `${spec.name} / ad group`,
            status: 'PAUSED',
            billable_event: objective === 'AWARENESS' ? 'IMPRESSION' : 'CLICKTHROUGH',
            budget_in_micro_currency: spec.dailyBudgetCents * 10_000,
            budget_type: 'DAILY',
            auto_targeting_enabled: true,
            ...(spec.startsAt ? { start_time: Math.floor(new Date(spec.startsAt).getTime() / 1000) } : {}),
          },
        ]),
      },
    );
    const adGroupId = adGroups.items?.[0]?.data?.id;
    if (!adGroupId) throw new PlatformError('pinterest', 'ad group create returned no id', 502);

    return {
      campaign: { externalId: campaignId, raw: campaigns },
      adSet: { externalId: adGroupId, raw: adGroups },
    };
  },

  async createAd(ctx, account, adSetExternalId, spec) {
    if (ctx.dryRun) return described('pinterest.createAd', { adSetExternalId, ...spec });
    if (!spec.sourcePostId) {
      // Pinterest promotes an existing pin, it does not accept raw creative.
      throw new PlatformError(
        'pinterest',
        'Pinterest ads promote an existing pin: publish the pin first and pass its id',
        400,
      );
    }
    const token = credentialsFor(ctx.env, account).accessToken;
    const res = await apiFetch<PinterestBatch>(`${API}/ad_accounts/${account.external_id}/ads`, {
      channel: 'pinterest',
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify([
        {
          ad_account_id: account.external_id,
          ad_group_id: adSetExternalId,
          pin_id: spec.sourcePostId,
          creative_type: 'REGULAR',
          name: (spec.headline ?? 'BBA ad').slice(0, 255),
          status: 'PAUSED',
          destination_url: spec.landingUrl,
        },
      ]),
    });
    const adId = res.items?.[0]?.data?.id;
    if (!adId) throw new PlatformError('pinterest', 'ad create returned no id', 502);
    return { externalId: adId, raw: res };
  },

  async setBudget(ctx, account, adSetExternalId, dailyBudgetCents) {
    if (ctx.dryRun) return described('pinterest.setBudget', { adSetExternalId, dailyBudgetCents });
    const token = credentialsFor(ctx.env, account).accessToken;
    await apiFetch(`${API}/ad_accounts/${account.external_id}/ad_groups`, {
      channel: 'pinterest',
      method: 'PATCH',
      headers: auth(token),
      body: JSON.stringify([
        { id: adSetExternalId, budget_in_micro_currency: dailyBudgetCents * 10_000 },
      ]),
    });
    return { externalId: adSetExternalId };
  },

  async setStatus(ctx, account, externalId, status, level) {
    if (ctx.dryRun) return described('pinterest.setStatus', { externalId, status, level });
    const token = credentialsFor(ctx.env, account).accessToken;
    const resource = level === 'campaign' ? 'campaigns' : level === 'adset' ? 'ad_groups' : 'ads';
    await apiFetch(`${API}/ad_accounts/${account.external_id}/${resource}`, {
      channel: 'pinterest',
      method: 'PATCH',
      headers: auth(token),
      body: JSON.stringify([{ id: externalId, status: status === 'active' ? 'ACTIVE' : 'PAUSED' }]),
    });
    return { externalId };
  },

  async report(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const data = await apiFetch<PinterestAnalyticsRow[]>(
      `${API}/ad_accounts/${account.external_id}/ad_groups/analytics?${qs({
        start_date: opts.since,
        end_date: opts.until,
        ad_group_ids: (opts.externalIds ?? []).join(','),
        columns: 'SPEND_IN_MICRO_DOLLAR,IMPRESSION_1,CLICKTHROUGH_1,TOTAL_CONVERSIONS',
        granularity: 'DAY',
      })}`,
      { channel: 'pinterest', headers: auth(token), tolerate: [400] },
    );
    if (!Array.isArray(data)) return [];
    return data.map((row) => {
      const metric = emptyMetric(
        'campaign_channel',
        String(row.AD_GROUP_ID ?? account.external_id),
        'pinterest',
        String(row.DATE ?? opts.until).slice(0, 10),
      );
      metric.spend_cents = Math.round(Number(row.SPEND_IN_MICRO_DOLLAR ?? 0) / 10_000);
      metric.impressions = Number(row.IMPRESSION_1 ?? 0);
      metric.clicks = Number(row.CLICKTHROUGH_1 ?? 0);
      metric.conversions = Number(row.TOTAL_CONVERSIONS ?? 0);
      metric.currency = account.currency;
      metric.raw = row;
      return metric;
    });
  },
};

function readMeta(meta: string, key: string): string | undefined {
  try {
    const obj = JSON.parse(meta) as Record<string, unknown>;
    return typeof obj[key] === 'string' ? (obj[key] as string) : undefined;
  } catch {
    return undefined;
  }
}

interface PinAnalytics {
  all?: { summary_metrics?: Record<string, number> };
}

interface PinterestBatch {
  items?: { data?: { id?: string }; exceptions?: unknown }[];
}

interface PinterestAnalyticsRow {
  AD_GROUP_ID?: string;
  DATE?: string;
  SPEND_IN_MICRO_DOLLAR?: number;
  IMPRESSION_1?: number;
  CLICKTHROUGH_1?: number;
  TOTAL_CONVERSIONS?: number;
}
