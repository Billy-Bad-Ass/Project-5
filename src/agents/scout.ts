import { all, first, insert, parseJson, run } from '../lib/db';
import { apiFetch } from '../lib/http';
import { id } from '../lib/ids';
import { nowIso } from '../lib/time';
import { completeJson, MODELS } from '../integrations/anthropic';
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

export const scout: Agent = {
  id: 'scout',
  describe: 'Reads the offer page and turns it into the claim list writers may not exceed.',

  tasks: {
    /**
     * Read an offer's landing page and store what it actually claims, so the
     * creative agent has facts rather than adjectives to work from.
     */
    async research_offer(ctx, payload) {
      if (!ctx.env.ANTHROPIC_API_KEY) return failed('ANTHROPIC_API_KEY is not set');
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

      const extracted = await completeJson<{
        claims: string[];
        proof_points: string[];
        audience?: string;
        tone_notes?: string[];
      }>(ctx.env, {
        model: MODELS.worker,
        maxTokens: 1500,
        temperature: 0.2,
        system: [
          'You extract what a landing page factually claims. You do not summarise, improve, or embellish.',
          'A claim goes in the list only if the page states it. Never infer, never generalise, never add a number the page does not contain.',
          'Marketing adjectives with no substance behind them are not claims. Leave them out.',
        ].join('\n'),
        prompt: `Page: ${offer.landing_url}\n\n${text.slice(0, 40_000)}`,
        schema: CLAIMS_SCHEMA as unknown as Record<string, unknown>,
      });

      const voice = await loadVoice(ctx.env);
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

/** Fetch a page and reduce it to readable text. No parser, so keep it simple. */
async function readableText(url: string): Promise<string> {
  const res = await apiFetch<{ raw?: string } | string>(url, {
    channel: 'scout',
    headers: { 'user-agent': 'BBA-Growth-OS/0.1 (+https://github.com/Billy-Bad-Ass/Project-5)' },
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
