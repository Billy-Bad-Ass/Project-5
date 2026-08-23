import { all } from '../lib/db';
import { utcDate } from '../lib/time';
import {
  allocate,
  blendedRoas,
  DEFAULT_CONSTRAINTS,
  losers,
  type ChannelPerformance,
} from '../orchestrator/allocator';
import { channelPerformance } from './analyst';
import type { Channel, Offer } from '../types';
import { type Agent, num, ok, str } from './agent';

/**
 * The optimizer decides where the money goes tomorrow.
 *
 * It does not talk to a model. Allocation is a bandit problem with a closed
 * form answer, and a model asked to "reallocate the budget" would produce
 * something plausible and unreproducible. This produces the same plan from the
 * same numbers every time, which is what makes it auditable.
 */
export const optimizer: Agent = {
  id: 'optimizer',
  describe: 'Reallocates budget with Thompson sampling and pauses proven losers.',

  tasks: {
    /** Propose a new split across active ad channels. */
    async reallocate(ctx, payload) {
      const days = num(payload, 'days') ?? 14;
      const performances = await channelPerformance(ctx.env, days);
      const active = performances.filter((p) => p.currentDailyBudgetCents > 0);
      if (active.length === 0) return ok('no active ad channels to reallocate');

      const totalBudget = Math.min(
        ctx.config.dailySpendCapCents,
        active.reduce((sum, p) => sum + p.currentDailyBudgetCents, 0),
      );

      // Seed from the date so a given day's plan is reproducible on re-run.
      const seed = Number(utcDate().replace(/-/g, ''));
      const plan = allocate(active, {
        ...DEFAULT_CONSTRAINTS,
        totalDailyBudgetCents: totalBudget,
        seed,
      });

      // Only act on moves large enough to be worth an API call and a retrain.
      const material = plan.filter(
        (a) => Math.abs(a.deltaCents) >= Math.max(100, a.currentCents * 0.1),
      );

      let enqueued = 0;
      for (const allocation of material) {
        const jobId = await ctx.enqueue({
          agent: 'mediabuyer',
          task: 'apply_budget',
          payload: {
            campaignChannelId: allocation.campaignChannelId,
            dailyBudgetCents: allocation.proposedCents,
            rationale: `optimizer: ${allocation.reason}`,
          },
          priority: 4,
          dedupe: ['apply_budget', allocation.campaignChannelId, utcDate()],
        });
        if (jobId) enqueued++;
      }

      await ctx.decide({
        agent: 'optimizer',
        action: 'reallocate_budget',
        rationale: `redistributed ${totalBudget} cents/day across ${active.length} channels`,
        evidence: {
          blended_roas: blendedRoas(active),
          window_days: days,
          seed,
        },
        proposed: {
          plan: plan.map((a) => ({
            channel: a.channel,
            from: a.currentCents,
            to: a.proposedCents,
            reason: a.reason,
          })),
        },
      });

      return ok(`${material.length} material moves, ${enqueued} queued`, {
        enqueued,
        data: { plan },
      });
    },

    /**
     * Pause channels that have spent enough to judge and are losing money.
     * The thresholds come from the offer's target CAC where one is set.
     */
    async prune(ctx, payload) {
      const days = num(payload, 'days') ?? 14;
      const minSpendCents = num(payload, 'minSpendCents') ?? 5_000;
      const performances = await channelPerformance(ctx.env, days);

      const offers = await all<Offer>(ctx.env, `SELECT * FROM offers WHERE status = 'active'`);
      // Break-even ROAS given the blended gross margin, with a small buffer.
      const marginBps =
        offers.length > 0
          ? offers.reduce((s, o) => s + o.gross_margin_bps, 0) / offers.length
          : 10_000;
      const targetRoas = num(payload, 'targetRoas') ?? Math.max(1, 10_000 / marginBps) * 1.1;

      const candidates = losers(performances, {
        minSpendCents,
        targetRoas,
        minDays: DEFAULT_CONSTRAINTS.learningPhaseDays + 2,
      });
      if (candidates.length === 0) {
        return ok(`nothing below a ROAS of ${targetRoas.toFixed(2)}`);
      }

      let enqueued = 0;
      for (const candidate of candidates) {
        await ctx.decide({
          agent: 'optimizer',
          action: 'pause_losing_channel',
          targetType: 'campaign_channel',
          targetId: candidate.performance.campaignChannelId,
          channel: candidate.performance.channel as Channel,
          rationale: candidate.reason,
          evidence: {
            spend_cents: candidate.performance.spendCents,
            revenue_cents: candidate.performance.revenueCents,
            roas: candidate.roas,
            target_roas: targetRoas,
          },
        });
        const jobId = await ctx.enqueue({
          agent: 'mediabuyer',
          task: 'set_status',
          payload: {
            campaignChannelId: candidate.performance.campaignChannelId,
            status: 'paused',
            level: 'adset',
            rationale: candidate.reason,
          },
          priority: 3,
          dedupe: ['prune', candidate.performance.campaignChannelId, utcDate()],
        });
        if (jobId) enqueued++;
      }

      return ok(`${candidates.length} channels below target, ${enqueued} pause jobs queued`, {
        enqueued,
        data: {
          target_roas: targetRoas,
          candidates: candidates.map((c) => ({
            channel: c.performance.channel,
            roas: c.roas,
            reason: c.reason,
          })),
        },
      });
    },

    /** Read-only: what would reallocate do right now? Used by the console. */
    async preview(ctx, payload) {
      const days = num(payload, 'days') ?? 14;
      const performances = await channelPerformance(ctx.env, days);
      const active = performances.filter((p) => p.currentDailyBudgetCents > 0);
      const totalBudget = Math.min(
        ctx.config.dailySpendCapCents,
        active.reduce((sum, p) => sum + p.currentDailyBudgetCents, 0),
      );
      const plan = allocate(active, {
        ...DEFAULT_CONSTRAINTS,
        totalDailyBudgetCents: totalBudget,
        seed: Number(str(payload, 'seed') ?? utcDate().replace(/-/g, '')),
      });
      return ok('preview only, nothing queued', {
        data: { plan, blended_roas: blendedRoas(active) },
      });
    },
  },
};

/** Exposed for the console so it can show the same numbers the agent used. */
export async function currentPerformance(
  env: import('../env').Env,
  days = 14,
): Promise<ChannelPerformance[]> {
  return channelPerformance(env, days);
}
