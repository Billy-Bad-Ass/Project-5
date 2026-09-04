import { all, first, insert, parseJson, run } from '../lib/db';
import { apiFetch } from '../lib/http';
import { id } from '../lib/ids';
import { nowIso } from '../lib/time';
import { completeJson, hasModelAccess, MODELS } from '../integrations/anthropic';
import { DEFAULT_VOICE, loadVoice, type VoiceProfile } from '../editorial/voice';
import type { Offer } from '../types';
import { type Agent, failed, num, ok, str, strList } from './agent';

/**
 * The scout gathers the facts the writers are allowed to use.
 *
 * This is the other half of the anti-slop design. The editorial gate removes
 * language that sounds invented; the scout makes sure there is something real
 * to say instead, by reading the actual landing page and turning it into the
 * list of claims a writer may not exceed.
 *
 * It only fetches pages the operator has pointed it at, and it honours
 * robots.txt. Heavier collection belongs in an offline job, not in a Worker.
 */
const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: { type: 'string' },
      description: 'Verbatim or near-verbatim factual claims the page actually makes.',
    },
    proof_points: {
      type: 'array',
      items: { type: 'string' },
      description: 'Numbers, names, guarantees, and specifics found on the page.',
    },
    audience: { type: 'string' },
    tone_notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['claims', 'proof_points'],
} as const;

/**
 * Whether there is any point calling a model at all.
 *
 * The claim list is the output of this task, and it does not have to come from
 * a model. `Code/growth/CLAIMS.md` is generated from the catalog, which is a
 * better source than a scraped landing page: it is the authoritative record of
 * what has been built, it carries a proof line per entry, and it is checked in.
 * Once that list is loaded, re-deriving it from a web page every day spends
 * money to produce a worse answer.
 *
 * Pure, so it can be tested without a database or a network.
 */
export function researchDecision(input: {
  claimsOnFile: number;
  hasKey: boolean;
  force?: boolean;
}): { act: boolean; reason: string } {
  if (input.force) return { act: true, reason: 'forced, re-deriving the claim list' };
  if (input.claimsOnFile > 0) {
    return {
      act: false,
      reason: `${input.claimsOnFile} claims already on file, nothing to research (pass force to re-derive)`,
    };
  }
  if (!input.hasKey) {
    return {
      act: false,
      reason:
        'no claim list and no model configured. Load one with Code/scripts/build-claims.mjs',
    };
  }
  return { act: true, reason: 'no claims on file' };
}

/**
 * A model that cannot be paid for is a configuration state, not an incident.
 *
 * This deployment opened a fresh error incident every day over an unfunded
 * account. Ten of them, all identical, none of them news after the first.
 * Recognising the shape lets the task skip cleanly and record the fact once,
 * instead of failing three attempts a day forever.
 */
export function isUnfundedOrUnauthorised(err: unknown): boolean {
  const text = String(err).toLowerCase();
  return (
    text.includes('credit balance is too low') ||
    text.includes('billing') ||
    text.includes('quota') ||
    text.includes('insufficient') ||
    text.includes('invalid x-api-key') ||
    text.includes('authentication_error') ||
    text.includes('failed with 401')
  );
}

export const scout: Agent = {
  id: 'scout',
  describe: 'Reads the offer page and turns it into the claim list writers may not exceed.',

  tasks: {
    /**
     * Read an offer's landing page and store what it actually claims, so the
     * creative agent has facts rather than adjectives to work from.
     */
    async research_offer(ctx, payload) {
      const voice = await loadVoice(ctx.env);
      const decision = researchDecision({
        claimsOnFile: voice.provenClaims.length,
        hasKey: hasModelAccess(ctx.env),
        force: payload.force === true,
      });
      if (!decision.act) {
        return ok(decision.reason, { data: { claims_on_file: voice.provenClaims.length } });
      }

      const offerId = str(payload, 'offerId');
      const offer = offerId
        ? await first<Offer>(ctx.env, 'SELECT * FROM offers WHERE id = ?', offerId)
        : await first<Offer>(ctx.env, `SELECT * FROM offers WHERE status = 'active' LIMIT 1`);
      if (!offer) return failed('no offer to research');

      const allowed = await robotsAllows(offer.landing_url);
      if (!allowed) {
        return ok(`robots.txt disallows fetching ${offer.landing_url}, skipping`);
      }

      let text: string;
      try {
        text = await readableText(offer.landing_url);
      } catch (err) {
        return failed(`could not read ${offer.landing_url}: ${String(err).slice(0, 200)}`);
      }
      if (text.length < 200) {
        return ok('landing page had almost no readable text, nothing to extract');
      }

      type Extracted = {
        claims: string[];
        proof_points: string[];
        audience?: string;
        tone_notes?: string[];
      };
      let extracted: Extracted;
      try {
        extracted = await completeJson<Extracted>(ctx.env, {
        model: MODELS.worker,
        maxTokens: 1500,
        system: [
          'You extract what a landing page factually claims. You do not summarise, improve, or embellish.',
          'A claim goes in the list only if the page states it. Never infer, never generalise, never add a number the page does not contain.',
          'Marketing adjectives with no substance behind them are not claims. Leave them out.',
        ].join('\n'),
        prompt: `Page: ${offer.landing_url}\n\n${text.slice(0, 40_000)}`,
          schema: CLAIMS_SCHEMA as unknown as Record<string, unknown>,
        });
      } catch (err) {
        if (!isUnfundedOrUnauthorised(err)) throw err;
        await noteModelUnavailable(ctx, err);
        return ok(
          'the model is not reachable on this account, so no claims were derived. Load a list with Code/scripts/build-claims.mjs',
          { data: { model_unavailable: true } },
        );
      }

      const merged: VoiceProfile = {
        ...voice,
        provenClaims: dedupe([
          ...voice.provenClaims,
          ...extracted.claims,
          ...extracted.proof_points,
        ]).slice(0, 40),
        ...(extracted.audience && voice.audience === DEFAULT_VOICE.audience
          ? { audience: extracted.audience }
          : {}),
      };
      await run(
        ctx.env,
        `INSERT INTO settings (key, value, updated_at) VALUES ('voice_profile', ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        JSON.stringify(merged),
        nowIso(),
      );

      await ctx.decide({
        agent: 'scout',
        action: 'update_claim_list',
        targetType: 'offer',
        targetId: offer.id,
        rationale: `read ${offer.landing_url} and recorded ${extracted.claims.length} claims`,
        evidence: { claims: extracted.claims, proof_points: extracted.proof_points },
      });

      return ok(
        `recorded ${merged.provenClaims.length} claims writers may use`,
        { data: { claims: extracted.claims, proof_points: extracted.proof_points } },
      );
    },

    /**
     * Fetch configured JSON or RSS sources and store anything new as a signal
     * the strategist can read. Sources are set in settings, key `scout_sources`.
     */
    async scan_sources(ctx, payload) {
      const configured = await first<{ value: string }>(
        ctx.env,
        `SELECT value FROM settings WHERE key = 'scout_sources'`,
      );
      const sources = strList(payload, 'sources').length
        ? strList(payload, 'sources')
        : parseJson<string[]>(configured?.value ?? null, []);
      if (sources.length === 0) {
        return ok('no sources configured, set settings.scout_sources to a JSON array of urls');
      }

      const limit = num(payload, 'limit') ?? 10;
      const findings: { source: string; note: string }[] = [];

      for (const source of sources.slice(0, limit)) {
        try {
          if (!(await robotsAllows(source))) {
            findings.push({ source, note: 'skipped, robots.txt disallows' });
            continue;
          }
          const text = await readableText(source);
          findings.push({ source, note: `${text.length} characters read` });
          await insert(
            ctx.env,
            'incidents',
            {
              id: id('inc'),
              severity: 'info',
              source: 'agent:scout',
              code: 'source_scanned',
              message: `read ${source}`,
              context: JSON.stringify({ excerpt: text.slice(0, 1500) }),
              resolved_at: nowIso(),
              created_at: nowIso(),
            },
          );
        } catch (err) {
          findings.push({ source, note: `failed: ${String(err).slice(0, 150)}` });
        }
      }
      return ok(`scanned ${findings.length} sources`, { data: { findings } });
    },

    /** What are our own best posts doing? Feeds the voice exemplars. */
    async refresh_exemplars(ctx) {
      const rows = await all<{ body: string; engagements: number; channel: string }>(
        ctx.env,
        `SELECT c.body AS body, SUM(m.engagements) AS engagements, p.channel AS channel
           FROM posts p
           JOIN creatives c ON c.id = p.creative_id
           JOIN metrics m ON m.entity_type = 'post' AND m.entity_id = p.external_id
          WHERE p.status = 'published' AND p.published_at >= date('now','-90 day')
          GROUP BY p.id
         HAVING engagements > 0
          ORDER BY engagements DESC
          LIMIT 6`,
      );
      if (rows.length === 0) return ok('no published posts with engagement data yet');

      const voice = await loadVoice(ctx.env);
      const next = { ...voice, exemplars: rows.map((r) => r.body) };
      await run(
        ctx.env,
        `INSERT INTO settings (key, value, updated_at) VALUES ('voice_profile', ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        JSON.stringify(next),
        nowIso(),
      );
      return ok(`refreshed ${rows.length} voice exemplars from real performance`);
    },
  },
};

/**
 * Record that the model is unreachable, once, not once a day.
 *
 * Mirrors the guardian's `markNeedsReauth`: if an unresolved incident with this
 * code already exists, say nothing further. One open incident is a fact worth
 * seeing on the dashboard. Ten identical ones are noise that hides the next
 * real problem.
 */
async function noteModelUnavailable(
  ctx: Parameters<Agent['tasks'][string]>[0],
  err: unknown,
): Promise<void> {
  const existing = await first<{ id: string }>(
    ctx.env,
    `SELECT id FROM incidents WHERE code = 'model_unavailable' AND resolved_at IS NULL LIMIT 1`,
  );
  if (existing) return;
  await insert(ctx.env, 'incidents', {
    id: id('inc'),
    severity: 'warn',
    source: 'agent:scout',
    code: 'model_unavailable',
    message: 'the Anthropic account cannot be charged, so the writing agents are offline',
    context: JSON.stringify({ error: String(err).slice(0, 500) }),
    created_at: nowIso(),
  });
}

/** Fetch a page and reduce it to readable text. No parser, so keep it simple. */
async function readableText(url: string): Promise<string> {
  const res = await apiFetch<{ raw?: string } | string>(url, {
    channel: 'scout',
    headers: { 'user-agent': 'BBA-Growth-OS/0.1 (+https://github.com/Billy-Bad-Ass/growth-os-5)' },
    attempts: 2,
    timeoutMs: 15_000,
  });
  const html = typeof res === 'string' ? res : (res?.raw ?? JSON.stringify(res));
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minimal robots.txt check for our own user agent and the wildcard group. */
async function robotsAllows(url: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  try {
    const res = await fetch(`${target.origin}/robots.txt`, {
      headers: { 'user-agent': 'BBA-Growth-OS/0.1' },
    });
    if (!res.ok) return true; // no robots.txt means no restriction
    const body = await res.text();

    let inScope = false;
    const disallowed: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.split('#')[0]?.trim() ?? '';
      if (!line) continue;
      const [field, ...rest] = line.split(':');
      const key = field?.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') {
        inScope = value === '*' || value.toLowerCase().includes('bba-growth-os');
      } else if (key === 'disallow' && inScope && value) {
        disallowed.push(value);
      }
    }
    return !disallowed.some((path) => path === '/' || target.pathname.startsWith(path));
  } catch {
    return true;
  }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}
