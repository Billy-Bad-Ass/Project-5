import { all, first, insert, parseJson, update } from '../lib/db';
import { id } from '../lib/ids';
import { nowIso } from '../lib/time';
import { adsFor } from '../platforms';
import { approvalGate, checkSpendAction, hasApproval } from '../orchestrator/guardrails';
import type { Account, Campaign, CampaignChannel, Channel, Creative, Offer } from '../types';
import { type Agent, failed, num, ok, str } from './agent';

/**
 * The mediabuyer creates and edits ad entities on the platforms.
 *
 * Two invariants:
 *  1. Everything it creates starts paused. Activation is always a separate,
 *     approved step, so a bug in creation cannot start spending.
 *  2. Every spend-affecting call passes the guardrails first.
 */
export const mediabuyer: Agent = {
  id: 'mediabuyer',
  describe: 'Creates and edits ad campaigns. Everything it creates starts paused.',

  tasks: {
    /** Mirror a local campaign onto each of its ad channels. */
    async launch_campaign(ctx, payload) {
      const campaignId = str(payload, 'campaignId');
      if (!campaignId) return failed('launch_campaign needs a campaignId');

      const campaign = await first<Campaign>(
        ctx.env,
        'SELECT * FROM campaigns WHERE id = ?',
        campaignId,
      );
      if (!campaign) return failed(`campaign ${campaignId} not found`);

      const offer = campaign.offer_id
        ? await first<Offer>(ctx.env, 'SELECT * FROM offers WHERE id = ?', campaign.offer_id)
        : null;
      if (!offer) return failed('campaign has no offer, so there is no landing url to send traffic to');

      const channels = await all<CampaignChannel>(
        ctx.env,
        `SELECT * FROM campaign_channels WHERE campaign_id = ? AND status = 'draft'`,
        campaignId,
      );
      if (channels.length === 0) return ok('no draft channels to launch');

      const launched: string[] = [];
      const blocked: string[] = [];

      for (const channelRow of channels) {
        const account = await first<Account>(
          ctx.env,
          'SELECT * FROM accounts WHERE id = ?',
          channelRow.account_id,
        );
        if (!account) {
          blocked.push(`${channelRow.channel}: account missing`);
          continue;
        }
        const adapter = adsFor(account.channel);
        if (!adapter) {
          blocked.push(`${channelRow.channel}: no ads adapter`);
          continue;
        }

        const gate = await checkSpendAction(ctx, {
          channel: account.channel,
          campaignChannelId: channelRow.id,
          newDailyBudgetCents: channelRow.daily_budget_cents,
        });
        if (!gate.allowed) {
          blocked.push(`${channelRow.channel}: ${gate.reason}`);
          continue;
        }

        // Creating a campaign upstream is itself gated: a person approves the
        // plan once, and that approval covers every channel on it.
        if (ctx.config.requireHumanApproval) {
          const signed = await hasApproval(ctx.env, 'campaign', campaignId);
          if (!signed.approved) {
            blocked.push(`${channelRow.channel}: campaign has not been approved yet`);
            continue;
          }
        }

        const decisionId = await ctx.decide({
          agent: 'mediabuyer',
          action: 'create_campaign',
          targetType: 'campaign_channel',
          targetId: channelRow.id,
          channel: account.channel,
          rationale: `launching ${campaign.name} on ${account.channel} at ${channelRow.daily_budget_cents} cents/day`,
          evidence: { gate: gate.reason },
          proposed: {
            daily_budget_cents: channelRow.daily_budget_cents,
            objective: campaign.objective,
          },
          risk: 'high',
        });

        try {
          const created = await adapter.createCampaign(
            { env: ctx.env, log: ctx.log, dryRun: ctx.config.dryRun },
            account,
            {
              name: `${campaign.name} [${channelRow.id.slice(-6)}]`,
              objective: campaign.objective,
              dailyBudgetCents: channelRow.daily_budget_cents,
              currency: campaign.currency,
              startsAt: campaign.starts_at,
              endsAt: campaign.ends_at,
              targeting: parseJson(channelRow.targeting, {}),
              landingUrl: offer.landing_url,
            },
          );

          await update(ctx.env, 'campaign_channels', channelRow.id, {
            external_id: created.campaign.externalId,
            external_adset_id: created.adSet.externalId,
            // Created, not running. Activation is task `set_status`.
            status: 'paused',
            last_synced_at: nowIso(),
          });
          await ctx.settle(decisionId, created.campaign.dryRun ? 'dry_run' : 'applied', {
            campaign_external_id: created.campaign.externalId,
            adset_external_id: created.adSet.externalId,
          });
          launched.push(channelRow.channel);

          // Attach whatever approved ad copy exists for this channel.
          await ctx.enqueue({
            agent: 'mediabuyer',
            task: 'attach_creatives',
            payload: { campaignChannelId: channelRow.id },
            priority: 3,
            dedupe: ['attach_creatives', channelRow.id],
          });
        } catch (err) {
          const message = String(err).slice(0, 400);
          await ctx.settle(decisionId, 'failed', { error: message });
          blocked.push(`${channelRow.channel}: ${message}`);
          await ctx.incident({
            severity: 'error',
            code: 'campaign_launch_failed',
            message: `could not launch ${campaign.name} on ${channelRow.channel}`,
            context: { campaign_channel_id: channelRow.id, error: message },
          });
        }
      }

      if (launched.length > 0) {
        await update(ctx.env, 'campaigns', campaignId, { status: 'active' });
      }
      return ok(`launched on ${launched.join(', ') || 'nothing'}`, {
        data: { launched, blocked },
      });
    },

    /** Upload approved ad copy against an existing ad set. */
    async attach_creatives(ctx, payload) {
      const campaignChannelId = str(payload, 'campaignChannelId');
      if (!campaignChannelId) return failed('attach_creatives needs a campaignChannelId');

      const channelRow = await first<CampaignChannel>(
        ctx.env,
        'SELECT * FROM campaign_channels WHERE id = ?',
        campaignChannelId,
      );
      if (!channelRow?.external_adset_id) return failed('ad set has not been created yet');

      const account = await first<Account>(
        ctx.env,
        'SELECT * FROM accounts WHERE id = ?',
        channelRow.account_id,
      );
      const campaign = await first<Campaign>(
        ctx.env,
        'SELECT * FROM campaigns WHERE id = ?',
        channelRow.campaign_id,
      );
      const offer = campaign?.offer_id
        ? await first<Offer>(ctx.env, 'SELECT * FROM offers WHERE id = ?', campaign.offer_id)
        : null;
      if (!account || !campaign || !offer) return failed('missing account, campaign, or offer');

      const adapter = adsFor(account.channel);
      if (!adapter) return failed(`no ads adapter for ${account.channel}`);

      const creatives = await all<Creative>(
        ctx.env,
        `SELECT * FROM creatives
          WHERE campaign_id = ? AND kind = 'ad' AND status = 'approved'
            AND (channel IS NULL OR channel = ?)
            AND external_id IS NULL
          ORDER BY editorial_score DESC LIMIT 5`,
        channelRow.campaign_id,
        account.channel,
      );
      if (creatives.length === 0) return ok('no approved ad creative waiting');

      let attached = 0;
      for (const creativeRow of creatives) {
        const decisionId = await ctx.decide({
          agent: 'mediabuyer',
          action: 'create_ad',
          targetType: 'creative',
          targetId: creativeRow.id,
          channel: account.channel,
          rationale: `attaching approved copy (score ${creativeRow.editorial_score}) to ad set`,
        });
        try {
          const result = await adapter.createAd(
            { env: ctx.env, log: ctx.log, dryRun: ctx.config.dryRun },
            account,
            channelRow.external_adset_id,
            {
              headline: creativeRow.hook,
              body: creativeRow.body,
              cta: creativeRow.cta,
              media: [],
              landingUrl: offer.landing_url,
              sourcePostId: creativeRow.external_id,
            },
          );
          await update(ctx.env, 'creatives', creativeRow.id, {
            external_id: result.externalId,
            status: 'live',
          });
          await ctx.settle(decisionId, result.dryRun ? 'dry_run' : 'applied', {
            ad_external_id: result.externalId,
          });
          attached++;
        } catch (err) {
          await ctx.settle(decisionId, 'failed', { error: String(err).slice(0, 300) });
          ctx.log.warn('attach creative failed', {
            creative_id: creativeRow.id,
            err: String(err).slice(0, 300),
          });
        }
      }
      return ok(`attached ${attached} of ${creatives.length}`, { data: { attached } });
    },

    /** Apply a budget change that the optimizer proposed and a gate cleared. */
    async apply_budget(ctx, payload) {
      const campaignChannelId = str(payload, 'campaignChannelId');
      const dailyBudgetCents = num(payload, 'dailyBudgetCents');
      if (!campaignChannelId || dailyBudgetCents === undefined) {
        return failed('apply_budget needs campaignChannelId and dailyBudgetCents');
      }

      const channelRow = await first<CampaignChannel>(
        ctx.env,
        'SELECT * FROM campaign_channels WHERE id = ?',
        campaignChannelId,
      );
      if (!channelRow?.external_adset_id) return failed('ad set has not been created yet');

      const account = await first<Account>(
        ctx.env,
        'SELECT * FROM accounts WHERE id = ?',
        channelRow.account_id,
      );
      if (!account) return failed('account not found');
      const adapter = adsFor(account.channel);
      if (!adapter) return failed(`no ads adapter for ${account.channel}`);

      const gate = await checkSpendAction(ctx, {
        channel: account.channel,
        campaignChannelId,
        newDailyBudgetCents: dailyBudgetCents,
      });
      if (!gate.allowed) return ok(`blocked: ${gate.reason}`);

      // A large increase is a separate risk category from a routine nudge.
      const increaseRatio =
        channelRow.daily_budget_cents > 0
          ? dailyBudgetCents / channelRow.daily_budget_cents
          : Number.POSITIVE_INFINITY;
      const risk = increaseRatio > 1.5 ? 'high' : 'normal';

      const decisionId = await ctx.decide({
        agent: 'mediabuyer',
        action: 'set_budget',
        targetType: 'campaign_channel',
        targetId: campaignChannelId,
        channel: account.channel,
        rationale: str(payload, 'rationale') ?? 'budget reallocation',
        evidence: { gate: gate.reason, from: channelRow.daily_budget_cents },
        proposed: { daily_budget_cents: dailyBudgetCents },
        risk,
      });

      const approval = approvalGate(ctx.config, { action: 'set_budget', risk });
      const already = await hasApproval(ctx.env, 'budget_change', campaignChannelId);
      if (!approval.allowed && approval.needsApproval && !already.approved) {
        await ctx.requestApproval({
          decisionId,
          subjectType: 'budget_change',
          subjectId: campaignChannelId,
          summary: `${account.channel}: ${channelRow.daily_budget_cents} to ${dailyBudgetCents} cents per day`,
          risk,
        });
        return ok(`waiting on approval: ${approval.reason}`);
      }

      try {
        const result = await adapter.setBudget(
          { env: ctx.env, log: ctx.log, dryRun: ctx.config.dryRun },
          account,
          channelRow.external_adset_id,
          dailyBudgetCents,
          channelRow.daily_budget_cents ? account.currency : account.currency,
        );
        await update(ctx.env, 'campaign_channels', campaignChannelId, {
          daily_budget_cents: dailyBudgetCents,
        });
        await ctx.settle(decisionId, result.dryRun ? 'dry_run' : 'applied');
        return ok(`budget set to ${dailyBudgetCents} cents/day on ${account.channel}`);
      } catch (err) {
        await ctx.settle(decisionId, 'failed', { error: String(err).slice(0, 300) });
        return failed(`budget change failed: ${String(err).slice(0, 200)}`);
      }
    },

    /** Pause or activate an ad entity. */
    async set_status(ctx, payload) {
      const campaignChannelId = str(payload, 'campaignChannelId');
      const status = str(payload, 'status') === 'active' ? 'active' : 'paused';
      const level = (str(payload, 'level') ?? 'adset') as 'campaign' | 'adset' | 'ad';
      if (!campaignChannelId) return failed('set_status needs a campaignChannelId');

      const channelRow = await first<CampaignChannel>(
        ctx.env,
        'SELECT * FROM campaign_channels WHERE id = ?',
        campaignChannelId,
      );
      if (!channelRow) return failed('campaign channel not found');
      const externalId =
        level === 'campaign' ? channelRow.external_id : channelRow.external_adset_id;
      if (!externalId) return failed('nothing has been created upstream yet');

      const account = await first<Account>(
        ctx.env,
        'SELECT * FROM accounts WHERE id = ?',
        channelRow.account_id,
      );
      if (!account) return failed('account not found');
      const adapter = adsFor(account.channel);
      if (!adapter) return failed(`no ads adapter for ${account.channel}`);

      // Turning something on spends money, so it goes through the gates.
      // Turning something off never does, so it does not.
      if (status === 'active') {
        const gate = await checkSpendAction(ctx, {
          channel: account.channel,
          campaignChannelId,
          newDailyBudgetCents: channelRow.daily_budget_cents,
        });
        if (!gate.allowed) return ok(`blocked: ${gate.reason}`);

        const approval = approvalGate(ctx.config, { action: 'activate', risk: 'high' });
        const already = await hasApproval(ctx.env, 'campaign', campaignChannelId);
        if (!approval.allowed && !already.approved) {
          const decisionId = await ctx.decide({
            agent: 'mediabuyer',
            action: 'activate',
            targetType: 'campaign_channel',
            targetId: campaignChannelId,
            channel: account.channel,
            rationale: str(payload, 'rationale') ?? 'ready to go live',
            risk: 'high',
          });
          await ctx.requestApproval({
            decisionId,
            subjectType: 'campaign',
            subjectId: campaignChannelId,
            summary: `Start spending on ${account.channel} at ${channelRow.daily_budget_cents} cents per day`,
            risk: 'high',
          });
          return ok('activation needs a human, approval requested');
        }
      }

      const decisionId = await ctx.decide({
        agent: 'mediabuyer',
        action: status === 'active' ? 'activate' : 'pause',
        targetType: 'campaign_channel',
        targetId: campaignChannelId,
        channel: account.channel,
        rationale: str(payload, 'rationale') ?? `set ${level} to ${status}`,
      });

      try {
        const result = await adapter.setStatus(
          { env: ctx.env, log: ctx.log, dryRun: ctx.config.dryRun },
          account,
          externalId,
          status,
          level,
        );
        await update(ctx.env, 'campaign_channels', campaignChannelId, { status });
        await ctx.settle(decisionId, result.dryRun ? 'dry_run' : 'applied');
        return ok(`${account.channel} ${level} is now ${status}`);
      } catch (err) {
        await ctx.settle(decisionId, 'failed', { error: String(err).slice(0, 300) });
        return failed(`status change failed: ${String(err).slice(0, 200)}`);
      }
    },
  },
};

/** Create the local rows for a campaign and its channels. */
export async function createCampaignRecord(
  env: import('../env').Env,
  input: {
    name: string;
    offerId: string;
    objective: Campaign['objective'];
    dailyBudgetCents: number;
    channels: { accountId: string; channel: Channel; dailyBudgetCents: number; targeting?: unknown }[];
    brief?: unknown;
    startsAt?: string | null;
    endsAt?: string | null;
  },
): Promise<string> {
  const campaignId = id('cmp');
  await insert(env, 'campaigns', {
    id: campaignId,
    name: input.name,
    offer_id: input.offerId,
    objective: input.objective,
    status: 'draft',
    daily_budget_cents: input.dailyBudgetCents,
    currency: 'USD',
    starts_at: input.startsAt ?? null,
    ends_at: input.endsAt ?? null,
    brief: JSON.stringify(input.brief ?? {}),
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  for (const channel of input.channels) {
    await insert(env, 'campaign_channels', {
      id: id('cch'),
      campaign_id: campaignId,
      account_id: channel.accountId,
      channel: channel.channel,
      status: 'draft',
      daily_budget_cents: channel.dailyBudgetCents,
      targeting: JSON.stringify(channel.targeting ?? {}),
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }
  return campaignId;
}
