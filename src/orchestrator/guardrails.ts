import type { Env } from '../env';
import type { RuntimeConfig } from '../lib/config';
import { all, first, parseJson } from '../lib/db';
import { utcDate, daysAgoUtc } from '../lib/time';
import type { Channel } from '../types';
import type { AgentContext } from './context';

/**
 * Everything that can stop an agent before it touches a live account.
 *
 * The rule the whole system is built around: an agent proposes, a guardrail
 * decides, and a human confirms anything that spends money or speaks publicly.
 */

export interface GateResult {
  allowed: boolean;
  reason: string;
  /** Set when the caller should stop and wait for a person. */
  needsApproval?: boolean;
}

export const ALLOWED = (reason = 'ok'): GateResult => ({ allowed: true, reason });

/** Total spend recorded across every channel for a UTC day. */
export async function spendToday(env: Env, date = utcDate()): Promise<number> {
  const row = await first<{ total: number | null }>(
    env,
    `SELECT SUM(amount_cents) AS total FROM spend_ledger
      WHERE ledger_date = ? AND source = 'platform_sync'`,
    date,
  );
  return row?.total ?? 0;
}

export async function spendByChannel(
  env: Env,
  date = utcDate(),
): Promise<Record<string, number>> {
  const rows = await all<{ channel: string; total: number }>(
    env,
    `SELECT channel, SUM(amount_cents) AS total FROM spend_ledger
      WHERE ledger_date = ? AND source = 'platform_sync'
      GROUP BY channel`,
    date,
  );
  return Object.fromEntries(rows.map((r) => [r.channel, r.total]));
}

/**
 * Would this budget change push the portfolio past the daily cap?
 *
 * Compares committed daily budgets, not spend so far, because a budget raised
 * at 09:00 spends for the rest of the day.
 */
export async function budgetGate(
  env: Env,
  config: RuntimeConfig,
  input: { campaignChannelId?: string; newDailyBudgetCents: number },
): Promise<GateResult> {
  const row = await first<{ total: number | null }>(
    env,
    `SELECT SUM(cc.daily_budget_cents) AS total
       FROM campaign_channels cc
       JOIN campaigns c ON c.id = cc.campaign_id
      WHERE c.status = 'active' AND cc.status = 'active'
        AND (? IS NULL OR cc.id != ?)`,
    input.campaignChannelId ?? null,
    input.campaignChannelId ?? null,
  );
  const committedElsewhere = row?.total ?? 0;
  const projected = committedElsewhere + input.newDailyBudgetCents;

  if (projected > config.dailySpendCapCents) {
    return {
      allowed: false,
      reason: `daily budget cap: ${projected} cents committed against a cap of ${config.dailySpendCapCents}`,
    };
  }
  return ALLOWED(`${projected} of ${config.dailySpendCapCents} cents committed`);
}

/** Hard stop when actual spend has already reached the cap for the day. */
export async function spendCircuitBreaker(
  env: Env,
  config: RuntimeConfig,
): Promise<GateResult> {
  const spent = await spendToday(env);
  if (spent >= config.dailySpendCapCents) {
    return {
      allowed: false,
      reason: `circuit breaker: ${spent} cents spent today, cap is ${config.dailySpendCapCents}`,
    };
  }
  return ALLOWED(`${spent} of ${config.dailySpendCapCents} cents spent today`);
}

/**
 * Spend anomaly detection. Compares today's pace against the trailing median,
 * which catches a runaway ad set faster than the daily cap does.
 */
export async function spendAnomaly(
  env: Env,
  channel: Channel,
): Promise<{ anomalous: boolean; todayCents: number; medianCents: number }> {
  const rows = await all<{ ledger_date: string; total: number }>(
    env,
    `SELECT ledger_date, SUM(amount_cents) AS total FROM spend_ledger
      WHERE channel = ? AND ledger_date >= ? AND source = 'platform_sync'
      GROUP BY ledger_date ORDER BY ledger_date`,
    channel,
    daysAgoUtc(14),
  );
  const today = utcDate();
  const todayCents = rows.find((r) => r.ledger_date === today)?.total ?? 0;
  const history = rows.filter((r) => r.ledger_date !== today).map((r) => r.total).sort((a, b) => a - b);
  if (history.length < 5) return { anomalous: false, todayCents, medianCents: 0 };

  const medianCents = history[Math.floor(history.length / 2)] ?? 0;
  // Scale by how far into the UTC day we are, so a morning check is fair.
  const dayFraction = Math.max(0.1, new Date().getUTCHours() / 24);
  const projected = todayCents / dayFraction;
  return {
    anomalous: medianCents > 0 && projected > medianCents * 2.5,
    todayCents,
    medianCents,
  };
}

/** Does this action need a person before it can go out? */
export function approvalGate(
  config: RuntimeConfig,
  input: { action: string; risk?: 'low' | 'normal' | 'high' },
): GateResult {
  if (input.risk === 'high') {
    return { allowed: false, needsApproval: true, reason: 'high risk actions always need a human' };
  }
  if (config.requireHumanApproval) {
    return {
      allowed: false,
      needsApproval: true,
      reason: 'REQUIRE_HUMAN_APPROVAL is on',
    };
  }
  return ALLOWED('auto-approved');
}

/** Is this channel switched on right now? */
export function channelGate(config: RuntimeConfig, channel: Channel): GateResult {
  if (config.paused) return { allowed: false, reason: 'orchestrator is paused' };
  if (config.enabledChannels.length > 0 && !config.enabledChannels.includes(channel)) {
    return { allowed: false, reason: `${channel} is not in enabledChannels` };
  }
  return ALLOWED();
}

/**
 * Run every gate that applies to spending money on a channel. Returns the first
 * failure so the caller has one clear reason to log or show a human.
 */
export async function checkSpendAction(
  ctx: AgentContext,
  input: { channel: Channel; campaignChannelId?: string; newDailyBudgetCents: number },
): Promise<GateResult> {
  const channel = channelGate(ctx.config, input.channel);
  if (!channel.allowed) return channel;

  const breaker = await spendCircuitBreaker(ctx.env, ctx.config);
  if (!breaker.allowed) {
    await ctx.incident({
      severity: 'critical',
      code: 'spend_cap_reached',
      message: breaker.reason,
      context: { channel: input.channel },
    });
    return breaker;
  }

  const budget = await budgetGate(ctx.env, ctx.config, input);
  if (!budget.allowed) return budget;

  const anomaly = await spendAnomaly(ctx.env, input.channel);
  if (anomaly.anomalous) {
    await ctx.incident({
      severity: 'error',
      code: 'spend_anomaly',
      message: `${input.channel} is pacing well above its trailing median`,
      context: anomaly,
    });
    return {
      allowed: false,
      reason: `spend anomaly on ${input.channel}: ${anomaly.todayCents} today against a median of ${anomaly.medianCents}`,
    };
  }

  return ALLOWED(budget.reason);
}

/**
 * One approval authorises one change.
 *
 * A job that follows an approval carries that approval's id. Only the id: the
 * row behind it — whether it is still approved, what it was for, and the
 * number the person actually saw — is read from the database here, so a
 * replayed or forged queue message cannot claim an approval it never got, and
 * cannot spend a real one on a different change.
 */
export interface ApprovalRecord {
  status: string;
  subject_type: string;
  subject_id: string;
  decided_by: string | null;
  decided_at: string | null;
  /** The decision's proposed JSON, so the amount can be checked against it. */
  proposed: string | null;
}

/** What this approval has to authorise for the caller to proceed. */
export interface ApprovalRequirement {
  subjectType: string;
  subjectId: string;
  /** Field in the decision's proposed JSON that must equal `value`. */
  field?: string;
  value?: number;
}

export async function approvalById(
  env: Env,
  approvalId: string,
): Promise<ApprovalRecord | null> {
  return first<ApprovalRecord>(
    env,
    `SELECT a.status, a.subject_type, a.subject_id, a.decided_by, a.decided_at,
            d.proposed
       FROM approvals a
       LEFT JOIN decisions d ON d.id = a.decision_id
      WHERE a.id = ?`,
    approvalId,
  );
}

/**
 * Does this approval authorise this exact change? Pure, so the rule that
 * guards every live spend is testable without a database.
 */
export function approvalMatches(
  row: ApprovalRecord | null,
  want: ApprovalRequirement,
): boolean {
  if (!row) return false;
  if (row.status !== 'approved') return false;
  if (row.subject_type !== want.subjectType) return false;
  if (row.subject_id !== want.subjectId) return false;
  if (want.field === undefined) return true;

  // An amount was named, so it has to be the amount the person saw. Without
  // this an approval of 1500 cents would clear a job asking for 200000.
  const proposed = parseJson<Record<string, unknown> | null>(row.proposed, null);
  if (!proposed) return false;
  const actual = proposed[want.field];
  return typeof actual === 'number' && actual === want.value;
}

/**
 * Is there a standing approval for this subject?
 *
 * This is the weaker check, and it is only correct where the subject is
 * approved once and acted on once — a campaign plan a person signs off before
 * it is launched. Do not reach for it to gate a repeating action: any past
 * approval on the subject satisfies it forever, which is how a single approved
 * budget rise once cleared every later rise on the same channel. Anything that
 * can happen more than once wants `approvedFor` and an approval id.
 */
export async function hasStandingApproval(
  env: Env,
  subjectType: string,
  subjectId: string,
): Promise<{ approved: boolean; by?: string; at?: string }> {
  const row = await first<{ decided_by: string | null; decided_at: string | null }>(
    env,
    `SELECT decided_by, decided_at FROM approvals
      WHERE subject_type = ? AND subject_id = ? AND status = 'approved'
      ORDER BY decided_at DESC LIMIT 1`,
    subjectType,
    subjectId,
  );
  if (!row) return { approved: false };
  return {
    approved: true,
    ...(row.decided_by ? { by: row.decided_by } : {}),
    ...(row.decided_at ? { at: row.decided_at } : {}),
  };
}

/**
 * Fetch and check in one step. Returns not-approved for a missing id rather
 * than throwing, because "no approval was quoted" and "the approval quoted
 * does not cover this" are the same answer to the caller: ask a human.
 */
export async function approvedFor(
  env: Env,
  approvalId: string | undefined | null,
  want: ApprovalRequirement,
): Promise<{ approved: boolean; by?: string; at?: string }> {
  if (!approvalId) return { approved: false };
  const row = await approvalById(env, approvalId);
  if (!approvalMatches(row, want)) return { approved: false };
  return {
    approved: true,
    ...(row!.decided_by ? { by: row!.decided_by } : {}),
    ...(row!.decided_at ? { at: row!.decided_at } : {}),
  };
}
