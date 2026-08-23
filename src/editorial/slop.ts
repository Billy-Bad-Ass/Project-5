import { CLAIM_RULES, RULES, type Rule, type Severity } from './patterns';

export interface Finding {
  rule: string;
  label: string;
  severity: Severity;
  fix: string;
  hits: number;
  penalty: number;
  samples: string[];
}

export interface EditorialReport {
  score: number;
  /** True when nothing blocking fired and the score clears the threshold. */
  pass: boolean;
  blocked: boolean;
  findings: Finding[];
  stats: {
    words: number;
    sentences: number;
    avgSentenceWords: number;
    longestSentenceWords: number;
    /** Share of sentences that open with the same word. 1.0 means all of them. */
    repeatedOpeningRatio: number;
    /** Distinct words over total words. Low means the copy circles itself. */
    lexicalDiversity: number;
  };
  notes: string[];
}

export interface LintOptions {
  minScore?: number;
  /** Ad copy is held to the claim rules as well as the style rules. */
  isAd?: boolean;
  /** Hard character budget for the target channel. */
  maxChars?: number;
  /** Phrases this brand has decided never to use. */
  bannedPhrases?: string[];
}

const SAMPLE_LIMIT = 3;

/**
 * Score a draft. Deterministic, no model call, so the same text always gets the
 * same verdict and a reviser can be told exactly what to change.
 */
export function lint(text: string, opts: LintOptions = {}): EditorialReport {
  const minScore = opts.minScore ?? 78;
  const findings: Finding[] = [];
  const notes: string[] = [];

  const rules: Rule[] = opts.isAd ? [...RULES, ...CLAIM_RULES] : RULES;

  for (const rule of rules) {
    const matches = collect(text, rule.pattern);
    if (matches.length === 0) continue;
    const penalty = Math.min(rule.maxPenalty, matches.length * rule.weight);
    findings.push({
      rule: rule.id,
      label: rule.label,
      severity: rule.severity,
      fix: rule.fix,
      hits: matches.length,
      penalty,
      samples: matches.slice(0, SAMPLE_LIMIT),
    });
  }

  for (const phrase of opts.bannedPhrases ?? []) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    const re = new RegExp(escapeRegex(trimmed), 'gi');
    const matches = collect(text, re);
    if (matches.length === 0) continue;
    findings.push({
      rule: 'brand-banned-phrase',
      label: `Banned phrase: ${trimmed}`,
      severity: 'block',
      fix: 'The brand voice guide rules this out.',
      hits: matches.length,
      penalty: 20 * matches.length,
      samples: matches.slice(0, SAMPLE_LIMIT),
    });
  }

  const stats = describe(text);

  // Structural tells that no single regex catches.
  if (stats.repeatedOpeningRatio >= 0.5 && stats.sentences >= 3) {
    findings.push({
      rule: 'repeated-openings',
      label: 'Sentences keep opening the same way',
      severity: 'major',
      fix: 'Merge sentences or start one with the action instead of the subject.',
      hits: 1,
      penalty: 8,
      samples: [],
    });
  }
  if (stats.lexicalDiversity < 0.45 && stats.words >= 60) {
    findings.push({
      rule: 'low-lexical-diversity',
      label: 'Copy circles the same words',
      severity: 'minor',
      fix: 'Cut the repetition rather than swapping in synonyms.',
      hits: 1,
      penalty: 6,
      samples: [],
    });
  }
  if (stats.longestSentenceWords > 45) {
    findings.push({
      rule: 'runaway-sentence',
      label: `A sentence runs ${stats.longestSentenceWords} words`,
      severity: 'minor',
      fix: 'Split it. Nobody reads that on a phone.',
      hits: 1,
      penalty: 5,
      samples: [],
    });
  }
  if (opts.maxChars && text.length > opts.maxChars) {
    findings.push({
      rule: 'over-length',
      label: `${text.length} characters, limit is ${opts.maxChars}`,
      severity: 'block',
      fix: 'Trim to fit. The platform will truncate or reject it.',
      hits: 1,
      penalty: 30,
      samples: [],
    });
  }
  if (stats.words < 8) {
    notes.push('Very short draft. Style scoring is weak below about 8 words.');
  }

  const totalPenalty = findings.reduce((sum, f) => sum + f.penalty, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - totalPenalty)));
  const blocked = findings.some((f) => f.severity === 'block');

  findings.sort((a, b) => b.penalty - a.penalty);

  return {
    score,
    blocked,
    pass: !blocked && score >= minScore,
    findings,
    stats,
    notes,
  };
}

/**
 * Turn a report into instructions a reviser can act on. Used as the feedback
 * half of the draft-lint-revise loop in the creative agent.
 */
export function revisionBrief(report: EditorialReport): string {
  if (report.pass) return 'No changes required.';
  const lines = [
    `Editorial score ${report.score}. ${report.blocked ? 'Blocking issues present.' : 'Below threshold.'}`,
    'Fix these without changing what the copy claims, and without inventing facts:',
  ];
  for (const f of report.findings) {
    const samples = f.samples.length ? ` Found: ${f.samples.map((s) => `"${s}"`).join(', ')}.` : '';
    lines.push(`- [${f.severity}] ${f.label}. ${f.fix}${samples}`);
  }
  return lines.join('\n');
}

function collect(text: string, pattern: RegExp): string[] {
  // Clone so a shared /g regex never carries lastIndex between calls.
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 500) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    out.push(m[0].trim());
  }
  return out;
}

function describe(text: string): EditorialReport['stats'] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sentenceWordCounts = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const openings = new Map<string, number>();
  for (const s of sentences) {
    const first = (s.split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z']/g, '');
    if (!first) continue;
    openings.set(first, (openings.get(first) ?? 0) + 1);
  }
  const maxOpening = Math.max(0, ...openings.values());
  const distinct = new Set(words.map((word) => word.toLowerCase().replace(/[^a-z0-9']/g, ''))).size;

  return {
    words: words.length,
    sentences: sentences.length,
    avgSentenceWords: sentences.length ? Math.round((words.length / sentences.length) * 10) / 10 : 0,
    longestSentenceWords: sentenceWordCounts.length ? Math.max(...sentenceWordCounts) : 0,
    repeatedOpeningRatio: sentences.length ? maxOpening / sentences.length : 0,
    lexicalDiversity: words.length ? Math.round((distinct / words.length) * 100) / 100 : 1,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
