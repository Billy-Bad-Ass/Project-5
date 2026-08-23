import type { Env } from './env';
import { Logger, errorFields } from './lib/log';
import { route } from './api/routes';
import { handleQueue, handleScheduled } from './orchestrator/dispatch';
import type { JobMessage } from './types';

export { CampaignRoom } from './orchestrator/campaign-room';

/**
 * BBA Network Growth OS.
 *
 * One Worker with three entry points:
 *   fetch     the operator console, the admin API, media, and the Stripe webhook
 *   scheduled the cron triggers that drive every agent cycle
 *   queue     the consumer that actually runs agent jobs
 *
 * The orchestration is automatic. The spending and the publishing are not:
 * both sit behind guardrails and a human approval, on purpose.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      new Logger(env.LOG_LEVEL).error('unhandled request error', errorFields(err));
      return new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      handleScheduled(env, event).catch((err) => {
        new Logger(env.LOG_LEVEL).error('scheduled run failed', {
          cron: event.cron,
          ...errorFields(err),
        });
      }),
    );
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, JobMessage>;
