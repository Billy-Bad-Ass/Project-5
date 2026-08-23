import type { Env } from '../env';
import type { RuntimeConfig } from '../lib/config';
import { insert, update } from '../lib/db';
import { id, idempotencyKey } from '../lib/ids';
import { Logger } from '../lib/log';
import { nowIso } from '../lib/time';
import type { AgentId, Decision, JobMessage } from '../types';

/**
 * What an agent is handed when it runs. Everything an agent is allowed to do
 * to the outside world goes through this object, which is what makes DRY_RUN,
 * the approval gate and the audit trail enforceable rather than advisory.
 */
export interface AgentContext {
  env: Env;
  log: Logger;
  config: RuntimeConfig;
  runId: string | null;
  jobId: string | null;
  agent: AgentId;

  /** Record an intent. Returns the decision id for linking an approval to it. */
  decide(decision: Decision): Promise<string>;

  /**
   * Ask for a human decision. Returns the approval id. The caller should stop
   * and let the approval webhook re-enqueue the work.
   */
  requestApproval(input: {
    decisionId?: string;
    subjectType: string;
    subjectId: string;
    summary: string;
    risk?: 'low' | 'normal' | 'high';
    expiresInHours?: number;
  }): Promise<string>;

  /** Queue follow-on work for another agent. */
  enqueue(input: {
    agent: AgentId;
    task: string;
    payload?: Record<string, unknown>;
    priority?: number;
    notBefore?: string;
    /** Parts hashed into an idempotency key so retries do not duplicate work. */
    dedupe?: (string | number)[];
  }): Promise<string | null>;

  /** Raise an operational problem a human should see. */
  incident(input: {
    severity: 'info' | 'warn' | 'error' | 'critical';
    code: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<void>;

  /** Mark a logged decision as applied, dry-run, or failed. */
  settle(decisionId: string, outcome: 'applied' | 'dry_run' | 'failed' | 'rejected', detail?: Record<string, unknown>): Promise<void>;
}

export function createContext(input: {
  env: Env;
  config: RuntimeConfig;
  agent: AgentId;
  runId: string | null;
  jobId?: string | null;
  log?: Logger;
}): AgentContext {
  const { env, config, agent, runId } = input;
  const jobId = input.jobId ?? null;
  const log = (input.log ?? new Logger(env.LOG_LEVEL)).child({
    agent,
    run_id: runId,
    job_id: jobId,
  });

  return {
    env,
    log,
    config,
    runId,
    jobId,
    agent,

    async decide(decision) {
      const decisionId = id('dec');
      await insert(env, 'decisions', {
        id: decisionId,
        run_id: runId,
        job_id: jobId,
        agent,
        action: decision.action,
        target_type: decision.targetType ?? null,
        target_id: decision.targetId ?? null,
        channel: decision.channel ?? null,
        rationale: decision.rationale,
        evidence: JSON.stringify(decision.evidence ?? {}),
        proposed: JSON.stringify(decision.proposed ?? {}),
        outcome: 'proposed',
        created_at: nowIso(),
      });
      log.info('decision', {
        decision_id: decisionId,
        action: decision.action,
        channel: decision.channel,
        target_id: decision.targetId,
      });
      return decisionId;
    },

    async requestApproval(input) {
      const approvalId = id('apr');
      const expiresInHours = input.expiresInHours ?? 72;
      await insert(env, 'approvals', {
        id: approvalId,
        decision_id: input.decisionId ?? null,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        requested_by: `agent:${agent}`,
        summary: input.summary,
        risk: input.risk ?? 'normal',
        status: 'pending',
        expires_at: new Date(Date.now() + expiresInHours * 3600_000).toISOString(),
        created_at: nowIso(),
      });
      log.info('approval requested', {
        approval_id: approvalId,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
      });
      return approvalId;
    },

    async enqueue(input) {
      const jobIdNew = id('job');
      const key = input.dedupe ? await idempotencyKey(input.agent, input.task, ...input.dedupe) : null;

      try {
        await insert(env, 'jobs', {
          id: jobIdNew,
          run_id: runId,
          agent: input.agent,
          task: input.task,
          payload: JSON.stringify(input.payload ?? {}),
          status: 'queued',
          priority: input.priority ?? 5,
          attempts: 0,
          max_attempts: 3,
          not_before: input.notBefore ?? null,
          idempotency_key: key,
          created_at: nowIso(),
          updated_at: nowIso(),
        });
      } catch (err) {
        // A unique violation on idempotency_key means this work already exists.
        if (String(err).includes('UNIQUE')) {
          log.debug('enqueue skipped, already queued', { agent: input.agent, task: input.task });
          return null;
        }
        throw err;
      }

      const message: JobMessage = {
        jobId: jobIdNew,
        runId,
        agent: input.agent,
        task: input.task,
        payload: input.payload ?? {},
      };
      // Delayed work stays in D1 and is picked up by the next tick instead of
      // sitting on the queue, so a long delay does not hold a queue slot.
      if (!input.notBefore || new Date(input.notBefore).getTime() <= Date.now()) {
        await env.JOBS.send(message);
      }
      return jobIdNew;
    },

    async incident(input) {
      await insert(env, 'incidents', {
        id: id('inc'),
        severity: input.severity,
        source: `agent:${agent}`,
        code: input.code,
        message: input.message,
        context: JSON.stringify(input.context ?? {}),
        created_at: nowIso(),
      });
      const fields = { code: input.code, ...input.context };
      if (input.severity === 'critical' || input.severity === 'error') log.error(input.message, fields);
      else if (input.severity === 'warn') log.warn(input.message, fields);
      else log.info(input.message, fields);
    },

    async settle(decisionId, outcome, detail) {
      await update(
        env,
        'decisions',
        decisionId,
        {
          outcome,
          applied_at: outcome === 'applied' ? nowIso() : null,
          ...(detail ? { evidence: JSON.stringify(detail) } : {}),
        },
        { touch: false },
      );
    },
  };
}
