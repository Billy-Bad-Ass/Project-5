/**
 * Budget allocation.
 *
 * The problem is a bandit: each channel has an unknown true return, and every
 * dollar spent learning about one channel is a dollar not spent on the current
 * best. Thompson sampling handles that better than "pause anything under a
 * target ROAS", which starves a channel before it has enough data to judge.
 *
 * Pure functions with no I/O, so the allocation logic is unit-testable and the
 * optimizer agent stays a thin wrapper around it.
 */

export interface ChannelPerformance {
  channel: string;
  campaignChannelId: string;
  /** Trailing window totals. */
  spendCents: number;
  conversions: number;
  revenueCents: number;
  clicks: number;
  impressions: number;
  currentDailyBudgetCents: number;
  /** Days the channel has been running. Used to protect the learning phase. */
  daysActive: number;
}

export interface AllocationConstraints {
  totalDailyBudgetCents: number;
  /** Never take a channel below this while it is active. */
  minPerChannelCents: number;
  /** Never let one channel take more than this share, 0 to 1. */
  maxShare: number;
  /** Cap on how much a single cycle may move a channel, 0 to 1. */
  maxChangeRatio: number;
  /** Channels newer than this keep their budget so they can finish learning. */
  learningPhaseDays: number;
  /** Deterministic seed. Same inputs give the same plan, which matters for audit. */
  seed?: number;
}

export interface Allocation {
  campaignChannelId: string;
  channel: string;
  currentCents: number;
  proposedCents: number;
  deltaCents: number;
  /** Sampled return per 1000 cents of spend. Higher is better. */
  score: number;
  reason: string;
}

export const DEFAULT_CONSTRAINTS: Omit<AllocationConstraints, 'totalDailyBudgetCents'> = {
  minPerChannelCents: 500,
  maxShare: 0.5,
  maxChangeRatio: 0.35,
  learningPhaseDays: 3,
};

/**
 * Draw one sample of each channel's true conversion rate from its posterior,
 * then split the budget in proportion to expected value.
 *
 * Beta(1,1) prior over conversion-per-click, scaled by observed revenue per
 * conversion. A channel with no data samples wide, so it sometimes wins and
 * gets a chance to prove itself.
 */
export function allocate(
  performances: ChannelPerformance[],
  constraints: AllocationConstraints,
): Allocation[] {
  if (performances.length === 0) return [];
  const rng = mulberry32(constraints.seed ?? 42);

  const scored = performances.map((p) => {
    // Posterior over conversion rate given clicks.
    const alpha = 1 + p.conversions;
    const beta = 1 + Math.max(0, p.clicks - p.conversions);
    const sampledRate = sampleBeta(alpha, beta, rng);

    // Revenue per conversion, shrunk toward the portfolio mean when thin.
    const revenuePerConversion =
      p.conversions > 0 ? p.revenueCents / p.conversions : portfolioRpc(performances);

    // Clicks bought per 1000 cents. Without spend history, assume the portfolio rate.
    const clicksPerKCent =
      p.spendCents > 0 ? (p.clicks / p.spendCents) * 1000 : portfolioClicksPerKCent(performances);

    const score = sampledRate * revenuePerConversion * clicksPerKCent;
    return { p, score };
  });

  const totalScore = scored.reduce((sum, s) => sum + s.score, 0);
  const equalShare = constraints.totalDailyBudgetCents / performances.length;

  return scored.map(({ p, score }) => {
    let target: number;
    let reason: string;

    if (p.daysActive < constraints.learningPhaseDays) {
      target = p.currentDailyBudgetCents || equalShare;
      reason = `held: ${p.daysActive} of ${constraints.learningPhaseDays} learning days`;
    } else if (totalScore <= 0) {
      target = equalShare;
      reason = 'no signal yet, split evenly';
    } else {
      target = (score / totalScore) * constraints.totalDailyBudgetCents;
      reason = `sampled score ${score.toFixed(2)} of ${totalScore.toFixed(2)}`;
    }

    // Share ceiling, then per-cycle move limit, then floor. Order matters:
    // the floor must win so an active channel is never starved to zero.
    target = Math.min(target, constraints.totalDailyBudgetCents * constraints.maxShare);

    const current = p.currentDailyBudgetCents;
    if (current > 0) {
      const maxMove = current * constraints.maxChangeRatio;
      if (Math.abs(target - current) > maxMove) {
        target = target > current ? current + maxMove : current - maxMove;
        reason += `, move capped at ${Math.round(constraints.maxChangeRatio * 100)}%`;
      }
    }
    target = Math.max(target, constraints.minPerChannelCents);

    const proposed = Math.round(target);
    return {
      campaignChannelId: p.campaignChannelId,
      channel: p.channel,
      currentCents: current,
      proposedCents: proposed,
      deltaCents: proposed - current,
      score,
      reason,
    };
  });
}

/**
 * Channels that have spent enough to judge and are clearly losing money.
 * Deliberately strict: pausing a channel that was about to work is expensive.
 */
export function losers(
  performances: ChannelPerformance[],
  opts: { minSpendCents: number; targetRoas: number; minDays: number },
): { performance: ChannelPerformance; roas: number; reason: string }[] {
  return performances
    .filter((p) => p.spendCents >= opts.minSpendCents && p.daysActive >= opts.minDays)
    .map((p) => ({ p, roas: p.spendCents > 0 ? p.revenueCents / p.spendCents : 0 }))
    .filter(({ roas }) => roas < opts.targetRoas)
    .map(({ p, roas }) => ({
      performance: p,
      roas,
      reason: `ROAS ${roas.toFixed(2)} below target ${opts.targetRoas} after ${p.spendCents} cents over ${p.daysActive} days`,
    }));
}

/** Blended return on ad spend for a set of channels. */
export function blendedRoas(performances: ChannelPerformance[]): number {
  const spend = performances.reduce((s, p) => s + p.spendCents, 0);
  const revenue = performances.reduce((s, p) => s + p.revenueCents, 0);
  return spend > 0 ? revenue / spend : 0;
}

/** Customer acquisition cost across a set of channels. */
export function blendedCac(performances: ChannelPerformance[]): number | null {
  const spend = performances.reduce((s, p) => s + p.spendCents, 0);
  const conversions = performances.reduce((s, p) => s + p.conversions, 0);
  return conversions > 0 ? spend / conversions : null;
}

// --- sampling -------------------------------------------------------------

function portfolioRpc(performances: ChannelPerformance[]): number {
  const conversions = performances.reduce((s, p) => s + p.conversions, 0);
  const revenue = performances.reduce((s, p) => s + p.revenueCents, 0);
  return conversions > 0 ? revenue / conversions : 1;
}

function portfolioClicksPerKCent(performances: ChannelPerformance[]): number {
  const spend = performances.reduce((s, p) => s + p.spendCents, 0);
  const clicks = performances.reduce((s, p) => s + p.clicks, 0);
  return spend > 0 ? (clicks / spend) * 1000 : 1;
}

/** Beta sample via two Gamma draws. */
function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x + y > 0 ? x / (x + y) : 0.5;
}

/** Marsaglia and Tsang's method, with the Johnk boost for shape below 1. */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 200; i++) {
    const z = normal(rng);
    const v = (1 + c * z) ** 3;
    if (v <= 0) continue;
    const u = rng();
    if (Math.log(u) < 0.5 * z * z + d - d * v + d * Math.log(v)) {
      return d * v;
    }
  }
  return d;
}

function normal(rng: () => number): number {
  // Box-Muller. Guard against log(0).
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Small deterministic PRNG so an allocation can be reproduced from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
