/**
 * Rules for the editorial gate.
 *
 * The patterns come from Wikipedia's "Signs of AI writing" (WikiProject AI
 * Cleanup), by way of the humanizer skill at github.com/blader/humanizer.
 * They are encoded as deterministic checks so a draft is scored the same way
 * every time, with no model in the loop and no judgement call to drift.
 *
 * Weights are penalty points against a starting score of 100.
 */

export type Severity = 'block' | 'major' | 'minor';

export interface Rule {
  id: string;
  /** Short name shown in the report so a human can act on it. */
  label: string;
  severity: Severity;
  /** Penalty per hit. */
  weight: number;
  /** Cap so one noisy rule cannot sink an otherwise fine draft on its own. */
  maxPenalty: number;
  pattern: RegExp;
  /** What to do instead, shown to the writer or fed back to the reviser. */
  fix: string;
}

const w = (s: string) => new RegExp(`\\b(?:${s})\\b`, 'gi');

export const RULES: Rule[] = [
  // --- content patterns -----------------------------------------------
  {
    id: 'inflated-importance',
    label: 'Inflated claim about importance',
    severity: 'major',
    weight: 8,
    maxPenalty: 24,
    pattern:
      /\b(?:stands as|serves as|is a testament|a testament to|marking a (?:pivotal|key|major)|pivotal moment|key turning point|evolving landscape|indelible mark|deeply rooted|underscor\w+ (?:its|the) (?:importance|significance)|reflects (?:a )?broader)\b/gi,
    fix: 'State the fact. Cut the claim that it matters.',
  },
  {
    id: 'name-dropping',
    label: 'Name-dropping to prove importance',
    severity: 'minor',
    weight: 5,
    maxPenalty: 10,
    pattern:
      /\b(?:as featured in|as seen (?:in|on)|trusted by (?:thousands|millions)|active social media presence|industry[- ]leading|world[- ]class)\b/gi,
    fix: 'Name the specific result instead of the badge.',
  },
  {
    id: 'shallow-ing-phrase',
    label: 'Shallow analysis via -ing phrase',
    severity: 'major',
    weight: 6,
    maxPenalty: 18,
    pattern:
      /,\s+(?:highlighting|underscoring|emphasizing|ensuring|reflecting|symbolizing|contributing to|cultivating|fostering|encompassing|showcasing|solidifying|cementing)\b/gi,
    fix: 'End the sentence. The trailing clause adds no information.',
  },
  {
    id: 'sales-language',
    label: 'Advertising filler',
    severity: 'major',
    weight: 7,
    maxPenalty: 28,
    pattern: w(
      'boasts a|vibrant|nestled|in the heart of|breathtaking|must-visit|stunning|renowned|groundbreaking|unparalleled|unlock the power|elevate your|take it to the next level|game-?changer|revolutionary|cutting-?edge|seamless|supercharge',
    ),
    fix: 'Replace with the concrete thing the customer gets.',
  },
  {
    id: 'vague-sources',
    label: 'Vague source',
    severity: 'block',
    weight: 15,
    maxPenalty: 30,
    pattern:
      /\b(?:industry reports (?:show|suggest)|experts (?:say|argue|believe)|studies show|research shows|observers have (?:noted|cited)|some critics argue|it is (?:widely )?believed)\b/gi,
    fix: 'Name the source with a link, or cut the claim. Never imply a study we cannot cite.',
  },
  {
    id: 'formulaic-outlook',
    label: 'Stock challenges or outlook section',
    severity: 'minor',
    weight: 5,
    maxPenalty: 10,
    pattern:
      /\b(?:despite (?:its|these) (?:challenges|success)|the future (?:looks|is) bright|exciting times (?:lie )?ahead|continues to thrive|in today's fast-?paced world)\b/gi,
    fix: 'Cut it. End on the last concrete fact.',
  },

  // --- language and grammar -------------------------------------------
  {
    id: 'ai-vocabulary',
    label: 'Stock AI vocabulary',
    severity: 'major',
    weight: 4,
    maxPenalty: 32,
    pattern: w(
      'delve|delves|delving|tapestry|interplay|intricate|intricacies|pivotal|underscore|underscores|testament|showcase|showcases|garner|garners|fostering|foster|myriad|plethora|realm|landscape|robust|leverage|leveraging|harness|harnessing|holistic|synergy|paradigm|meticulous|meticulously|navigate the|embark|journey of|treasure trove|bustling',
    ),
    fix: 'Use the plain word a person would say out loud.',
  },
  {
    id: 'avoiding-is',
    label: 'Padded verb where "is" would do',
    severity: 'minor',
    weight: 3,
    maxPenalty: 12,
    pattern:
      /\b(?:serves as|stands as|represents a|acts as a|functions as a|boasts|features a wide range of|offers a wide range of)\b/gi,
    fix: 'Say "is" or "has".',
  },
  {
    id: 'not-x-but-y',
    label: '"Not just X, it is Y" construction',
    severity: 'major',
    weight: 7,
    maxPenalty: 21,
    pattern:
      /\b(?:it'?s not just|this isn'?t just|not merely|it'?s not about .{0,40}, it'?s about|not only .{0,60}? but also)\b/gi,
    fix: 'Make the positive claim once.',
  },
  {
    id: 'rule-of-three',
    label: 'Forced group of three adjectives',
    severity: 'minor',
    weight: 4,
    maxPenalty: 12,
    pattern: /\b(\w+ly|\w{4,}), (\w+ly|\w{4,}), and (\w+ly|\w{4,})\b/gi,
    fix: 'Two items, or one specific one. Three is a tell.',
  },
  {
    id: 'false-range',
    label: 'False "from X to Y" range',
    severity: 'minor',
    weight: 4,
    maxPenalty: 8,
    pattern: /\bfrom \w[\w\s]{2,30} to \w[\w\s]{2,30},\s*from \w/gi,
    fix: 'List the actual things covered.',
  },

  // --- style -----------------------------------------------------------
  {
    id: 'em-dash',
    label: 'Em or en dash',
    severity: 'major',
    weight: 6,
    maxPenalty: 24,
    pattern: /[—–]|\s--\s/g,
    fix: 'Use a comma, colon, period, or parentheses.',
  },
  {
    id: 'curly-quotes',
    label: 'Curly quotation marks',
    severity: 'minor',
    weight: 2,
    maxPenalty: 6,
    pattern: /[“”‘’]/g,
    fix: 'Use straight quotes so the copy renders the same everywhere.',
  },
  {
    id: 'bold-mini-headings',
    label: 'List item with a bold mini-heading',
    severity: 'minor',
    weight: 4,
    maxPenalty: 12,
    pattern: /^\s*[-*]\s+\*\*[^*]+\*\*\s*:/gm,
    fix: 'Write the sentence without the label.',
  },
  {
    id: 'decorative-emoji',
    label: 'Emoji used as decoration on a heading or list item',
    severity: 'minor',
    weight: 3,
    maxPenalty: 12,
    pattern:
      /^\s*(?:#+\s*|[-*]\s*)?(?:\p{Extended_Pictographic}️?)\s*(?=\*\*|\p{Lu})/gmu,
    fix: 'Drop the emoji or move it into the sentence where it means something.',
  },

  // --- chatbot residue --------------------------------------------------
  {
    id: 'chatbot-residue',
    label: 'Chatbot text left in the copy',
    severity: 'block',
    weight: 25,
    maxPenalty: 50,
    pattern:
      /\b(?:i hope this helps|let me know if|would you like me to|want me to|here'?s (?:a|the) (?:draft|post|caption)|as an ai|feel free to|certainly!|of course!|great question)\b/gi,
    fix: 'Delete. This should never have left the drafting step.',
  },
  {
    id: 'knowledge-disclaimer',
    label: 'Knowledge-limit disclaimer or speculative gap-fill',
    severity: 'block',
    weight: 20,
    maxPenalty: 40,
    pattern:
      /\b(?:as of my (?:last )?(?:knowledge|training)|based on available information|while specific details are (?:limited|scarce)|it is likely that|presumably)\b/gi,
    fix: 'Delete. Never present a guess as a fact in public copy.',
  },
  {
    id: 'placeholder',
    label: 'Unfilled placeholder',
    severity: 'block',
    weight: 40,
    maxPenalty: 40,
    pattern: /\[(?:insert|your|product|company|name|link|url|xx+)[^\]]*\]|\{\{[^}]+\}\}|TBD|LOREM IPSUM/gi,
    fix: 'Fill it in. A placeholder in a live ad is a public mistake.',
  },

  // --- filler and hedging ----------------------------------------------
  {
    id: 'filler-phrases',
    label: 'Filler phrase',
    severity: 'minor',
    weight: 3,
    maxPenalty: 15,
    pattern:
      /\b(?:in order to|due to the fact that|at this point in time|in the event that|has the ability to|it is important to note that|it'?s worth noting that|when it comes to|at the end of the day)\b/gi,
    fix: 'Cut to the verb.',
  },
  {
    id: 'over-hedging',
    label: 'Stacked qualifier',
    severity: 'minor',
    weight: 4,
    maxPenalty: 12,
    pattern:
      /\b(?:could potentially|might arguably|it'?s also possible that|may possibly|somewhat of a|to be fair)\b/gi,
    fix: 'Make the claim or drop it.',
  },
  {
    id: 'fake-depth',
    label: 'Pretending to reveal a deeper truth',
    severity: 'major',
    weight: 6,
    maxPenalty: 18,
    pattern:
      /\b(?:the real question is|at its core|in reality,|what really matters|the deeper (?:issue|truth)|the heart of the matter|here'?s the thing)\b/gi,
    fix: 'State the point directly.',
  },
  {
    id: 'announcing',
    label: 'Announcing the next point instead of making it',
    severity: 'major',
    weight: 6,
    maxPenalty: 18,
    pattern:
      /\b(?:let'?s dive in|let'?s explore|let'?s break (?:this|it) down|here'?s what you need to know|without further ado|buckle up|read on to)\b/gi,
    fix: 'Make the point.',
  },
  {
    id: 'generic-ending',
    label: 'Generic positive ending',
    severity: 'minor',
    weight: 5,
    maxPenalty: 10,
    pattern:
      /\b(?:a step in the right direction|the possibilities are endless|the sky'?s the limit|onwards and upwards|stay tuned for more)\b/gi,
    fix: 'End on the offer or the last real fact.',
  },
  {
    id: 'engagement-bait',
    label: 'Engagement bait',
    severity: 'major',
    weight: 8,
    maxPenalty: 16,
    pattern:
      /\b(?:comment ["']?\w+["']? below and|drop a \w+ (?:below|in the comments) if|like and share if|tag (?:3|three) friends|double tap if)\b/gi,
    fix: 'Most platforms demote this and it trains the wrong audience.',
  },
];

/**
 * Claims that need substantiation before they can run as an ad. These are not
 * style problems, they are compliance problems, so they always block.
 */
export const CLAIM_RULES: Rule[] = [
  {
    id: 'earnings-claim',
    label: 'Income or earnings claim',
    severity: 'block',
    weight: 100,
    maxPenalty: 100,
    pattern:
      /\b(?:guaranteed (?:income|returns|profit)|make \$[\d,]+ (?:a|per) (?:day|week|month)|risk[- ]free|double your money|passive income guaranteed|get rich)\b/gi,
    fix: 'Meta, TikTok and Google all reject this. Use a documented result with the disclosure attached.',
  },
  {
    id: 'health-claim',
    label: 'Health or medical claim',
    severity: 'block',
    weight: 100,
    maxPenalty: 100,
    pattern: /\b(?:cures?|treats?|prevents?) (?:cancer|disease|diabetes|covid)\b|\bclinically proven\b/gi,
    fix: 'Remove, or attach the substantiation the platform requires.',
  },
  {
    id: 'superlative-absolute',
    label: 'Unqualified absolute superlative',
    severity: 'major',
    weight: 10,
    maxPenalty: 20,
    pattern: /\b(?:the (?:best|only|#1|number one) \w+ (?:in the world|ever|period)|100% (?:guaranteed|effective))\b/gi,
    fix: 'Qualify it or cut it. Ad reviewers treat these as unsubstantiated.',
  },
];
