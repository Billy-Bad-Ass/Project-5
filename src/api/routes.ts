import type { Env } from '../env';
import { loadConfig, saveConfig } from '../lib/config';
import { all, first, insert, parseJson, run, update } from '../lib/db';
import { id } from '../lib/ids';
import { Logger } from '../lib/log';
import { daysAgoUtc, nowIso, utcDate } from '../lib/time';
import { CHANNELS, type Channel } from '../types';
import { ADS_CHANNELS, ORGANIC_CHANNELS } from '../platforms';
import { describeRegistry } from '../orchestrator/registry';
import { drainDelayed, runFullSweep, runTaskNow } from '../orchestrator/dispatch';
import { spendByChannel, spendToday } from '../orchestrator/guardrails';
import { channelPerformance, storedReport } from '../agents/analyst';
import { resolutionFor } from './resolve-post';
import { createCampaignRecord } from '../agents/mediabuyer';
import { storeMedia } from '../agents/producer';
import { blendedCac, blendedRoas } from '../orchestrator/allocator';
import { recordRevenueEvent, verifyWebhook } from '../integrations/stripe';
import { handleGoLink } from './links';
import { decideApproval } from './approvals';
import { json, requireAdmin } from './auth';
import { renderConsole } from '../ui/console';

/** Everything is under one router so the Worker entry stays small. */
export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // --- unauthenticated -----------------------------------------------
  if (path === '/health') return handleHealth(env);
  if (path.startsWith('/media/')) return serveMedia(env, path.slice('/media/'.length));
  if (path === '/webhooks/stripe' && method === 'POST') return stripeWebhook(request, env);
  // Ad destinations. Unauthenticated by necessity, this is where the ads point.
  if (path.startsWith('/go/') && (method === 'GET' || method === 'HEAD')) {
    return handleGoLink(env, url, path.slice('/go/'.length));
  }

  // --- console --------------------------------------------------------
  if (path === '/' && method === 'GET') {
    return new Response(renderConsole(env), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // --- everything below needs the admin token -------------------------
  const denied = requireAdmin(request, env);
  if (denied) return denied;

  try {
    if (path === '/api/status' && method === 'GET') return status(env);
    if (path === '/api/agents' && method === 'GET') return json({ agents: describeRegistry() });

    if (path === '/api/run' && method === 'POST') {
      const result = await runFullSweep(env);
      const drained = await drainDelayed(env);
      return json({ ...result, drained });
    }

    const agentCall = path.match(/^\/api\/agents\/([a-z]+)\/([a-z_]+)$/);
    if (agentCall && method === 'POST') {
      const payload = await safeJson(request);
      const result = await runTaskNow(env, {
        agent: agentCall[1]!,
        task: agentCall[2]!,
        payload,
      });
      return json(result, result.ok ? 200 : 400);
    }

    if (path === '/api/approvals' && method === 'GET') return listApprovals(env, url);
    const approvalDecision = path.match(/^\/api\/approvals\/([\w-]+)$/);
    if (approvalDecision && method === 'POST') {
      const body = await safeJson(request);
      const decision = body.decision === 'approve' ? 'approve' : 'reject';
      const result = await decideApproval(env, {
        approvalId: approvalDecision[1]!,
        decision,
        decidedBy: typeof body.decidedBy === 'string' ? body.decidedBy : 'console',
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
      });
      return json(result, result.ok ? 200 : 400);
    }

    if (path === '/api/accounts') {
      if (method === 'GET') return listAccounts(env);
      if (method === 'POST') return createAccount(request, env);
    }
    const accountPatch = path.match(/^\/api\/accounts\/([\w-]+)$/);
    if (accountPatch && method === 'PATCH') {
      const body = await safeJson(request);
      const allowed = ['status', 'handle', 'display_name', 'timezone', 'currency', 'meta'];
      const patch = Object.fromEntries(
        Object.entries(body).filter(([k]) => allowed.includes(k)),
      );
      if (Object.keys(patch).length === 0) return json({ error: 'nothing to update' }, 400);
      await update(env, 'accounts', accountPatch[1]!, patch);
      return json({ ok: true });
    }

    if (path === '/api/offers') {
      if (method === 'GET') return json({ offers: await all(env, 'SELECT * FROM offers ORDER BY created_at DESC') });
      if (method === 'POST') return createOffer(request, env);
    }

    if (path === '/api/campaigns') {
      if (method === 'GET') return listCampaigns(env);
      if (method === 'POST') return createCampaign(request, env);
    }

    if (path === '/api/creatives' && method === 'GET') return listCreatives(env, url);
    const creativePatch = path.match(/^\/api\/creatives\/([\w-]+)$/);
    if (creativePatch && method === 'PATCH') {
      const body = await safeJson(request);
      const allowed = ['hook', 'body', 'cta', 'hashtags', 'media', 'status'];
      const patch = Object.fromEntries(
        Object.entries(body).filter(([k]) => allowed.includes(k)),
      );
      if (Object.keys(patch).length === 0) return json({ error: 'nothing to update' }, 400);
      await update(env, 'creatives', creativePatch[1]!, patch);
      // A hand edit invalidates the previous score, so re-run the gate.
      const relint = await runTaskNow(env, {
        agent: 'creative',
        task: 'relint',
        payload: { creativeId: creativePatch[1]! },
      });
      return json({ ok: true, relint });
    }

    if (path === '/api/posts' && method === 'GET') return listPosts(env, url);

    // A post held as needs_reconcile is waiting on the one thing no code here
    // can determine: whether the platform actually published it. The publisher
    // deliberately will not guess, so this is how the answer gets back in.
    const resolvePost = path.match(/^\/api\/posts\/([\w-]+)\/resolve$/);
    if (resolvePost && method === 'POST') {
      const body = await safeJson(request);
      return resolveHeldPost(env, resolvePost[1]!, body);
    }
    if (path === '/api/decisions' && method === 'GET') return listDecisions(env, url);
    if (path === '/api/incidents' && method === 'GET') {
      return json({
        incidents: await all(
          env,
          `SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50`,
        ),
      });
    }
    const resolveIncident = path.match(/^\/api\/incidents\/([\w-]+)\/resolve$/);
    if (resolveIncident && method === 'POST') {
      await update(env, 'incidents', resolveIncident[1]!, { resolved_at: nowIso() }, { touch: false });
      return json({ ok: true });
    }

    if (path === '/api/jobs' && method === 'GET') {
      return json({
        jobs: await all(
          env,
          `SELECT id, agent, task, status, attempts, error, created_at, finished_at
             FROM jobs ORDER BY created_at DESC LIMIT 50`,
        ),
      });
    }

    if (path === '/api/performance' && method === 'GET') {
      const days = Number(url.searchParams.get('days') ?? 14);
      const performances = await channelPerformance(env, Number.isFinite(days) ? days : 14);
      return json({
        performances,
        blended_roas: blendedRoas(performances),
        blended_cac_cents: blendedCac(performances),
      });
    }

    if (path === '/api/report' && method === 'GET') {
      const date = url.searchParams.get('date') ?? utcDate();
      return json({ date, report: await storedReport(env, date) });
    }

    if (path === '/api/config') {
      if (method === 'GET') return json(await loadConfig(env));
      if (method === 'POST') {
        const body = await safeJson(request);
        const next = await saveConfig(env, body as never);
        return json(next);
      }
    }

    if (path === '/api/voice') {
      if (method === 'GET') {
        const row = await first<{ value: string }>(
          env,
          `SELECT value FROM settings WHERE key = 'voice_profile'`,
        );
        return json({ voice: row ? parseJson(row.value, {}) : null });
      }
      if (method === 'POST') {
        const body = await safeJson(request);
        await run(
          env,
          `INSERT INTO settings (key, value, updated_at) VALUES ('voice_profile', ?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          JSON.stringify(body),
          nowIso(),
        );
        return json({ ok: true });
      }
    }

    if (path === '/api/media' && method === 'POST') return uploadMedia(request, env);
    if (path === '/api/render-queue' && method === 'GET') {
      const rows = await all<{ key: string; value: string }>(
        env,
        `SELECT key, value FROM settings WHERE key LIKE 'render:%' ORDER BY updated_at DESC LIMIT 50`,
      );
      return json({ requests: rows.map((r) => parseJson(r.value, {})) });
    }

    return json({ error: 'not_found', path }, 404);
  } catch (err) {
    new Logger(env.LOG_LEVEL).error('request failed', {
      path,
      error: String(err).slice(0, 500),
    });
    return json({ error: 'internal_error', message: String(err).slice(0, 300) }, 500);
  }
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async function handleHealth(env: Env): Promise<Response> {
  try {
    await first(env, 'SELECT 1 AS ok');
  } catch (err) {
    return json({ ok: false, db: String(err).slice(0, 200) }, 503);
  }
  return json({
    ok: true,
    service: 'bba-growth-os',
    business: env.BBA_BUSINESS_NAME,
    env: env.BBA_ENV,
    time: nowIso(),
  });
}

async function status(env: Env): Promise<Response> {
  const config = await loadConfig(env);
  const [accounts, pendingApprovals, openIncidents, lastRun, spend] = await Promise.all([
    all<{ channel: string; surface: string; status: string; handle: string | null }>(
      env,
      'SELECT channel, surface, status, handle FROM accounts ORDER BY channel',
    ),
    first<{ n: number }>(env, `SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`),
    first<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL'),
    first<{ id: string; trigger: string; started_at: string; status: string }>(
      env,
      'SELECT id, trigger, started_at, status FROM runs ORDER BY started_at DESC LIMIT 1',
    ),
    spendToday(env),
  ]);

  const secrets = {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    stripe: Boolean(env.STRIPE_SECRET_KEY),
    stripe_webhook: Boolean(env.STRIPE_WEBHOOK_SECRET),
    databento: Boolean(env.DATABENTO_API_KEY),
  };

  return json({
    business: env.BBA_BUSINESS_NAME,
    env: env.BBA_ENV,
    config,
    spend_today_cents: spend,
    spend_by_channel: await spendByChannel(env),
    accounts,
    supported: { organic: ORGANIC_CHANNELS, ads: ADS_CHANNELS, all: CHANNELS },
    pending_approvals: pendingApprovals?.n ?? 0,
    open_incidents: openIncidents?.n ?? 0,
    last_run: lastRun,
    secrets,
  });
}

async function listApprovals(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get('status') ?? 'pending';
  const rows = await all(
    env,
    `SELECT a.*, d.action, d.rationale, d.channel, d.proposed
       FROM approvals a
       LEFT JOIN decisions d ON d.id = a.decision_id
      WHERE a.status = ?
      ORDER BY
        CASE a.risk WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        a.created_at ASC
      LIMIT 100`,
    status,
  );

  // Attach the subject so a reviewer can judge without another request.
  const enriched = [] as Record<string, unknown>[];
  for (const row of rows as Record<string, unknown>[]) {
    let subject: unknown = null;
    if (row.subject_type === 'creative') {
      subject = await first(
        env,
        'SELECT id, channel, hook, body, cta, editorial_score, editorial_report FROM creatives WHERE id = ?',
        row.subject_id as string,
      );
    } else if (row.subject_type === 'campaign') {
      subject =
        (await first(env, 'SELECT * FROM campaigns WHERE id = ?', row.subject_id as string)) ??
        (await first(env, 'SELECT * FROM campaign_channels WHERE id = ?', row.subject_id as string));
    } else if (row.subject_type === 'budget_change') {
      subject = await first(
        env,
        'SELECT * FROM campaign_channels WHERE id = ?',
        row.subject_id as string,
      );
    }
    enriched.push({ ...row, subject });
  }
  return json({ approvals: enriched });
}

async function listAccounts(env: Env): Promise<Response> {
  return json({
    accounts: await all(
      env,
      `SELECT id, channel, surface, handle, external_id, display_name, status, secret_ref,
              timezone, currency, meta, token_expires_at, updated_at
         FROM accounts ORDER BY channel, surface`,
    ),
  });
}

async function createAccount(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  const channel = String(body.channel ?? '') as Channel;
  const surface = body.surface === 'ads' ? 'ads' : 'organic';
  const externalId = String(body.externalId ?? body.external_id ?? '');
  const secretRef = String(body.secretRef ?? body.secret_ref ?? '');

  if (!CHANNELS.includes(channel)) {
    return json({ error: 'unknown_channel', supported: CHANNELS }, 400);
  }
  if (!externalId || !secretRef) {
    return json({ error: 'externalId and secretRef are both required' }, 400);
  }
  if (typeof env[secretRef] !== 'string') {
    return json(
      {
        error: 'secret_not_set',
        message: `No Worker secret named ${secretRef}. Run: wrangler secret put ${secretRef}`,
      },
      400,
    );
  }

  const accountId = id('acc');
  try {
    await insert(env, 'accounts', {
      id: accountId,
      channel,
      surface,
      handle: body.handle ?? null,
      external_id: externalId,
      display_name: body.displayName ?? body.display_name ?? null,
      timezone: body.timezone ?? 'UTC',
      currency: body.currency ?? 'USD',
      secret_ref: secretRef,
      status: 'active',
      scopes: body.scopes ? JSON.stringify(body.scopes) : null,
      meta: JSON.stringify(body.meta ?? {}),
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return json({ error: 'account_exists', message: 'that channel and external id is already connected' }, 409);
    }
    throw err;
  }

  // Verify immediately so a bad credential is caught here, not at 3am.
  const verify = await runTaskNow(env, { agent: 'guardian', task: 'health_check' });
  return json({ ok: true, accountId, verify });
}

async function createOffer(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  const name = String(body.name ?? '');
  const landingUrl = String(body.landingUrl ?? body.landing_url ?? '');
  const priceCents = Number(body.priceCents ?? body.price_cents ?? 0);
  if (!name || !landingUrl || !Number.isFinite(priceCents)) {
    return json({ error: 'name, landingUrl and priceCents are required' }, 400);
  }
  try {
    new URL(landingUrl);
  } catch {
    return json({ error: 'landingUrl must be an absolute url' }, 400);
  }

  const offerId = id('off');
  await insert(env, 'offers', {
    id: offerId,
    name,
    slug: String(body.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 60),
    description: body.description ?? null,
    landing_url: landingUrl,
    price_cents: Math.round(priceCents),
    currency: body.currency ?? 'USD',
    stripe_product_id: body.stripeProductId ?? null,
    stripe_price_id: body.stripePriceId ?? null,
    target_cac_cents: body.targetCacCents ?? null,
    gross_margin_bps: body.grossMarginBps ?? 10_000,
    status: 'active',
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  return json({ ok: true, offerId });
}

async function listCampaigns(env: Env): Promise<Response> {
  const campaigns = await all<{ id: string }>(
    env,
    'SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 50',
  );
  const withChannels = [];
  for (const campaign of campaigns) {
    withChannels.push({
      ...campaign,
      channels: await all(
        env,
        'SELECT * FROM campaign_channels WHERE campaign_id = ?',
        campaign.id,
      ),
    });
  }
  return json({ campaigns: withChannels });
}

async function createCampaign(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  const name = String(body.name ?? '');
  const offerId = String(body.offerId ?? body.offer_id ?? '');
  const channels = Array.isArray(body.channels) ? body.channels : [];
  if (!name || !offerId || channels.length === 0) {
    return json({ error: 'name, offerId and a non-empty channels array are required' }, 400);
  }

  const parsed: { accountId: string; channel: Channel; dailyBudgetCents: number }[] = [];
  for (const raw of channels as Record<string, unknown>[]) {
    const accountId = String(raw.accountId ?? raw.account_id ?? '');
    const account = await first<{ channel: Channel }>(
      env,
      `SELECT channel FROM accounts WHERE id = ? AND surface = 'ads'`,
      accountId,
    );
    if (!account) return json({ error: `no ads account ${accountId}` }, 400);
    parsed.push({
      accountId,
      channel: account.channel,
      dailyBudgetCents: Math.round(Number(raw.dailyBudgetCents ?? raw.daily_budget_cents ?? 0)),
    });
  }

  const campaignId = await createCampaignRecord(env, {
    name,
    offerId,
    objective: (body.objective ?? 'conversions') as never,
    dailyBudgetCents: parsed.reduce((sum, c) => sum + c.dailyBudgetCents, 0),
    channels: parsed,
    brief: body.brief ?? {},
    startsAt: (body.startsAt as string) ?? null,
    endsAt: (body.endsAt as string) ?? null,
  });
  return json({
    ok: true,
    campaignId,
    note: 'created as a draft, it will not spend until a human approves it',
  });
}

async function listCreatives(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get('status');
  const channel = url.searchParams.get('channel');
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    clauses.push('status = ?');
    binds.push(status);
  }
  if (channel) {
    clauses.push('channel = ?');
    binds.push(channel);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return json({
    creatives: await all(
      env,
      `SELECT * FROM creatives ${where} ORDER BY created_at DESC LIMIT 100`,
      ...binds,
    ),
  });
}

async function listPosts(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get('status');
  const where = status ? 'WHERE p.status = ?' : '';
  const binds = status ? [status] : [];
  return json({
    posts: await all(
      env,
      `SELECT p.*, c.hook, c.body, c.editorial_score
         FROM posts p JOIN creatives c ON c.id = p.creative_id
         ${where}
        ORDER BY p.scheduled_for DESC LIMIT 100`,
      ...binds,
    ),
  });
}

/**
 * Record what a person found when they checked the account.
 *
 * The decision itself is `resolutionFor`, kept pure and next to the rule it
 * enforces, so the one endpoint that can mark a post published without any
 * platform saying so is testable without a database.
 */
async function resolveHeldPost(
  env: Env,
  postId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const post = await first<{ id: string; status: string }>(
    env,
    'SELECT id, status FROM posts WHERE id = ?',
    postId,
  );
  if (!post) return json({ error: 'post not found' }, 404);

  const decision = resolutionFor(post.status, body, nowIso());
  if ('error' in decision) return json({ error: decision.error }, decision.status);

  await update(env, 'posts', postId, decision.patch);

  // The incident exists to make someone look. They looked.
  await env.DB.prepare(
    `UPDATE incidents SET resolved_at = ?
      WHERE resolved_at IS NULL AND code = 'publish_outcome_unknown'
        AND context LIKE ?`,
  )
    .bind(nowIso(), `%${postId}%`)
    .run();

  return json({ ok: true, status: decision.patch.status, warning: decision.warning });
}

async function listDecisions(env: Env, url: URL): Promise<Response> {
  const days = Number(url.searchParams.get('days') ?? 7);
  return json({
    decisions: await all(
      env,
      `SELECT * FROM decisions WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200`,
      `${daysAgoUtc(Number.isFinite(days) ? days : 7)}T00:00:00.000Z`,
    ),
  });
}

async function uploadMedia(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    // The Workers FormData type is looser than the DOM one, so narrow by shape.
    const entry = form.get('file') as unknown;
    if (!isUploadedFile(entry)) {
      return json({ error: 'expected a file field' }, 400);
    }
    const stored = await storeMedia(env, {
      bytes: await entry.arrayBuffer(),
      mimeType: entry.type || 'application/octet-stream',
      filename: entry.name,
      ...(typeof form.get('altText') === 'string' ? { altText: String(form.get('altText')) } : {}),
    });
    return json({ ok: true, ...stored });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: 'empty body' }, 400);
  const stored = await storeMedia(env, {
    bytes,
    mimeType: contentType || 'application/octet-stream',
    ...(request.headers.get('x-filename') ? { filename: request.headers.get('x-filename')! } : {}),
  });
  return json({ ok: true, ...stored });
}

/**
 * Public media. Platforms fetch creative over the open internet, so this route
 * is unauthenticated by necessity. Keys are content hashes, so they are not
 * guessable, and only files this system stored are reachable.
 */
async function serveMedia(env: Env, key: string): Promise<Response> {
  const decoded = decodeURIComponent(key);
  if (!/^[a-f0-9]{8,64}\.[a-z0-9]{2,5}$/i.test(decoded)) {
    return new Response('not found', { status: 404 });
  }
  const object = await env.MEDIA.get(decoded);
  if (!object) return new Response('not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

async function stripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'STRIPE_WEBHOOK_SECRET is not set' }, 503);
  }
  const payload = await request.text();
  const valid = await verifyWebhook(
    payload,
    request.headers.get('stripe-signature'),
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!valid) return json({ error: 'bad signature' }, 400);

  let event: {
    id?: string;
    type?: string;
    created?: number;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const object = event.data?.object ?? {};
  const occurredAt = new Date((event.created ?? Date.now() / 1000) * 1000).toISOString();
  const metadata = (object.metadata as Record<string, string> | undefined) ?? undefined;

  const handlers: Record<string, () => Promise<void>> = {
    'checkout.session.completed': async () => {
      await recordRevenueEvent(env, {
        eventId: event.id ?? id('evt'),
        objectId: String(object.id ?? ''),
        kind: 'payment',
        amountCents: Number(object.amount_total ?? 0),
        currency: String(object.currency ?? 'usd'),
        customerId: (object.customer as string) ?? null,
        occurredAt,
        ...(metadata ? { metadata } : {}),
        raw: { metadata },
      });
    },
    'charge.refunded': async () => {
      await recordRevenueEvent(env, {
        eventId: event.id ?? id('evt'),
        objectId: String(object.id ?? ''),
        kind: 'refund',
        amountCents: -Number(object.amount_refunded ?? 0),
        currency: String(object.currency ?? 'usd'),
        customerId: (object.customer as string) ?? null,
        occurredAt,
        ...(metadata ? { metadata } : {}),
      });
    },
    'invoice.paid': async () => {
      await recordRevenueEvent(env, {
        eventId: event.id ?? id('evt'),
        objectId: String(object.id ?? ''),
        kind: 'subscription_cycle',
        amountCents: Number(object.amount_paid ?? 0),
        currency: String(object.currency ?? 'usd'),
        customerId: (object.customer as string) ?? null,
        occurredAt,
        ...(metadata ? { metadata } : {}),
      });
    },
    'charge.dispute.created': async () => {
      await recordRevenueEvent(env, {
        eventId: event.id ?? id('evt'),
        objectId: String(object.id ?? ''),
        kind: 'dispute',
        amountCents: -Number(object.amount ?? 0),
        currency: String(object.currency ?? 'usd'),
        occurredAt,
      });
      await insert(env, 'incidents', {
        id: id('inc'),
        severity: 'warn',
        source: 'stripe',
        code: 'dispute_opened',
        message: `A dispute was opened on ${String(object.id ?? '')}`,
        context: JSON.stringify({ amount: object.amount }),
        created_at: nowIso(),
      });
    },
  };

  const handler = event.type ? handlers[event.type] : undefined;
  if (handler) await handler();
  return json({ received: true, handled: Boolean(handler), type: event.type });
}

interface UploadedFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  type: string;
  name: string;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UploadedFile).arrayBuffer === 'function'
  );
}

async function safeJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
