import { all, first, insert, parseJson, run } from '../lib/db';
import { id } from '../lib/ids';
import { daysAgoUtc, nowIso, utcDate } from '../lib/time';
import { adsFor, organicFor } from '../platforms';
import { attributionFrom, listCharges } from '../integrations/stripe';
import { complete, MODELS } from '../integrations/anthropic';
import { blendedCac, blendedRoas, type ChannelPerformance } from '../orchestrator/allocator';
import type { Account, MetricRow } from '../types';
import { type Agent, num, ok, str } from './agent';

/**
 * The analyst turns platform numbers and Stripe numbers into the one figure
 * that decides anything: revenue per dollar spent, per channel.
 */
export const analyst: Agent = {
  id: 'analyst',
  describe: 'Pulls metrics, joins Stripe revenue to spend, and writes the daily report.',

  tasks: {
    /** Pull metrics from every connected account for a trailing window. */
    async sync_metrics(ctx, payload) {
      const days = num(payload, 'days') ?? 3;
      const since = daysAgoUtc(days);
      const until = utcDate();
      const accounts = await all<Account>(ctx.env, `SELECT * FROM accounts WHERE status = 'active'`);

      let rows = 0;
      const errors: string[] = [];

      for (const account of accounts) {
        const platformCtx = { env: ctx.env, log: ctx.log, dryRun: ctx.config.dryRun };
        try {
          if (account.surface === 'organic') {
            const adapter = organicFor(account.channel);
            if (!adapter) continue;
            const posts = await all<{ external_id: string }>(
              ctx.env,
              `SELECT external_id FROM posts
                WHERE account_id = ? AND status = 'published' AND external_id IS NOT NULL
                  AND published_at >= ?
                ORDER BY published_at DESC LIMIT 50`,
              account.id,
              `${since}T00:00:00.000Z`,
            );
            const externalIds = posts.map((p) => p.external_id).filter(Boolean);
            if (externalIds.length === 0) continue;
            const metrics = await adapter.insights(platformCtx, account, { since, until, externalIds });
            rows += await upsertMetrics(ctx.env, metrics);
          } else {
            const adapter = adsFor(account.channel);
            if (!adapter) continue;
            const channels = await all<{ external_adset_id: string | null }>(
              ctx.env,
              `SELECT external_adset_id FROM campaign_channels
                WHERE account_id = ? AND external_adset_id IS NOT NULL`,
              account.id,
            );
            const externalIds = channels
              .map((c) => c.external_adset_id)
              .filter((v): v is string => typeof v === 'string' && v.length > 0 && !v.startsWith('dryrun:'));
            const metrics = await adapter.report(platformCtx, account, { since, until, externalIds });
            rows += await upsertMetrics(ctx.env, metrics);
            await recordSpend(ctx.env, metrics);
          }
        } catch (err) {
          const message = `${account.channel}/${account.surface}: ${String(err).slice(0, 200)}`;
          errors.push(message);
          ctx.log.warn('metric sync failed', { account_id: account.id, err: message });
        }
      }

      if (errors.length) {
        await ctx.incident({
          severity: 'warn',
          code: 'metric_sync_partial',
          message: `${errors.length} accounts failed to sync`,
          context: { errors },
        });
      }
      return ok(`upserted ${rows} metric rows from ${accounts.length} accounts`, {
        data: { rows, errors },
      });
    },

    /** Pull Stripe charges and record them with whatever attribution exists. */
    async attribute_revenue(ctx, payload) {
      if (!ctx.env.STRIPE_SECRET_KEY) {
        return ok('skipped, STRIPE_SECRET_KEY is not set');
      }
      const days = num(payload, 'days') ?? 3;
      const since = new Date(Date.now() - days * 86_400_000);
      const charges = await listCharges(ctx.env, { since, until: new Date() });

      let recorded = 0;
      let attributed = 0;
      for (const charge of charges) {
        const attribution = attributionFrom(charge.metadata);
        const net = charge.amount - (charge.amount_refunded ?? 0);
        if (net <= 0) continue;
        try {
          await insert(
            ctx.env,
            'revenue_events',
            {
              id: id('rev'),
              // Charges are not events, so key on the charge id to stay idempotent.
              stripe_event_id: `charge:${charge.id}`,
              stripe_object_id: charge.id,
              kind: 'payment',
              amount_cents: net,
              currency: charge.currency,
              customer_id: charge.customer ?? null,
              attributed_channel: attribution.channel,
              attributed_campaign_id: attribution.campaignId,
              attribution_model: attribution.model,
              occurred_at: new Date(charge.created * 1000).toISOString(),
              raw: JSON.stringify({ metadata: charge.metadata ?? {} }),
              created_at: nowIso(),
            },
            { orIgnore: true },
          );
          recorded++;
          if (attribution.model !== 'unattributed') attributed++;
        } catch (err) {
          ctx.log.warn('revenue insert failed', { charge_id: charge.id, err: String(err) });
        }
      }

      // Fold attributed revenue back onto the channel metrics for the day.
      await run(
        ctx.env,
        `UPDATE metrics SET revenue_cents = COALESCE((
             SELECT SUM(r.amount_cents) FROM revenue_events r
              WHERE r.attributed_channel = metrics.channel
                AND date(r.occurred_at) = metrics.metric_date
           ), revenue_cents)
          WHERE entity_type = 'campaign_channel' AND metric_date >= ?`,
        daysAgoUtc(days),
      );

      const unattributedShare = recorded > 0 ? 1 - attributed / recorded : 0;
      if (recorded >= 10 && unattributedShare > 0.6) {
        await ctx.incident({
          severity: 'warn',
          code: 'attribution_gap',
          message: `${Math.round(unattributedShare * 100)}% of recent revenue has no channel attribution`,
          context: { recorded, attributed },
          });
      }

      return ok(`recorded ${recorded} charges, ${attributed} attributed`, {
        data: { recorded, attributed },
      });
    },

    /** The number that matters, per channel, over a window. */
    async performance_snapshot(ctx, payload) {
      const days = num(payload, 'days') ?? 14;
      const performances = await channelPerformance(ctx.env, days);
      return ok(`snapshot across ${performances.length} channels`, {
        data: {
          performances,
          blended_roas: blendedRoas(performances),
          blended_cac_cents: blendedCac(performances),
        },
      });
    },

    /**
     * A short written read on the last day. This is one of the few places a
     * model is genuinely better than arithmetic, so it gets one, and the
     * numbers it is given are computed in code so it cannot invent them.
     */
    async daily_report(ctx, payload) {
      const days = num(payload, 'days') ?? 7;
      const performances = await channelPerformance(ctx.env, days);
      const yesterday = await channelPerformance(ctx.env, 1);
      const openIncidents = await all<{ severity: string; code: string; message: string }>(
        ctx.env,
        `SELECT severity, code, message FROM incidents WHERE resolved_at IS NULL
          ORDER BY created_at DESC LIMIT 10`,
      );
      const pendingApprovals = await first<{ n: number }>(
        ctx.env,
        `SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`,
      );

      const facts = {
        window_days: days,
        blended_roas: round(blendedRoas(performances)),
        blended_cac_cents: blendedCac(performances),
        yesterday_spend_cents: yesterday.reduce((s, p) => s + p.spendCents, 0),
        yesterday_revenue_cents: yesterday.reduce((s, p) => s + p.revenueCents, 0),
        channels: performances.map((p) => ({
          channel: p.channel,
          spend_cents: p.spendCents,
          revenue_cents: p.revenueCents,
          conversions: p.conversions,
          roas: round(p.spendCents > 0 ? p.revenueCents / p.spendCents : 0),
        })),
        open_incidents: openIncidents,
        pending_approvals: pendingApprovals?.n ?? 0,
      };

      let narrative = '';
      if (ctx.env.ANTHROPIC_API_KEY && str(payload, 'narrative') !== 'off') {
        try {
          narrative = await complete(ctx.env, {
            model: MODELS.worker,
            maxTokens: 700,
            temperature: 0.4,
            system: [
              'You write the daily performance note for the operator of BBA Network.',
              'You are given computed figures. Use only those figures. Never invent a number, a cause, or a source.',
              'Say what changed, what it likely means, and the single next action. Six sentences at most.',
              'No preamble, no sign-off, no em dashes, no bold, no headings.',
              'If the data is too thin to conclude anything, say that plainly.',
            ].join('\n'),
            prompt: JSON.stringify(facts, null, 2),
          });
        } catch (err) {
          ctx.log.warn('narrative generation failed', { err: String(err) });
        }
      }

      await run(
        ctx.env,
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        `report:${utcDate()}`,
        JSON.stringify({ facts, narrative }),
        nowIso(),
      );

      return ok('daily report written', { data: { facts, narrative } });
    },
  },
};

/** Trailing performance per channel, joined from metrics. */
export async function channelPerformance(
  env: import('../env').Env,
  days: number,
): Promise<ChannelPerformance[]> {
  const rows = await all<{
    campaign_channel_id: string;
    channel: string;
    spend: number;
    conversions: number;
    revenue: number;
    clicks: number;
    impressions: number;
    daily_budget_cents: number;
    days_active: number;
  }>(
    env,
    `SELECT cc.id AS campaign_channel_id,
            cc.channel AS channel,
            COALESCE(SUM(m.spend_cents), 0) AS spend,
            COALESCE(SUM(m.conversions), 0) AS conversions,
            COALESCE(SUM(m.revenue_cents), 0) AS revenue,
            COALESCE(SUM(m.clicks), 0) AS clicks,
            COALESCE(SUM(m.impressions), 0) AS impressions,
            cc.daily_budget_cents AS daily_budget_cents,
            COALESCE(COUNT(DISTINCT m.metric_date), 0) AS days_active
       FROM campaign_channels cc
       LEFT JOIN metrics m
              ON m.entity_type = 'campaign_channel'
             AND m.entity_id = cc.external_adset_id
             AND m.metric_date >= ?
      WHERE cc.status IN ('active','paused')
      GROUP BY cc.id
      ORDER BY spend DESC`,
    daysAgoUtc(days),
  );

  return rows.map((r) => ({
    channel: r.channel,
    campaignChannelId: r.campaign_channel_id,
    spendCents: r.spend,
    conversions: r.conversions,
    revenueCents: r.revenue,
    clicks: r.clicks,
    impressions: r.impressions,
    currentDailyBudgetCents: r.daily_budget_cents,
    daysActive: r.days_active,
  }));
}

async function upsertMetrics(env: import('../env').Env, metrics: MetricRow[]): Promise<number> {
  const usable = metrics.filter((m) => m.entity_id && m.metric_date);
  if (usable.length === 0) return 0;

  const statements = usable.map((m) =>
    env.DB.prepare(
      `INSERT INTO metrics (id, entity_type, entity_id, channel, metric_date, impressions, reach,
                            clicks, video_views, engagements, follows, conversions, spend_cents,
                            revenue_cents, currency, raw, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (entity_type, entity_id, metric_date) DO UPDATE SET
         impressions = excluded.impressions,
         reach = excluded.reach,
         clicks = excluded.clicks,
         video_views = excluded.video_views,
         engagements = excluded.engagements,
         follows = excluded.follows,
         conversions = excluded.conversions,
         spend_cents = excluded.spend_cents,
         -- revenue_cents is deliberately not overwritten here: platform
         -- reported revenue is unreliable, so attribute_revenue sets it from
         -- Stripe instead.
         raw = excluded.raw,
         synced_at = excluded.synced_at`,
    ).bind(
      id('met'),
      m.entity_type,
      m.entity_id,
      m.channel,
      m.metric_date,
      m.impressions,
      m.reach,
      m.clicks,
      m.video_views,
      m.engagements,
      m.follows,
      m.conversions,
      m.spend_cents,
      m.revenue_cents,
      m.currency,
      JSON.stringify(m.raw ?? {}).slice(0, 8000),
      nowIso(),
    ),
  );
  await env.DB.batch(statements);
  return usable.length;
}

/** Mirror platform spend into the ledger the guardrails read. */
async function recordSpend(env: import('../env').Env, metrics: MetricRow[]): Promise<void> {
  const byDayChannel = new Map<string, { date: string; channel: string; cents: number }>();
  for (const m of metrics) {
    if (m.spend_cents <= 0) continue;
    const key = `${m.metric_date}:${m.channel}`;
    const existing = byDayChannel.get(key);
    if (existing) existing.cents += m.spend_cents;
    else byDayChannel.set(key, { date: m.metric_date, channel: m.channel, cents: m.spend_cents });
  }
  if (byDayChannel.size === 0) return;

  const statements = [...byDayChannel.values()].map((entry) =>
    env.DB.prepare(
      // campaign_id is '' rather than NULL so the unique index actually matches
      // on the next sync. Spend is replaced, never added to.
      `INSERT INTO spend_ledger (id, ledger_date, channel, campaign_id, amount_cents, currency, source, created_at)
       VALUES (?,?,?,'',?,?,'platform_sync',?)
       ON CONFLICT (ledger_date, channel, campaign_id, source)
       DO UPDATE SET amount_cents = excluded.amount_cents`,
    ).bind(id('spd'), entry.date, entry.channel, entry.cents, 'USD', nowIso()),
  );
  await env.DB.batch(statements);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Re-exported so the API layer can read a stored report without a model call. */
export async function storedReport(
  env: import('../env').Env,
  date = utcDate(),
): Promise<{ facts: unknown; narrative: string } | null> {
  const row = await first<{ value: string }>(
    env,
    `SELECT value FROM settings WHERE key = ?`,
    `report:${date}`,
  );
  return row ? parseJson(row.value, null) : null;
}
