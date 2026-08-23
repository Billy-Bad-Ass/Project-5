import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

/**
 * One Durable Object per campaign.
 *
 * Two jobs:
 *  1. Serialise budget changes. D1 has no row locks, so two optimizer passes
 *     landing at once could both read the old budget and both write a raise.
 *     Routing every change through one object per campaign removes that race.
 *  2. Hold a short-lived spend counter, so a runaway loop is caught inside a
 *     cycle rather than at the next metrics sync an hour later.
 */
interface BudgetState {
  campaignId: string;
  dailyBudgetCents: number;
  /** UTC date the counter below belongs to. */
  ledgerDate: string;
  appliedChangesToday: number;
  lastChangeAt: string | null;
}

const MAX_CHANGES_PER_DAY = 8;

export class CampaignRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/claim-budget-change':
        return this.claimBudgetChange(await request.json());
      case '/state':
        return Response.json(await this.state());
      case '/reset':
        await this.ctx.storage.deleteAll();
        return Response.json({ ok: true });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  /**
   * Ask permission to change a campaign's budget. Returns allowed:false when
   * the campaign has already been adjusted too many times today, which is the
   * cheapest possible defence against an optimizer that oscillates.
   */
  private async claimBudgetChange(body: unknown): Promise<Response> {
    const input = body as { campaignId?: string; newDailyBudgetCents?: number };
    if (!input.campaignId || typeof input.newDailyBudgetCents !== 'number') {
      return Response.json({ allowed: false, reason: 'bad request' }, { status: 400 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const stored = (await this.ctx.storage.get<BudgetState>('budget')) ?? {
      campaignId: input.campaignId,
      dailyBudgetCents: 0,
      ledgerDate: today,
      appliedChangesToday: 0,
      lastChangeAt: null,
    };

    if (stored.ledgerDate !== today) {
      stored.ledgerDate = today;
      stored.appliedChangesToday = 0;
    }

    if (stored.appliedChangesToday >= MAX_CHANGES_PER_DAY) {
      return Response.json({
        allowed: false,
        reason: `already changed ${stored.appliedChangesToday} times today`,
        state: stored,
      });
    }

    // Anything under a minute apart is almost certainly two workers racing.
    if (stored.lastChangeAt && Date.now() - new Date(stored.lastChangeAt).getTime() < 60_000) {
      return Response.json({
        allowed: false,
        reason: 'a change was applied less than a minute ago',
        state: stored,
      });
    }

    const previous = stored.dailyBudgetCents;
    stored.dailyBudgetCents = input.newDailyBudgetCents;
    stored.appliedChangesToday += 1;
    stored.lastChangeAt = new Date().toISOString();
    await this.ctx.storage.put('budget', stored);

    return Response.json({ allowed: true, previousCents: previous, state: stored });
  }

  private async state(): Promise<BudgetState | null> {
    return (await this.ctx.storage.get<BudgetState>('budget')) ?? null;
  }
}

/** Helper so callers do not have to build the request by hand. */
export async function claimBudgetChange(
  env: Env,
  campaignId: string,
  newDailyBudgetCents: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const stub = env.CAMPAIGN_ROOM.get(env.CAMPAIGN_ROOM.idFromName(campaignId));
  const res = await stub.fetch('https://campaign-room/claim-budget-change', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ campaignId, newDailyBudgetCents }),
  });
  return res.json();
}
