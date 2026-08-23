import type { AgentId } from '../types';

/**
 * What each cron trigger does. This is the whole automatic orchestration: the
 * crons enqueue work, the queue consumer runs it, and agents enqueue follow-on
 * work of their own. Nothing here talks to a platform directly.
 */
export interface ScheduledTask {
  agent: AgentId;
  task: string;
  payload?: Record<string, unknown>;
  priority?: number;
  /** Parts hashed into the idempotency key, on top of agent and task. */
  dedupe?: (string | number)[];
}

export interface CronPlan {
  name: string;
  describe: string;
  tasks: ScheduledTask[];
}

/**
 * Cron expressions must match wrangler.toml exactly. Cloudflare passes the
 * expression through as `event.cron`.
 */
export const CRON_PLANS: Record<string, (nowIso: string) => CronPlan> = {
  // Every five minutes: move due work forward. Cheap, no model calls.
  '*/5 * * * *': () => ({
    name: 'tick',
    describe: 'Publish anything due and drain delayed jobs.',
    tasks: [
      { agent: 'publisher', task: 'publish_due', payload: { limit: 10 }, priority: 2 },
    ],
  }),

  // Hourly: refresh the numbers everything else reasons about.
  '15 * * * *': (now) => ({
    name: 'hourly',
    describe: 'Sync platform metrics and Stripe revenue.',
    tasks: [
      { agent: 'analyst', task: 'sync_metrics', payload: { days: 2 }, priority: 3, dedupe: [hour(now)] },
      { agent: 'analyst', task: 'attribute_revenue', payload: { days: 2 }, priority: 3, dedupe: [hour(now)] },
      { agent: 'guardian', task: 'audit', priority: 3, dedupe: [hour(now)] },
    ],
  }),

  // Every six hours: move money.
  '30 */6 * * *': (now) => ({
    name: 'optimize',
    describe: 'Reallocate budget and pause proven losers.',
    tasks: [
      { agent: 'analyst', task: 'sync_metrics', payload: { days: 3 }, priority: 3, dedupe: [sixHourBucket(now)] },
      { agent: 'optimizer', task: 'reallocate', payload: { days: 14 }, priority: 4, dedupe: [sixHourBucket(now)] },
      { agent: 'optimizer', task: 'prune', payload: { days: 14 }, priority: 4, dedupe: [sixHourBucket(now)] },
    ],
  }),

  // Daily: the thinking pass.
  '0 13 * * *': (now) => ({
    name: 'daily',
    describe: 'Health, report, refill the creative pipeline, refresh market signals.',
    tasks: [
      { agent: 'guardian', task: 'health_check', priority: 1, dedupe: [day(now)] },
      { agent: 'analyst', task: 'sync_metrics', payload: { days: 7 }, priority: 2, dedupe: [day(now)] },
      { agent: 'analyst', task: 'attribute_revenue', payload: { days: 7 }, priority: 2, dedupe: [day(now)] },
      { agent: 'quant', task: 'refresh_signals', priority: 5, dedupe: [day(now)] },
      { agent: 'strategist', task: 'plan_organic', payload: { targetPerChannel: 3 }, priority: 5, dedupe: [day(now)] },
      { agent: 'producer', task: 'find_missing_media', priority: 6, dedupe: [day(now)] },
      { agent: 'publisher', task: 'schedule_batch', payload: { perChannel: 2 }, priority: 5, dedupe: [day(now)] },
      { agent: 'analyst', task: 'daily_report', payload: { days: 7 }, priority: 7, dedupe: [day(now)] },
    ],
  }),

  // Weekly: step back.
  '0 14 * * 1': (now) => ({
    name: 'weekly',
    describe: 'Portfolio review, refresh voice exemplars, re-read the offer page.',
    tasks: [
      { agent: 'scout', task: 'refresh_exemplars', priority: 4, dedupe: [week(now)] },
      { agent: 'scout', task: 'research_offer', priority: 4, dedupe: [week(now)] },
      { agent: 'strategist', task: 'portfolio_review', priority: 5, dedupe: [week(now)] },
    ],
  }),
};

export function planFor(cron: string, nowIso: string): CronPlan | undefined {
  return CRON_PLANS[cron]?.(nowIso);
}

/** Manual full sweep, used by POST /api/run and by `wrangler dev` testing. */
export function fullSweep(nowIso: string): CronPlan {
  return {
    name: 'manual',
    describe: 'Everything the daily pass does, run on demand.',
    tasks: CRON_PLANS['0 13 * * *']!(nowIso).tasks,
  };
}

const day = (iso: string) => iso.slice(0, 10);
const hour = (iso: string) => iso.slice(0, 13);
const week = (iso: string) => {
  const d = new Date(iso);
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return start.toISOString().slice(0, 10);
};
const sixHourBucket = (iso: string) => {
  const d = new Date(iso);
  return `${iso.slice(0, 10)}:${Math.floor(d.getUTCHours() / 6)}`;
};
