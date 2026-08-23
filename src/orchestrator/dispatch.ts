import type { Env } from '../env';
import { loadConfig } from '../lib/config';
import { all, first, insert, parseJson, update } from '../lib/db';
import { id } from '../lib/ids';
import { errorFields, Logger } from '../lib/log';
import { isoPlusMinutes, nowIso } from '../lib/time';
import type { AgentId, JobMessage, JobRecord } from '../types';
import { createContext } from './context';
import { agentFor } from './registry';
import { planFor, fullSweep, type CronPlan } from './schedule';

/**
 * The orchestrator loop.
 *
 * A cron fires, a run is opened, the plan's tasks are written to `jobs` and
 * pushed onto the queue. The queue consumer runs one job per message, and an
 * agent may enqueue more. Everything is idempotent by key, so a retried
 * delivery cannot double-post or double-spend.
 */

export async function startRun(
  env: Env,
  input: { trigger: string; cron?: string; plan: CronPlan },
): Promise<{ runId: string; enqueued: number; skipped: number }> {
  const config = await loadConfig(env);
  const log = new Logger(env.LOG_LEVEL, { trigger: input.trigger, cron: input.cron });
  const runId = id('run');

  await insert(env, 'runs', {
    id: runId,
    trigger: input.trigger,
    cron: input.cron ?? null,
    status: 'running',
    started_at: nowIso(),
    summary: JSON.stringify({ plan: input.plan.name, describe: input.plan.describe }),
  });

  if (config.paused) {
    await update(
      env,
      'runs',
      runId,
      { status: 'ok', finished_at: nowIso(), summary: JSON.stringify({ skipped: 'paused' }) },
      { touch: false },
    );
    log.warn('run skipped, orchestrator is paused', { run_id: runId });
    return { runId, enqueued: 0, skipped: input.plan.tasks.length };
  }

  let enqueued = 0;
  let skipped = 0;

  for (const task of input.plan.tasks) {
    const ctx = createContext({ env, config, agent: task.agent, runId, log });
    const jobId = await ctx.enqueue({
      agent: task.agent,
      task: task.task,
      payload: task.payload ?? {},
      priority: task.priority ?? 5,
      ...(task.dedupe ? { dedupe: task.dedupe } : {}),
    });
    if (jobId) enqueued++;
    else skipped++;
  }

  await update(
    env,
    'runs',
    runId,
    {
      status: 'ok',
      finished_at: nowIso(),
      jobs_enqueued: enqueued,
      summary: JSON.stringify({
        plan: input.plan.name,
        describe: input.plan.describe,
        enqueued,
        skipped,
        dry_run: config.dryRun,
      }),
    },
    { touch: false },
  );

  log.info('run started', { run_id: runId, plan: input.plan.name, enqueued, skipped });
  return { runId, enqueued, skipped };
}

/** Cloudflare scheduled handler. */
export async function handleScheduled(env: Env, event: ScheduledController): Promise<void> {
  const now = new Date(event.scheduledTime ?? Date.now()).toISOString();
  const plan = planFor(event.cron, now);
  if (!plan) {
    new Logger(env.LOG_LEVEL).warn('no plan for cron', { cron: event.cron });
    return;
  }
  await startRun(env, { trigger: `cron:${plan.name}`, cron: event.cron, plan });

  // The tick is also where delayed jobs get their chance to run.
  if (plan.name === 'tick') await drainDelayed(env);
}

export async function runFullSweep(env: Env): Promise<{ runId: string; enqueued: number }> {
  const result = await startRun(env, {
    trigger: 'manual',
    plan: fullSweep(nowIso()),
  });
  return { runId: result.runId, enqueued: result.enqueued };
}

/**
 * Jobs written with a `not_before` in the future are not put on the queue when
 * they are created, so this picks them up once they come due.
 */
export async function drainDelayed(env: Env, limit = 25): Promise<number> {
  const due = await all<JobRecord>(
    env,
    `SELECT * FROM jobs
      WHERE status = 'queued' AND not_before IS NOT NULL AND not_before <= ?
      ORDER BY priority ASC, created_at ASC LIMIT ?`,
    nowIso(),
    limit,
  );
  for (const job of due) {
    await env.JOBS.send({
      jobId: job.id,
      runId: job.run_id,
      agent: job.agent,
      task: job.task,
      payload: parseJson(job.payload, {}),
    });
    await update(env, 'jobs', job.id, { not_before: null });
  }
  return due.length;
}

/**
 * Queue consumer. One message is one job.
 *
 * Retries are handled by the queue, so a transient failure calls retry() and a
 * permanent one acks so the message does not loop forever.
 */
export async function handleQueue(
  batch: MessageBatch<JobMessage>,
  env: Env,
): Promise<void> {
  const config = await loadConfig(env);
  const log = new Logger(env.LOG_LEVEL, { source: 'queue' });

  for (const message of batch.messages) {
    const { jobId, agent, task } = message.body;
    const jobLog = log.child({ job_id: jobId, agent, task });

    const job = await first<JobRecord>(env, 'SELECT * FROM jobs WHERE id = ?', jobId);
    if (!job) {
      jobLog.warn('job row missing, acking');
      message.ack();
      continue;
    }
    if (job.status === 'done' || job.status === 'cancelled') {
      message.ack();
      continue;
    }
    if (config.paused) {
      jobLog.warn('paused, deferring job');
      await update(env, 'jobs', jobId, { status: 'blocked', not_before: isoPlusMinutes(15) });
      message.ack();
      continue;
    }

    const definition = agentFor(agent);
    const handler = definition?.tasks[task];
    if (!handler) {
      await update(env, 'jobs', jobId, {
        status: 'failed',
        error: `no handler for ${agent}.${task}`,
        finished_at: nowIso(),
      });
      jobLog.error('unknown task');
      message.ack();
      continue;
    }

    await update(env, 'jobs', jobId, {
      status: 'running',
      attempts: job.attempts + 1,
      started_at: nowIso(),
    });

    const ctx = createContext({
      env,
      config,
      agent: agent as AgentId,
      runId: message.body.runId,
      jobId,
      log,
    });

    try {
      const result = await handler(ctx, message.body.payload ?? {});
      await update(env, 'jobs', jobId, {
        status: result.ok ? 'done' : 'failed',
        result: JSON.stringify(result).slice(0, 8000),
        error: result.ok ? null : result.summary.slice(0, 500),
        finished_at: nowIso(),
      });
      jobLog.info('job finished', { ok: result.ok, summary: result.summary });
      message.ack();
    } catch (err) {
      const exhausted = job.attempts + 1 >= job.max_attempts;
      await update(env, 'jobs', jobId, {
        status: exhausted ? 'failed' : 'queued',
        error: String(err).slice(0, 1000),
        ...(exhausted ? { finished_at: nowIso() } : {}),
      });
      jobLog.error('job threw', errorFields(err));

      if (exhausted) {
        await insert(env, 'incidents', {
          id: id('inc'),
          severity: 'error',
          source: `agent:${agent}`,
          code: 'job_failed',
          message: `${agent}.${task} failed after ${job.max_attempts} attempts`,
          context: JSON.stringify({ job_id: jobId, error: String(err).slice(0, 500) }),
          created_at: nowIso(),
        });
        message.ack();
      } else {
        message.retry({ delaySeconds: Math.min(300, 30 * 2 ** job.attempts) });
      }
    }
  }
}

/** Run a single task inline. Used by the API for on-demand agent calls. */
export async function runTaskNow(
  env: Env,
  input: { agent: string; task: string; payload?: Record<string, unknown> },
): Promise<{ ok: boolean; summary: string; data?: unknown }> {
  const config = await loadConfig(env);
  const definition = agentFor(input.agent);
  const handler = definition?.tasks[input.task];
  if (!handler) {
    return { ok: false, summary: `no handler for ${input.agent}.${input.task}` };
  }
  const ctx = createContext({
    env,
    config,
    agent: input.agent as AgentId,
    runId: null,
    jobId: null,
  });
  const result = await handler(ctx, input.payload ?? {});
  return { ok: result.ok, summary: result.summary, data: result.data };
}
