import { all, first, insert, parseJson, update } from '../lib/db';
import { PlatformError, describeError } from '../lib/errors';
import { id, idempotencyKey } from '../lib/ids';
import { isoPlusMinutes, nowIso } from '../lib/time';
import { organicFor } from '../platforms';
import { channelGate } from '../orchestrator/guardrails';
import type { Account, Creative, Post } from '../types';
import type { MediaRef, PublishInput } from '../platforms/types';
import { type Agent, failed, num, ok, str } from './agent';

/**
 * The publisher is the only code path that puts something in public.
 *
 * It publishes exactly what a human approved: it does not edit, rewrite, or
 * pad. Anything not approved stays unpublished, whatever the schedule says.
 */
export const publisher: Agent = {
  id: 'publisher',
  describe: 'Publishes approved posts on schedule. Never edits what it publishes.',

  tasks: {
    /** Schedule approved creatives across the connected organic accounts. */
    async schedule_batch(ctx, payload) {
      const spacingMinutes = num(payload, 'spacingMinutes') ?? 180;
      const perChannel = num(payload, 'perChannel') ?? 2;

      const accounts = await all<Account>(
        ctx.env,
        `SELECT * FROM accounts WHERE surface = 'organic' AND status = 'active'`,
      );
      let scheduled = 0;

      for (const account of accounts) {
        const gate = channelGate(ctx.config, account.channel);
        if (!gate.allowed) {
          ctx.log.debug('channel gated', { channel: account.channel, reason: gate.reason });
          continue;
        }

        const creatives = await all<Creative>(
          ctx.env,
          `SELECT c.* FROM creatives c
            WHERE c.status = 'approved' AND c.channel = ?
              AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.creative_id = c.id)
            ORDER BY c.editorial_score DESC, c.created_at ASC
            LIMIT ?`,
          account.channel,
          perChannel,
        );

        // Start after whatever is already queued so posts do not stack up.
        const lastQueued = await first<{ scheduled_for: string }>(
          ctx.env,
          `SELECT scheduled_for FROM posts
            WHERE account_id = ? AND status IN ('scheduled','pending_approval')
            ORDER BY scheduled_for DESC LIMIT 1`,
          account.id,
        );
        let cursor = lastQueued
          ? new Date(Math.max(Date.now(), new Date(lastQueued.scheduled_for).getTime()))
          : new Date();

        for (const creativeRow of creatives) {
          cursor = new Date(cursor.getTime() + spacingMinutes * 60_000);
          const postId = id('pst');
          const key = await idempotencyKey('publish', account.id, creativeRow.id);
          try {
            await insert(ctx.env, 'posts', {
              id: postId,
              account_id: account.id,
              creative_id: creativeRow.id,
              channel: account.channel,
              scheduled_for: cursor.toISOString(),
              status: 'scheduled',
              attempts: 0,
              idempotency_key: key,
              created_at: nowIso(),
              updated_at: nowIso(),
            });
            scheduled++;
            await ctx.decide({
              agent: 'publisher',
              action: 'schedule_post',
              targetType: 'post',
              targetId: postId,
              channel: account.channel,
              rationale: `approved creative scored ${creativeRow.editorial_score ?? 'n/a'}`,
              proposed: { scheduled_for: cursor.toISOString() },
            });
          } catch (err) {
            if (!String(err).includes('UNIQUE')) throw err;
          }
        }
      }

      return ok(`scheduled ${scheduled} posts`, { data: { scheduled } });
    },

    /** Publish everything that is due. Called by the five minute tick. */
    async publish_due(ctx, payload) {
      const limit = num(payload, 'limit') ?? 10;
      const due = await all<Post>(
        ctx.env,
        `SELECT * FROM posts
          WHERE status = 'scheduled' AND scheduled_for <= ?
          ORDER BY scheduled_for ASC LIMIT ?`,
        nowIso(),
        limit,
      );
      if (due.length === 0) return ok('nothing due');

      let enqueued = 0;
      for (const post of due) {
        const jobId = await ctx.enqueue({
          agent: 'publisher',
          task: 'publish_post',
          payload: { postId: post.id },
          priority: 2,
          dedupe: ['publish_post', post.id],
        });
        if (jobId) enqueued++;
      }
      return ok(`${enqueued} posts sent to the queue`, { enqueued });
    },

    /**
     * Publish one post.
     *
     * A post that already went out is skipped. A post whose last attempt ended
     * without an answer is *held*, not retried: see the catch below.
     */
    async publish_post(ctx, payload) {
      const postId = str(payload, 'postId');
      if (!postId) return failed('publish_post needs a postId');

      const post = await first<Post>(ctx.env, 'SELECT * FROM posts WHERE id = ?', postId);
      if (!post) return failed(`post ${postId} not found`);
      if (post.status === 'published') return ok('already published');
      if (post.status === 'cancelled') return ok('cancelled, skipping');
      // Held because a previous attempt may already have posted it. Publishing
      // now is exactly the duplicate this status exists to prevent; a person
      // checks the account and either cancels it or marks it published.
      if (post.status === 'needs_reconcile') {
        return ok('held: a previous attempt may already have published this');
      }

      const account = await first<Account>(
        ctx.env,
        'SELECT * FROM accounts WHERE id = ?',
        post.account_id,
      );
      if (!account) return failed(`account ${post.account_id} not found`);

      const creativeRow = await first<Creative>(
        ctx.env,
        'SELECT * FROM creatives WHERE id = ?',
        post.creative_id,
      );
      if (!creativeRow) return failed(`creative ${post.creative_id} not found`);

      // The two checks that matter, re-run at publish time rather than trusted
      // from when the post was scheduled.
      if (creativeRow.status !== 'approved' && creativeRow.status !== 'live') {
        await update(ctx.env, 'posts', postId, {
          status: 'pending_approval',
          last_error: `creative is ${creativeRow.status}`,
        });
        return ok(`held: creative is ${creativeRow.status}, not approved`);
      }
      const gate = channelGate(ctx.config, account.channel);
      if (!gate.allowed) {
        await update(ctx.env, 'posts', postId, { last_error: gate.reason });
        return ok(`held: ${gate.reason}`);
      }

      const adapter = organicFor(account.channel);
      if (!adapter) return failed(`no organic adapter for ${account.channel}`);

      const decisionId = await ctx.decide({
        agent: 'publisher',
        action: 'publish_post',
        targetType: 'post',
        targetId: postId,
        channel: account.channel,
        rationale: `scheduled post, creative approved by ${creativeRow.approved_by ?? 'unknown'}`,
        proposed: { hook: creativeRow.hook, body: creativeRow.body.slice(0, 400) },
      });

      await update(ctx.env, 'posts', postId, {
        status: 'publishing',
        attempts: post.attempts + 1,
      });

      const input: PublishInput = {
        body: creativeRow.body,
        hook: creativeRow.hook,
        cta: creativeRow.cta,
        hashtags: parseJson<string[]>(creativeRow.hashtags, []),
        media: await resolveMedia(ctx.env, creativeRow),
        ...(creativeRow.hook ? { title: creativeRow.hook } : {}),
      };

      try {
        const result = await adapter.publish(
          { env: ctx.env, log: ctx.log, dryRun: ctx.config.dryRun },
          account,
          input,
        );
        await update(ctx.env, 'posts', postId, {
          status: 'published',
          published_at: nowIso(),
          external_id: result.externalId,
          permalink: result.permalink ?? null,
          last_error: null,
        });
        await update(ctx.env, 'creatives', creativeRow.id, {
          status: 'live',
          external_id: result.externalId,
        });
        await ctx.settle(decisionId, result.dryRun ? 'dry_run' : 'applied', {
          external_id: result.externalId,
        });
        return ok(
          result.dryRun
            ? `dry run: would publish to ${account.channel}`
            : `published to ${account.channel}`,
          { data: { externalId: result.externalId, permalink: result.permalink } },
        );
      } catch (err) {
        const message = describeError(err).slice(0, 500);

        // The platform may have published this and only the answer was lost —
        // a 5xx, a timeout, a dropped connection. Retrying would post it a
        // second time, and on nine social accounts a duplicate is what gets
        // the account limited. So stop, and put it in front of a person.
        if (err instanceof PlatformError && err.outcomeUnknown) {
          await update(ctx.env, 'posts', postId, {
            status: 'needs_reconcile',
            last_error: message,
          });
          await ctx.settle(decisionId, 'failed', { error: message, outcome: 'unknown' });
          await ctx.incident({
            severity: 'error',
            code: 'publish_outcome_unknown',
            message:
              `${account.channel} did not answer, so this post may or may not be live. ` +
              'Check the account: cancel it if nothing posted, mark it published if it did.',
            context: { post_id: postId, account_id: account.id, error: message },
          });
          return failed(`publish outcome unknown, held for review: ${message}`);
        }

        // Anything else was refused before it took effect, so it is safe to
        // try again.
        const exhausted = post.attempts + 1 >= 3;
        await update(ctx.env, 'posts', postId, {
          status: exhausted ? 'failed' : 'scheduled',
          scheduled_for: exhausted ? post.scheduled_for : isoPlusMinutes(15),
          last_error: message,
        });
        await ctx.settle(decisionId, 'failed', { error: message });
        if (exhausted) {
          await ctx.incident({
            severity: 'error',
            code: 'publish_failed',
            message: `${account.channel} publish failed after 3 attempts`,
            context: { post_id: postId, error: message },
          });
        }
        return failed(`publish failed: ${message}`);
      }
    },
  },
};

/** Turn stored media asset ids into URLs the platform can pull from. */
async function resolveMedia(
  env: import('../env').Env,
  creativeRow: Creative,
): Promise<MediaRef[]> {
  const assetIds = parseJson<string[]>(creativeRow.media, []);
  if (assetIds.length === 0) return [];

  const placeholders = assetIds.map(() => '?').join(',');
  const rows = await all<{
    id: string;
    r2_key: string;
    mime_type: string;
    duration_ms: number | null;
    alt_text: string | null;
  }>(env, `SELECT id, r2_key, mime_type, duration_ms, alt_text FROM media_assets WHERE id IN (${placeholders})`, ...assetIds);

  const base = await mediaBaseUrl(env);
  return rows.map((row) => ({
    url: `${base}/media/${encodeURIComponent(row.r2_key)}`,
    mimeType: row.mime_type,
    kind: row.mime_type.startsWith('video/') ? ('video' as const) : ('image' as const),
    ...(row.duration_ms ? { durationMs: row.duration_ms } : {}),
    ...(row.alt_text ? { altText: row.alt_text } : {}),
  }));
}

/**
 * Platforms fetch media over the public internet, so R2 objects are served
 * through this Worker's own /media route. PUBLIC_BASE_URL must be reachable.
 */
async function mediaBaseUrl(env: import('../env').Env): Promise<string> {
  const configured = await env.CONFIG.get('public_base_url');
  return configured ?? (typeof env.PUBLIC_BASE_URL === 'string' ? env.PUBLIC_BASE_URL : '');
}

export { resolveMedia };
