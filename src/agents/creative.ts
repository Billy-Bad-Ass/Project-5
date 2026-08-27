import { all, first, insert, parseJson, update } from '../lib/db';
import { id } from '../lib/ids';
import { nowIso } from '../lib/time';
import { completeJson, MODELS } from '../integrations/anthropic';
import { lint, revisionBrief, type EditorialReport } from '../editorial/slop';
import { CHANNEL_LIMITS, loadVoice, topPerformingExemplars, voicePrompt } from '../editorial/voice';
import type { Campaign, Channel, Creative, Offer } from '../types';
import { type Agent, num, ok, str, strList, failed } from './agent';

/**
 * The creative agent writes copy and refuses to ship its own bad copy.
 *
 * Draft, lint, revise, lint again. If it still cannot clear the editorial gate
 * after the revision budget, the draft is parked as needs_revision with the
 * findings attached rather than pushed through at a lower bar. That loop is the
 * whole answer to "no AI slop": the gate is deterministic, the model does not
 * get to grade its own work, and a human still signs off at the end.
 */
const MAX_REVISIONS = 2;

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          hook: { type: 'string', description: 'First line. Must work with sound off.' },
          body: { type: 'string' },
          cta: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          angle: { type: 'string', description: 'The specific claim or tension this variant plays on.' },
        },
        required: ['hook', 'body', 'cta', 'angle'],
      },
    },
  },
  required: ['variants'],
} as const;

interface DraftVariant {
  hook: string;
  body: string;
  cta: string;
  hashtags?: string[];
  angle: string;
}

export const creative: Agent = {
  id: 'creative',
  describe: 'Writes copy, then holds it against the editorial gate until it passes or is parked.',

  tasks: {
    /**
     * Produce a batch of channel-specific drafts for a campaign, or for the
     * organic calendar when no campaign is given.
     */
    async draft_batch(ctx, payload) {
      if (!ctx.env.ANTHROPIC_API_KEY) {
        return failed('ANTHROPIC_API_KEY is not set, cannot draft');
      }
      const campaignId = str(payload, 'campaignId');
      const channels = (strList(payload, 'channels').length
        ? strList(payload, 'channels')
        : ['tiktok', 'instagram', 'threads', 'facebook']) as Channel[];
      const count = Math.min(4, num(payload, 'count') ?? 2);
      const kind = (str(payload, 'kind') ?? 'organic_post') as Creative['kind'];

      const campaign = campaignId
        ? await first<Campaign>(ctx.env, 'SELECT * FROM campaigns WHERE id = ?', campaignId)
        : null;
      const offer = campaign?.offer_id
        ? await first<Offer>(ctx.env, 'SELECT * FROM offers WHERE id = ?', campaign.offer_id)
        : await first<Offer>(ctx.env, `SELECT * FROM offers WHERE status = 'active' LIMIT 1`);

      const voice = await loadVoice(ctx.env);
      const exemplars = await topPerformingExemplars(ctx.env, 4);
      const system = [
        voicePrompt(voice, exemplars),
        '',
        'You are writing for a real business that will spend real money on this.',
        'Hard rules:',
        '- Every claim must be one the brief supports. If the brief does not support it, do not write it.',
        '- No em dashes. No emoji as decoration. Straight quotes only.',
        '- Do not announce what you are about to say. Say it.',
        '- Do not end on optimism. End on the offer or the last concrete fact.',
        '- No engagement bait. No "comment X below".',
        '- Each variant must take a genuinely different angle, not reword the same one.',
      ].join('\n');

      const created: string[] = [];
      const parked: string[] = [];

      for (const channel of channels) {
        const limits = CHANNEL_LIMITS[channel];
        const brief = {
          channel,
          character_limit: limits.maxChars,
          hashtag_limit: limits.maxHashtags,
          variants_wanted: count,
          campaign: campaign
            ? { name: campaign.name, objective: campaign.objective, brief: parseJson(campaign.brief, {}) }
            : null,
          offer: offer
            ? {
                name: offer.name,
                description: offer.description,
                price: `${(offer.price_cents / 100).toFixed(2)} ${offer.currency}`,
                landing_url: offer.landing_url,
              }
            : null,
          format_note:
            channel === 'tiktok' || channel === 'youtube'
              ? 'Short video script. The hook is the first three seconds and must work with sound off.'
              : channel === 'x' || channel === 'threads'
                ? 'One post, no thread. It has to land in a single screen.'
                : 'Feed post.',
        };

        let drafts: DraftVariant[];
        try {
          const res = await completeJson<{ variants: DraftVariant[] }>(ctx.env, {
            model: MODELS.writer,
            system,
            prompt: `Write ${count} variants.\n\n${JSON.stringify(brief, null, 2)}`,
            schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
            maxTokens: 3000,
          });
          drafts = res.variants ?? [];
        } catch (err) {
          ctx.log.warn('draft failed', { channel, err: String(err) });
          continue;
        }

        for (const draft of drafts) {
          const outcome = await refine(ctx, {
            draft,
            channel,
            kind,
            campaignId: campaign?.id ?? null,
            voiceBanned: voice.bannedPhrases,
            system,
            brief,
          });
          if (outcome.passed) created.push(outcome.creativeId);
          else parked.push(outcome.creativeId);
        }
      }

      // Everything that passed the gate still needs a person.
      for (const creativeId of created) {
        await ctx.requestApproval({
          subjectType: 'creative',
          subjectId: creativeId,
          summary: `New copy cleared the editorial gate and is waiting to publish`,
          risk: 'normal',
        });
      }

      return ok(
        `${created.length} drafts cleared the gate, ${parked.length} parked for revision`,
        { data: { created, parked } },
      );
    },

    /** Re-run the gate on an existing creative, for example after a hand edit. */
    async relint(ctx, payload) {
      const creativeId = str(payload, 'creativeId');
      if (!creativeId) return failed('relint needs a creativeId');
      const row = await first<Creative>(ctx.env, 'SELECT * FROM creatives WHERE id = ?', creativeId);
      if (!row) return failed(`creative ${creativeId} not found`);

      const voice = await loadVoice(ctx.env);
      const report = lintCreative(row, voice.bannedPhrases, ctx.config.editorialMinScore);
      await update(ctx.env, 'creatives', creativeId, {
        editorial_score: report.score,
        editorial_report: JSON.stringify(report),
        status: report.pass ? 'pending_approval' : 'needs_revision',
      });
      return ok(`score ${report.score}, ${report.pass ? 'passes' : 'below the bar'}`, {
        data: { report },
      });
    },
  },
};

/** Draft, lint, revise. Returns whichever version got furthest. */
async function refine(
  ctx: Parameters<Agent['tasks'][string]>[0],
  input: {
    draft: DraftVariant;
    channel: Channel;
    kind: Creative['kind'];
    campaignId: string | null;
    voiceBanned: string[];
    system: string;
    brief: unknown;
  },
): Promise<{ creativeId: string; passed: boolean; score: number }> {
  const limits = CHANNEL_LIMITS[input.channel];
  let current = input.draft;
  let report = lintText(current, input.voiceBanned, ctx.config.editorialMinScore, limits.maxChars, input.kind === 'ad');

  for (let round = 0; round < MAX_REVISIONS && !report.pass; round++) {
    ctx.log.info('revising draft', {
      channel: input.channel,
      round: round + 1,
      score: report.score,
      blocking: report.findings.filter((f) => f.severity === 'block').map((f) => f.rule),
    });
    try {
      const revised = await completeJson<{ variants: DraftVariant[] }>(ctx.env, {
        model: MODELS.writer,
        system: input.system,
        prompt: [
          'Revise this draft. Keep the angle and every claim it makes. Do not add facts.',
          '',
          JSON.stringify(current, null, 2),
          '',
          revisionBrief(report),
          '',
          `Context: ${JSON.stringify(input.brief)}`,
        ].join('\n'),
        schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 2000,
      });
      const next = revised.variants?.[0];
      if (!next) break;
      const nextReport = lintText(
        next,
        input.voiceBanned,
        ctx.config.editorialMinScore,
        limits.maxChars,
        input.kind === 'ad',
      );
      // Only keep a revision that actually improved things.
      if (nextReport.score >= report.score) {
        current = next;
        report = nextReport;
      } else {
        ctx.log.info('revision scored worse, keeping the earlier draft', {
          before: report.score,
          after: nextReport.score,
        });
        break;
      }
    } catch (err) {
      ctx.log.warn('revision failed', { err: String(err) });
      break;
    }
  }

  const creativeId = id('crv');
  await insert(ctx.env, 'creatives', {
    id: creativeId,
    campaign_id: input.campaignId,
    kind: input.kind,
    channel: input.channel,
    version: 1,
    hook: current.hook,
    body: current.body,
    cta: current.cta,
    hashtags: JSON.stringify((current.hashtags ?? []).slice(0, limits.maxHashtags)),
    media: '[]',
    editorial_score: report.score,
    editorial_report: JSON.stringify(report),
    status: report.pass ? 'pending_approval' : 'needs_revision',
    authored_by: 'agent:creative',
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  await ctx.decide({
    agent: 'creative',
    action: report.pass ? 'draft_passed_gate' : 'draft_parked',
    targetType: 'creative',
    targetId: creativeId,
    channel: input.channel,
    rationale: report.pass
      ? `scored ${report.score} against a threshold of ${ctx.config.editorialMinScore}`
      : `scored ${report.score}, blocked by ${report.findings
          .filter((f) => f.severity === 'block')
          .map((f) => f.rule)
          .join(', ') || 'score threshold'}`,
    evidence: { score: report.score, findings: report.findings.slice(0, 6) },
    proposed: { angle: current.angle },
  });

  return { creativeId, passed: report.pass, score: report.score };
}

function lintText(
  draft: DraftVariant,
  bannedPhrases: string[],
  minScore: number,
  maxChars: number,
  isAd: boolean,
): EditorialReport {
  const full = [draft.hook, draft.body, draft.cta].filter(Boolean).join('\n\n');
  return lint(full, { minScore, maxChars, isAd, bannedPhrases });
}

function lintCreative(row: Creative, bannedPhrases: string[], minScore: number): EditorialReport {
  const full = [row.hook, row.body, row.cta].filter(Boolean).join('\n\n');
  const limits = row.channel ? CHANNEL_LIMITS[row.channel] : undefined;
  return lint(full, {
    minScore,
    bannedPhrases,
    isAd: row.kind === 'ad',
    ...(limits ? { maxChars: limits.maxChars } : {}),
  });
}

/** Approved creative that has not been scheduled yet, per channel. */
export async function readyCreatives(
  env: import('../env').Env,
  channel: Channel,
  limit = 5,
): Promise<Creative[]> {
  return all<Creative>(
    env,
    `SELECT c.* FROM creatives c
      WHERE c.status = 'approved' AND c.channel = ?
        AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.creative_id = c.id)
      ORDER BY c.editorial_score DESC, c.created_at ASC
      LIMIT ?`,
    channel,
    limit,
  );
}
