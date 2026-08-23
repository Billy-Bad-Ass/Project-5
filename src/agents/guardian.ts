import { all, first, insert } from '../lib/db';
import { id } from '../lib/ids';
import { nowIso, utcDate } from '../lib/time';
import { hasModelAccess } from '../integrations/anthropic';
import { adsFor, organicFor } from '../platforms';
import type { Account } from '../types';
import { spendByChannel, spendToday } from '../orchestrator/guardrails';
import { type Agent, ok } from './agent';

/**
 * The guardian is the agent that says no.
 *
 * It never creates or publishes anything. It checks credentials, watches spend,
 * expires stale approvals, and trips the pause switch when something looks
 * wrong. Every other agent depends on it having run recently.
 */
export const guardian: Agent = {
  id: 'guardian',
  describe: 'Checks credentials, spend, and stale approvals. Trips the pause switch.',

  tasks: {
    /** Cheap credential and connectivity check across every active account. */
    async health_check(ctx) {
      const accounts = await all<Account>(
        ctx.env,
        `SELECT * FROM accounts WHERE status IN ('active','needs_reauth')`,
      );
      const results: Record<string, string> = {};
      let broken = 0;

      for (const account of accounts) {
        const adapter =
          account.surface === 'organic' ? organicFor(account.channel) : adsFor(account.channel);
        const label = `${account.channel}/${account.surface}`;
        if (!adapter) {
          results[label] = 'no adapter for this channel';
          continue;
        }
        try {
          const verdict = await adapter.verify(
            { env: ctx.env, log: ctx.log, dryRun: ctx.config.dryRun },
            account,
          );
          results[label] = verdict.detail;
          if (!verdict.ok) {
            broken++;
            await markNeedsReauth(ctx, account, verdict.detail);
          } else if (account.status === 'needs_reauth') {
            await ctx.env.DB.prepare(`UPDATE accounts SET status = 'active', updated_at = ? WHERE id = ?`)
              .bind(nowIso(), account.id)
              .run();
          }
        } catch (err) {
          broken++;
          results[label] = String(err).slice(0, 300);
          await markNeedsReauth(ctx, account, String(err));
        }
      }

      if (!hasModelAccess(ctx.env)) {
        results['anthropic'] = 'ANTHROPIC_API_KEY is not set, writing agents are offline';
      }
      if (!ctx.env.STRIPE_SECRET_KEY) {
        results['stripe'] = 'STRIPE_SECRET_KEY is not set, revenue attribution is offline';
      }

      return ok(
        `checked ${accounts.length} accounts, ${broken} need attention`,
        { data: { results, broken } },
      );
    },

    /**
     * Portfolio audit. Looks for the failure modes that cost money quietly:
     * spend without revenue, ads running against retired creative, approvals
     * nobody answered.
     */
    async audit(ctx) {
      const findings: string[] = [];

      const spent = await spendToday(ctx.env);
      const byChannel = await spendByChannel(ctx.env);
      if (spent >= ctx.config.dailySpendCapCents * 0.8) {
        findings.push(`spend is at ${Math.round((spent / ctx.config.dailySpendCapCents) * 100)}% of the daily cap`);
        await ctx.incident({
          severity: 'warn',
          code: 'spend_approaching_cap',
          message: `${spent} cents spent against a cap of ${ctx.config.dailySpendCapCents}`,
          context: { by_channel: byChannel },
        });
      }

      // Live ad sets whose creative was retired or rejected.
      const orphaned = await all<{ id: string; channel: string; campaign_id: string }>(
        ctx.env,
        `SELECT cc.id, cc.channel, cc.campaign_id
           FROM campaign_channels cc
           JOIN campaigns c ON c.id = cc.campaign_id
          WHERE cc.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM creatives cr
               WHERE cr.campaign_id = cc.campaign_id AND cr.status IN ('approved','live')
            )`,
      );
      for (const row of orphaned) {
        findings.push(`${row.channel} ad set ${row.id} is live with no approved creative`);
        await ctx.decide({
          agent: 'guardian',
          action: 'pause_adset',
          targetType: 'campaign_channel',
          targetId: row.id,
          channel: row.channel as Account['channel'],
          rationale: 'live ad set has no approved creative behind it',
          risk: 'high',
        });
        await ctx.enqueue({
          agent: 'mediabuyer',
          task: 'set_status',
          payload: { campaignChannelId: row.id, status: 'paused', level: 'adset' },
          priority: 1,
          dedupe: ['pause_orphaned', row.id, utcDate()],
        });
      }

      // Approvals nobody answered in time.
      const expired = await ctx.env.DB.prepare(
        `UPDATE approvals SET status = 'expired', decided_at = ?
          WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
      )
        .bind(nowIso(), nowIso())
        .run();
      const expiredCount = expired.meta?.changes ?? 0;
      if (expiredCount > 0) findings.push(`${expiredCount} approvals expired unanswered`);

      // Spend with no revenue at all over the last week is worth a look.
      const dead = await all<{ channel: string; spend: number; revenue: number }>(
        ctx.env,
        `SELECT channel,
                SUM(spend_cents) AS spend,
                SUM(revenue_cents) AS revenue
           FROM metrics
          WHERE metric_date >= date('now', '-7 day') AND entity_type = 'campaign_channel'
          GROUP BY channel
         HAVING spend > 5000 AND revenue = 0`,
      );
      for (const row of dead) {
        findings.push(`${row.channel} spent ${row.spend} cents in 7 days with no attributed revenue`);
        await ctx.incident({
          severity: 'warn',
          code: 'spend_without_revenue',
          message: `${row.channel} has spend and no attributed revenue this week`,
          context: row,
        });
      }

      return ok(
        findings.length ? `${findings.length} findings` : 'nothing to flag',
        { data: { findings, spend_today_cents: spent, by_channel: byChannel } },
      );
    },
  },
};

async function markNeedsReauth(
  ctx: Parameters<Agent['tasks'][string]>[0],
  account: Account,
  detail: string,
): Promise<void> {
  await ctx.env.DB.prepare(`UPDATE accounts SET status = 'needs_reauth', updated_at = ? WHERE id = ?`)
    .bind(nowIso(), account.id)
    .run();
  const existing = await first<{ id: string }>(
    ctx.env,
    `SELECT id FROM incidents
      WHERE code = 'account_needs_reauth' AND resolved_at IS NULL
        AND json_extract(context, '$.account_id') = ?`,
    account.id,
  );
  if (existing) return;
  await insert(ctx.env, 'incidents', {
    id: id('inc'),
    severity: 'error',
    source: 'agent:guardian',
    code: 'account_needs_reauth',
    message: `${account.channel}/${account.surface} credentials failed: ${detail.slice(0, 200)}`,
    context: JSON.stringify({ account_id: account.id, channel: account.channel }),
    created_at: nowIso(),
  });
}
