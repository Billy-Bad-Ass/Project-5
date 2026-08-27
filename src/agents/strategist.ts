import { all, first, parseJson } from '../lib/db';
import { utcDate } from '../lib/time';
import { completeJson, MODELS } from '../integrations/anthropic';
import { ADS_CHANNELS, ORGANIC_CHANNELS } from '../platforms';
import { blendedRoas } from '../orchestrator/allocator';
import { spendToday } from '../orchestrator/guardrails';
import { channelPerformance } from './analyst';
import { createCampaignRecord } from './mediabuyer';
import type { Account, Campaign, Channel, Offer } from '../types';
import { type Agent, failed, num, ok, str } from './agent';

/**
 * The strategist decides what to run and where. It is the only agent that
 * proposes new spending, and everything it proposes lands as a draft campaign
 * that a person has to launch.
 */
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    campaign_name: { type: 'string' },
    thesis: {
      type: 'string',
      description: 'Why this should work, in one or two sentences, grounded in the data provided.',
    },
    audience: { type: 'string' },
    angles: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: { type: 'string' },
      description: 'Distinct positioning angles worth testing against each other.',
    },
    channel_split: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          share: { type: 'number', description: '0 to 1. Must sum to about 1.' },
          why: { type: 'string' },
        },
        required: ['channel', 'share', 'why'],
      },
    },
    organic_channels: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['campaign_name', 'thesis', 'audience', 'angles', 'channel_split'],
} as const;

interface Plan {
  campaign_name: string;
  thesis: string;
  audience: string;
  angles: string[];
  channel_split: { channel: string; share: number; why: string }[];
  organic_channels?: string[];
  risks?: string[];
}

export const strategist: Agent = {
  id: 'strategist',
  describe: 'Plans what to run and where. Produces draft campaigns, never live ones.',

  tasks: {
    /**
     * Plan a campaign for an offer. Uses trailing performance so the plan is
     * anchored to what has actually worked rather than to a guess.
     */
    async plan_campaign(ctx, payload) {
      if (!ctx.env.ANTHROPIC_API_KEY) return failed('ANTHROPIC_API_KEY is not set');

      const offerId = str(payload, 'offerId');
      const offer = offerId
        ? await first<Offer>(ctx.env, 'SELECT * FROM offers WHERE id = ?', offerId)
        : await first<Offer>(ctx.env, `SELECT * FROM offers WHERE status = 'active' LIMIT 1`);
      if (!offer) return failed('no active offer to plan against');

      const dailyBudgetCents = Math.min(
        num(payload, 'dailyBudgetCents') ?? Math.floor(ctx.config.dailySpendCapCents / 2),
        ctx.config.dailySpendCapCents,
      );

      const adAccounts = await all<Account>(
        ctx.env,
        `SELECT * FROM accounts WHERE surface = 'ads' AND status = 'active'`,
      );
      if (adAccounts.length === 0) return failed('no active ad accounts connected');

      const performances = await channelPerformance(ctx.env, 30);
      const history = performances.map((p) => ({
        channel: p.channel,
        spend_cents: p.spendCents,
        revenue_cents: p.revenueCents,
        conversions: p.conversions,
        roas: p.spendCents > 0 ? Math.round((p.revenueCents / p.spendCents) * 100) / 100 : null,
      }));

      const availableAdChannels = adAccounts
        .map((a) => a.channel)
        .filter((c) => ADS_CHANNELS.includes(c));

      let plan: Plan;
      try {
        plan = await completeJson<Plan>(ctx.env, {
          model: MODELS.writer,
          maxTokens: 2500,
          temperature: 0.8,
          system: [
            'You plan paid acquisition for BBA Network.',
            'You are given real trailing performance. Base the split on it. Where there is no history, say so and propose a small test rather than a confident allocation.',
            'Do not invent benchmarks, industry averages, or numbers that are not in the input.',
            `Only these ad channels are connected: ${availableAdChannels.join(', ')}. Do not propose any other.`,
            'Prefer two or three channels over spreading thin. A channel below about 2000 cents a day cannot learn.',
            'Angles must be genuinely different positions, not rewordings.',
            'Plain language. No em dashes.',
          ].join('\n'),
          prompt: JSON.stringify(
            {
              offer: {
                name: offer.name,
                description: offer.description,
                price_cents: offer.price_cents,
                target_cac_cents: offer.target_cac_cents,
                gross_margin_bps: offer.gross_margin_bps,
                landing_url: offer.landing_url,
              },
              daily_budget_cents: dailyBudgetCents,
              connected_ad_channels: availableAdChannels,
              connected_organic_channels: ORGANIC_CHANNELS,
              trailing_30d_by_channel: history,
              blended_roas: blendedRoas(performances),
              spend_today_cents: await spendToday(ctx.env),
              daily_cap_cents: ctx.config.dailySpendCapCents,
              notes: str(payload, 'notes') ?? null,
            },
            null,
            2,
          ),
          schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
        });
      } catch (err) {
        return failed(`planning failed: ${String(err).slice(0, 200)}`);
      }

      // Normalise the split and drop anything not actually connected.
      const usable = plan.channel_split.filter((s) =>
        adAccounts.some((a) => a.channel === s.channel),
      );
      if (usable.length === 0) {
        return failed('the plan named no connected ad channel');
      }
      const shareTotal = usable.reduce((sum, s) => sum + Math.max(0, s.share), 0) || 1;

      const channels = usable.map((split) => {
        const account = adAccounts.find((a) => a.channel === split.channel)!;
        return {
          accountId: account.id,
          channel: split.channel as Channel,
          dailyBudgetCents: Math.round((Math.max(0, split.share) / shareTotal) * dailyBudgetCents),
          targeting: {},
        };
      });

      const campaignId = await createCampaignRecord(ctx.env, {
        name: plan.campaign_name,
        offerId: offer.id,
        objective: (str(payload, 'objective') ?? 'conversions') as Campaign['objective'],
        dailyBudgetCents,
        channels,
        brief: {
          thesis: plan.thesis,
          audience: plan.audience,
          angles: plan.angles,
          risks: plan.risks ?? [],
          organic_channels: plan.organic_channels ?? [],
          planned_at: utcDate(),
        },
      });

      const decisionId = await ctx.decide({
        agent: 'strategist',
        action: 'plan_campaign',
        targetType: 'campaign',
        targetId: campaignId,
        rationale: plan.thesis,
        evidence: { trailing_30d: history },
        proposed: {
          daily_budget_cents: dailyBudgetCents,
          channels: channels.map((c) => ({ channel: c.channel, cents: c.dailyBudgetCents })),
        },
        risk: 'high',
      });

      await ctx.requestApproval({
        decisionId,
        subjectType: 'campaign',
        subjectId: campaignId,
        summary: `Launch "${plan.campaign_name}" at ${dailyBudgetCents} cents/day across ${channels
          .map((c) => c.channel)
          .join(', ')}`,
        risk: 'high',
      });

      // Copy can be drafted now. It cannot ship until the campaign is approved.
      await ctx.enqueue({
        agent: 'creative',
        task: 'draft_batch',
        payload: {
          campaignId,
          kind: 'ad',
          channels: channels.map((c) => c.channel),
          count: Math.min(3, plan.angles.length),
        },
        priority: 4,
        dedupe: ['draft_ads', campaignId],
      });

      return ok(`drafted campaign ${plan.campaign_name}, awaiting approval`, {
        data: { campaignId, plan },
      });
    },

    /**
     * The organic side: keep every connected account fed without waiting on a
     * campaign. Runs daily.
     */
    async plan_organic(ctx, payload) {
      const targetPerChannel = num(payload, 'targetPerChannel') ?? 3;
      const accounts = await all<Account>(
        ctx.env,
        `SELECT * FROM accounts WHERE surface = 'organic' AND status = 'active'`,
      );
      const hungry: Channel[] = [];

      for (const account of accounts) {
        const row = await first<{ n: number }>(
          ctx.env,
          `SELECT COUNT(*) AS n FROM creatives
            WHERE channel = ? AND kind = 'organic_post'
              AND status IN ('approved','pending_approval')
              AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.creative_id = creatives.id)`,
          account.channel,
        );
        if ((row?.n ?? 0) < targetPerChannel) hungry.push(account.channel);
      }

      // "Every channel is fed" and "there are no channels" are different
      // states, and reporting them with the same sentence is how an idle
      // system passes for a healthy one. On this deployment `accounts` was
      // empty for three days: every daily run returned the reassuring message
      // below over an empty loop, while offers, campaigns and creatives all sat
      // at zero and nothing said so.
      if (accounts.length === 0) {
        return ok('no connected organic accounts, so nothing to plan copy for', {
          data: { accounts: 0, hungry: [] },
        });
      }

      if (hungry.length === 0) {
        return ok(`every channel has copy in the pipeline (${accounts.length} connected)`, {
          data: { accounts: accounts.length, hungry: [] },
        });
      }

      const jobId = await ctx.enqueue({
        agent: 'creative',
        task: 'draft_batch',
        payload: { channels: hungry, count: 2, kind: 'organic_post' },
        priority: 5,
        dedupe: ['draft_organic', hungry.join(','), utcDate()],
      });

      return ok(`${hungry.length} channels need copy`, {
        enqueued: jobId ? 1 : 0,
        data: { hungry },
      });
    },

    /** Weekly: read the portfolio and say what should change. */
    async portfolio_review(ctx) {
      const performances = await channelPerformance(ctx.env, 28);
      const campaigns = await all<Campaign>(
        ctx.env,
        `SELECT * FROM campaigns WHERE status IN ('active','paused')`,
      );
      const summary = {
        blended_roas: blendedRoas(performances),
        total_spend_cents: performances.reduce((s, p) => s + p.spendCents, 0),
        total_revenue_cents: performances.reduce((s, p) => s + p.revenueCents, 0),
        campaigns: campaigns.map((c) => ({
          name: c.name,
          status: c.status,
          daily_budget_cents: c.daily_budget_cents,
          brief: parseJson(c.brief, {}),
        })),
        by_channel: performances,
      };

      await ctx.decide({
        agent: 'strategist',
        action: 'portfolio_review',
        rationale: `28 day blended ROAS ${summary.blended_roas.toFixed(2)} across ${performances.length} channels`,
        evidence: summary,
      });

      // Refill the creative pipeline for whatever is still running.
      await ctx.enqueue({
        agent: 'strategist',
        task: 'plan_organic',
        payload: { targetPerChannel: 4 },
        priority: 6,
        dedupe: ['weekly_organic', utcDate()],
      });

      return ok('portfolio reviewed', { data: summary });
    },
  },
};

/** Small helper for the API layer. */
export function briefAngles(campaign: Campaign): string[] {
  const brief = parseJson<{ angles?: string[] }>(campaign.brief, {});
  return brief.angles ?? [];
}

