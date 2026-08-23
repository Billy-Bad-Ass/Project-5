import type { Env } from '../env';
import { loadConfig } from '../lib/config';
import { first, update } from '../lib/db';
import { Logger } from '../lib/log';
import { nowIso } from '../lib/time';
import { createContext } from '../orchestrator/context';
import type { CampaignChannel } from '../types';

/**
 * What actually happens when a person approves something.
 *
 * The approval record is the authority. Agents check it before spending; this
 * is where it gets written and where the work it unblocks gets queued.
 */
export interface ApprovalRow {
  id: string;
  decision_id: string | null;
  subject_type: string;
  subject_id: string;
  summary: string;
  risk: string;
  status: string;
  expires_at: string | null;
}

export async function decideApproval(
  env: Env,
  input: {
    approvalId: string;
    decision: 'approve' | 'reject';
    decidedBy: string;
    note?: string;
  },
): Promise<{ ok: boolean; message: string; queued?: string[] }> {
  const approval = await first<ApprovalRow>(
    env,
    'SELECT * FROM approvals WHERE id = ?',
    input.approvalId,
  );
  if (!approval) return { ok: false, message: 'approval not found' };
  if (approval.status !== 'pending') {
    return { ok: false, message: `already ${approval.status}` };
  }
  if (approval.expires_at && new Date(approval.expires_at).getTime() < Date.now()) {
    await update(env, 'approvals', approval.id, {
      status: 'expired',
      decided_at: nowIso(),
    }, { touch: false });
    return { ok: false, message: 'this approval expired, ask the agent to propose again' };
  }

  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  await update(
    env,
    'approvals',
    approval.id,
    {
      status,
      decided_by: input.decidedBy,
      decided_at: nowIso(),
      note: input.note ?? null,
    },
    { touch: false },
  );
  if (approval.decision_id) {
    await update(
      env,
      'decisions',
      approval.decision_id,
      { outcome: input.decision === 'approve' ? 'approved' : 'rejected' },
      { touch: false },
    );
  }

  if (input.decision === 'reject') {
    await applyRejection(env, approval);
    return { ok: true, message: `rejected ${approval.subject_type} ${approval.subject_id}` };
  }

  const queued = await applyApproval(env, approval);
  return {
    ok: true,
    message: `approved ${approval.subject_type} ${approval.subject_id}`,
    queued,
  };
}

async function applyApproval(env: Env, approval: ApprovalRow): Promise<string[]> {
  const config = await loadConfig(env);
  const log = new Logger(env.LOG_LEVEL, { source: 'approvals' });
  const queued: string[] = [];

  switch (approval.subject_type) {
    case 'creative': {
      await update(env, 'creatives', approval.subject_id, {
        status: 'approved',
        approved_by: 'human',
        approved_at: nowIso(),
      });
      // Approved copy is scheduled on the next batch, not immediately, so the
      // spacing rules still apply.
      const ctx = createContext({ env, config, agent: 'publisher', runId: null, log });
      const jobId = await ctx.enqueue({
        agent: 'publisher',
        task: 'schedule_batch',
        payload: { perChannel: 2 },
        priority: 4,
        dedupe: ['schedule_after_approval', approval.subject_id],
      });
      if (jobId) queued.push(jobId);
      break;
    }

    case 'campaign': {
      // subject_id is either a campaign or a single campaign_channel.
      const channelRow = await first<CampaignChannel>(
        env,
        'SELECT * FROM campaign_channels WHERE id = ?',
        approval.subject_id,
      );
      const ctx = createContext({ env, config, agent: 'mediabuyer', runId: null, log });
      if (channelRow) {
        const jobId = await ctx.enqueue({
          agent: 'mediabuyer',
          task: 'set_status',
          payload: {
            campaignChannelId: channelRow.id,
            status: 'active',
            level: 'adset',
            rationale: `approved by human via ${approval.id}`,
          },
          priority: 2,
          dedupe: ['activate', channelRow.id, approval.id],
        });
        if (jobId) queued.push(jobId);
      } else {
        await update(env, 'campaigns', approval.subject_id, { status: 'active' });
        const jobId = await ctx.enqueue({
          agent: 'mediabuyer',
          task: 'launch_campaign',
          payload: { campaignId: approval.subject_id },
          priority: 2,
          dedupe: ['launch', approval.subject_id, approval.id],
        });
        if (jobId) queued.push(jobId);
      }
      break;
    }

    case 'budget_change': {
      const ctx = createContext({ env, config, agent: 'mediabuyer', runId: null, log });
      const decision = approval.decision_id
        ? await first<{ proposed: string }>(
            env,
            'SELECT proposed FROM decisions WHERE id = ?',
            approval.decision_id,
          )
        : null;
      let dailyBudgetCents: number | undefined;
      try {
        dailyBudgetCents = decision
          ? (JSON.parse(decision.proposed) as { daily_budget_cents?: number }).daily_budget_cents
          : undefined;
      } catch {
        dailyBudgetCents = undefined;
      }
      if (dailyBudgetCents !== undefined) {
        const jobId = await ctx.enqueue({
          agent: 'mediabuyer',
          task: 'apply_budget',
          payload: {
            campaignChannelId: approval.subject_id,
            dailyBudgetCents,
            rationale: `approved by human via ${approval.id}`,
          },
          priority: 3,
          dedupe: ['apply_budget_approved', approval.subject_id, approval.id],
        });
        if (jobId) queued.push(jobId);
      }
      break;
    }

    case 'post': {
      await update(env, 'posts', approval.subject_id, { status: 'scheduled' });
      break;
    }

    default:
      log.warn('approved an unknown subject type', { subject_type: approval.subject_type });
  }

  return queued;
}

async function applyRejection(env: Env, approval: ApprovalRow): Promise<void> {
  switch (approval.subject_type) {
    case 'creative':
      await update(env, 'creatives', approval.subject_id, { status: 'rejected' });
      break;
    case 'post':
      await update(env, 'posts', approval.subject_id, { status: 'cancelled' });
      break;
    case 'campaign': {
      const channelRow = await first<{ id: string }>(
        env,
        'SELECT id FROM campaign_channels WHERE id = ?',
        approval.subject_id,
      );
      if (!channelRow) {
        await update(env, 'campaigns', approval.subject_id, { status: 'archived' });
      }
      break;
    }
    default:
      break;
  }
}
