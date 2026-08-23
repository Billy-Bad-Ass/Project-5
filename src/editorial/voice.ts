import type { Env } from '../env';
import { all, first } from '../lib/db';
import type { Channel } from '../types';

/**
 * The brand voice guide. Stored in settings so it can be edited from the
 * console without a deploy, with a sane default for a fresh install.
 */
export interface VoiceProfile {
  brand: string;
  /** One paragraph a writer could actually follow. */
  positioning: string;
  audience: string;
  /** Habits to copy: sentence length, register, punctuation. */
  style: string[];
  bannedPhrases: string[];
  /** Real past posts that performed. Used as few-shot examples, not templates. */
  exemplars: string[];
  /** Things the brand can factually claim. The writer may not exceed this list. */
  provenClaims: string[];
}

export const DEFAULT_VOICE: VoiceProfile = {
  brand: 'BBA Network',
  positioning:
    'BBA Network builds and runs software and media businesses. Copy should sound like an operator talking to another operator: specific, unbothered, and willing to name a number.',
  audience:
    'People who buy tools and services to run a business or a trading operation. They have been sold to badly before and they can smell it.',
  style: [
    'Short sentences. One idea each.',
    'Lead with the concrete thing, not the setup.',
    'Numbers over adjectives. If there is no number, use a specific noun.',
    'Straight quotes, no em dashes, no emoji as decoration.',
    'First person plural for the business, second person for the reader.',
    'Never explain that you are about to say something. Say it.',
  ],
  bannedPhrases: [
    'game changer',
    'level up',
    'unlock',
    'in today\'s world',
    'the future of',
    'dive in',
    'crush it',
    'no-brainer',
  ],
  exemplars: [],
  provenClaims: [],
};

const VOICE_KEY = 'voice_profile';

export async function loadVoice(env: Env): Promise<VoiceProfile> {
  const row = await first<{ value: string }>(
    env,
    'SELECT value FROM settings WHERE key = ?',
    VOICE_KEY,
  );
  if (!row) return DEFAULT_VOICE;
  try {
    const parsed = JSON.parse(row.value) as Partial<VoiceProfile>;
    return { ...DEFAULT_VOICE, ...parsed };
  } catch {
    return DEFAULT_VOICE;
  }
}

/**
 * Pull the best recent organic posts to use as voice exemplars. Real posts that
 * worked beat any invented style sample.
 */
export async function topPerformingExemplars(
  env: Env,
  limit = 5,
): Promise<string[]> {
  const rows = await all<{ body: string }>(
    env,
    `SELECT c.body AS body
       FROM posts p
       JOIN creatives c ON c.id = p.creative_id
       JOIN metrics m ON m.entity_type = 'post' AND m.entity_id = p.external_id
      WHERE p.status = 'published' AND p.external_id IS NOT NULL
      GROUP BY p.id
      ORDER BY SUM(m.engagements) DESC
      LIMIT ?`,
    limit,
  );
  return rows.map((r) => r.body).filter(Boolean);
}

/** Render the voice guide as the system context a writer agent is given. */
export function voicePrompt(voice: VoiceProfile, exemplars: string[]): string {
  const lines = [
    `Brand: ${voice.brand}`,
    `Positioning: ${voice.positioning}`,
    `Audience: ${voice.audience}`,
    '',
    'Style rules:',
    ...voice.style.map((s) => `- ${s}`),
    '',
    `Never use these phrases: ${voice.bannedPhrases.join(', ')}`,
  ];
  if (voice.provenClaims.length) {
    lines.push(
      '',
      'The only claims you may make are these. Do not exceed them, do not invent numbers:',
      ...voice.provenClaims.map((c) => `- ${c}`),
    );
  }
  const samples = exemplars.length ? exemplars : voice.exemplars;
  if (samples.length) {
    lines.push('', 'Posts that worked, for voice only. Do not copy their content:');
    samples.slice(0, 5).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  return lines.join('\n');
}

/** Hard limits the platforms enforce. Copy over these is rejected upstream. */
export const CHANNEL_LIMITS: Record<Channel, { maxChars: number; maxHashtags: number }> = {
  tiktok: { maxChars: 2200, maxHashtags: 8 },
  instagram: { maxChars: 2200, maxHashtags: 30 },
  threads: { maxChars: 500, maxHashtags: 1 },
  facebook: { maxChars: 5000, maxHashtags: 5 },
  x: { maxChars: 280, maxHashtags: 2 },
  youtube: { maxChars: 5000, maxHashtags: 15 },
  pinterest: { maxChars: 500, maxHashtags: 10 },
  linkedin: { maxChars: 3000, maxHashtags: 5 },
  reddit: { maxChars: 40000, maxHashtags: 0 },
  snapchat: { maxChars: 250, maxHashtags: 0 },
  google: { maxChars: 90, maxHashtags: 0 },
};
