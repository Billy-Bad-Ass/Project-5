import { describe, expect, it } from 'vitest';
import { lint, revisionBrief } from '../src/editorial/slop';

/**
 * The editorial gate is the thing standing between an agent and the public
 * feed, so it gets the most direct tests in the project.
 */
describe('editorial gate', () => {
  const clean = [
    'We rebuilt the checkout in April. Refunds dropped from 9% to 4%.',
    'Same product, same price. The old flow asked for a phone number before it showed the total.',
    'If you sell a subscription, that one change is worth an afternoon.',
  ].join(' ');

  it('passes copy that says something specific', () => {
    const report = lint(clean, { minScore: 78 });
    expect(report.blocked).toBe(false);
    expect(report.pass).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(78);
  });

  it('catches stock AI vocabulary', () => {
    const report = lint(
      'Let us delve into the intricate tapestry of growth. This pivotal moment underscores our commitment to a vibrant landscape.',
      { minScore: 78 },
    );
    expect(report.pass).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain('ai-vocabulary');
  });

  it('blocks a vague source outright, whatever the score', () => {
    const report = lint('Studies show our method works better than the alternative.', {
      minScore: 0,
    });
    expect(report.blocked).toBe(true);
    expect(report.pass).toBe(false);
  });

  it('blocks chatbot residue', () => {
    const report = lint('Here is the caption you asked for. I hope this helps!', { minScore: 0 });
    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.rule === 'chatbot-residue')).toBe(true);
  });

  it('blocks an unfilled placeholder', () => {
    const report = lint('Get [product name] today for only $[price].', { minScore: 0 });
    expect(report.findings.some((f) => f.rule === 'placeholder')).toBe(true);
    expect(report.blocked).toBe(true);
  });

  it('flags em dashes', () => {
    const report = lint('The policy — announced without warning — affects everyone.', {
      minScore: 78,
    });
    expect(report.findings.some((f) => f.rule === 'em-dash')).toBe(true);
  });

  it('only applies the claim rules to ads', () => {
    const text = 'Make $5,000 a week, risk-free.';
    expect(lint(text, { minScore: 0, isAd: false }).findings.some((f) => f.rule === 'earnings-claim')).toBe(false);
    expect(lint(text, { minScore: 0, isAd: true }).findings.some((f) => f.rule === 'earnings-claim')).toBe(true);
  });

  it('enforces the channel character limit as a block', () => {
    const report = lint('a '.repeat(200), { minScore: 0, maxChars: 280 });
    expect(report.findings.some((f) => f.rule === 'over-length')).toBe(true);
    expect(report.blocked).toBe(true);
  });

  it('honours brand banned phrases', () => {
    const report = lint('This is a total game changer for your workflow.', {
      minScore: 0,
      bannedPhrases: ['game changer'],
    });
    expect(report.findings.some((f) => f.rule === 'brand-banned-phrase')).toBe(true);
  });

  it('notices repeated sentence openings', () => {
    const report = lint('She noted the door. She noted the lock. She filed both away.', {
      minScore: 78,
    });
    expect(report.findings.some((f) => f.rule === 'repeated-openings')).toBe(true);
  });

  it('is deterministic across repeated calls', () => {
    const text = 'Let us delve into the vibrant tapestry. Studies show it works.';
    const first = lint(text, { minScore: 78 });
    const second = lint(text, { minScore: 78 });
    expect(second.score).toBe(first.score);
    expect(second.findings.length).toBe(first.findings.length);
  });

  it('produces a revision brief a writer could act on', () => {
    const report = lint('Let us dive in. Experts say this is a game changer.', { minScore: 78 });
    const brief = revisionBrief(report);
    expect(brief).toContain('Editorial score');
    expect(brief.split('\n').length).toBeGreaterThan(2);
  });

  it('says nothing to fix when the copy is clean', () => {
    expect(revisionBrief(lint(clean, { minScore: 78 }))).toBe('No changes required.');
  });
});
