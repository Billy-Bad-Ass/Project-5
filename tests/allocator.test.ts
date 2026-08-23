import { describe, expect, it } from 'vitest';
import {
  allocate,
  blendedCac,
  blendedRoas,
  DEFAULT_CONSTRAINTS,
  losers,
  mulberry32,
  type ChannelPerformance,
} from '../src/orchestrator/allocator';

function channel(overrides: Partial<ChannelPerformance> = {}): ChannelPerformance {
  return {
    channel: 'tiktok',
    campaignChannelId: 'cch_1',
    spendCents: 10_000,
    conversions: 10,
    revenueCents: 30_000,
    clicks: 500,
    impressions: 50_000,
    currentDailyBudgetCents: 5_000,
    daysActive: 14,
    ...overrides,
  };
}

describe('budget allocator', () => {
  const constraints = { ...DEFAULT_CONSTRAINTS, totalDailyBudgetCents: 20_000, seed: 7 };

  it('returns nothing for no channels', () => {
    expect(allocate([], constraints)).toEqual([]);
  });

  it('is deterministic for a given seed', () => {
    const performances = [
      channel({ campaignChannelId: 'a', channel: 'tiktok' }),
      channel({ campaignChannelId: 'b', channel: 'facebook', conversions: 2, revenueCents: 5_000 }),
    ];
    const first = allocate(performances, constraints);
    const second = allocate(performances, constraints);
    expect(second.map((a) => a.proposedCents)).toEqual(first.map((a) => a.proposedCents));
  });

  it('gives more budget to the channel that actually earns', () => {
    // Run several seeds: one Thompson draw is stochastic, the tendency is not.
    let winnerAhead = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const plan = allocate(
        [
          channel({ campaignChannelId: 'winner', conversions: 60, revenueCents: 180_000, clicks: 600 }),
          channel({
            campaignChannelId: 'loser',
            channel: 'facebook',
            conversions: 1,
            revenueCents: 1_000,
            clicks: 600,
          }),
        ],
        { ...constraints, seed, maxChangeRatio: 1 },
      );
      const winner = plan.find((a) => a.campaignChannelId === 'winner')!;
      const loser = plan.find((a) => a.campaignChannelId === 'loser')!;
      if (winner.proposedCents > loser.proposedCents) winnerAhead++;
    }
    expect(winnerAhead).toBeGreaterThan(20);
  });

  it('never proposes less than the floor', () => {
    const plan = allocate(
      [channel({ conversions: 0, revenueCents: 0, clicks: 900, currentDailyBudgetCents: 600 })],
      { ...constraints, minPerChannelCents: 500 },
    );
    expect(plan[0]!.proposedCents).toBeGreaterThanOrEqual(500);
  });

  it('caps how far a single cycle can move a budget', () => {
    const plan = allocate(
      [
        channel({ campaignChannelId: 'a', currentDailyBudgetCents: 10_000, conversions: 90, revenueCents: 400_000 }),
        channel({ campaignChannelId: 'b', channel: 'x', currentDailyBudgetCents: 10_000, conversions: 0, revenueCents: 0 }),
      ],
      { ...constraints, maxChangeRatio: 0.2 },
    );
    for (const allocation of plan) {
      expect(Math.abs(allocation.deltaCents)).toBeLessThanOrEqual(
        Math.round(allocation.currentCents * 0.2) + 1,
      );
    }
  });

  it('protects a channel that is still in its learning phase', () => {
    const plan = allocate(
      [
        channel({ campaignChannelId: 'new', daysActive: 1, currentDailyBudgetCents: 3_000, conversions: 0, revenueCents: 0 }),
        channel({ campaignChannelId: 'old', channel: 'facebook', daysActive: 20 }),
      ],
      constraints,
    );
    const fresh = plan.find((a) => a.campaignChannelId === 'new')!;
    expect(fresh.proposedCents).toBe(3_000);
    expect(fresh.reason).toContain('learning');
  });

  it('splits evenly when there is no signal at all', () => {
    const plan = allocate(
      [
        channel({ campaignChannelId: 'a', spendCents: 0, clicks: 0, conversions: 0, revenueCents: 0, currentDailyBudgetCents: 0 }),
        channel({ campaignChannelId: 'b', channel: 'x', spendCents: 0, clicks: 0, conversions: 0, revenueCents: 0, currentDailyBudgetCents: 0 }),
      ],
      { ...constraints, totalDailyBudgetCents: 10_000 },
    );
    for (const allocation of plan) {
      expect(allocation.proposedCents).toBeGreaterThan(0);
    }
  });

  it('respects the maximum share for one channel', () => {
    const plan = allocate(
      [
        channel({ campaignChannelId: 'a', conversions: 500, revenueCents: 900_000, currentDailyBudgetCents: 0 }),
        channel({ campaignChannelId: 'b', channel: 'x', conversions: 0, revenueCents: 0, currentDailyBudgetCents: 0 }),
      ],
      { ...constraints, totalDailyBudgetCents: 20_000, maxShare: 0.5 },
    );
    const top = plan.find((a) => a.campaignChannelId === 'a')!;
    expect(top.proposedCents).toBeLessThanOrEqual(10_000);
  });
});

describe('losers', () => {
  it('ignores channels that have not spent enough to judge', () => {
    const result = losers([channel({ spendCents: 100, revenueCents: 0 })], {
      minSpendCents: 5_000,
      targetRoas: 1.5,
      minDays: 5,
    });
    expect(result).toEqual([]);
  });

  it('ignores channels still inside the learning window', () => {
    const result = losers([channel({ revenueCents: 0, daysActive: 2 })], {
      minSpendCents: 5_000,
      targetRoas: 1.5,
      minDays: 5,
    });
    expect(result).toEqual([]);
  });

  it('flags a channel that has spent enough and is losing money', () => {
    const result = losers([channel({ spendCents: 20_000, revenueCents: 2_000 })], {
      minSpendCents: 5_000,
      targetRoas: 1.5,
      minDays: 5,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.roas).toBeCloseTo(0.1);
  });
});

describe('portfolio maths', () => {
  it('computes blended ROAS', () => {
    expect(blendedRoas([channel({ spendCents: 10_000, revenueCents: 25_000 })])).toBe(2.5);
  });

  it('returns zero ROAS rather than dividing by zero', () => {
    expect(blendedRoas([channel({ spendCents: 0, revenueCents: 0 })])).toBe(0);
  });

  it('returns null CAC when nothing converted', () => {
    expect(blendedCac([channel({ conversions: 0 })])).toBeNull();
  });
});

describe('mulberry32', () => {
  it('produces the same stream for the same seed', () => {
    const a = mulberry32(99);
    const b = mulberry32(99);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('stays within the unit interval', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
