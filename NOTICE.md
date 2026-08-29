# Third-party notices

This repository is public, so anything taken from someone else is named here
with what its licence asks for.

## humanizer — the editorial gate's pattern list

`src/editorial/patterns.ts` encodes the phrase list from the
[humanizer](https://github.com/blader/humanizer) skill. The README calls that a
direct port and it is: the selection and ordering of phrases is upstream's
work, re-expressed as regular expressions. The rule labels, the penalty
weights, the severity tiers and the `fix` guidance are ours.

humanizer is **MIT licensed, Copyright (c) 2025 Siqi Chen**, and MIT asks that
its notice travel with any substantial portion. So it does:

> MIT License
>
> Copyright (c) 2025 Siqi Chen
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Wikipedia — where those patterns originally come from

humanizer draws its list from Wikipedia's
[Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing),
maintained by
[WikiProject AI Cleanup](https://en.wikipedia.org/wiki/Wikipedia:WikiProject_AI_Cleanup).
Wikipedia text is licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), so the chain is
named here rather than left implicit at one remove.

What this repository takes from that page is the **set of phrases to watch for**,
reimplemented as deterministic checks. The page's prose — its explanations,
its before-and-after examples, its section text — is **not** reproduced here,
in `patterns.ts` or anywhere else. Every `label` and `fix` string in the rule
table is written for this codebase.

## claude-ads — a borrowed posture, not borrowed code

The rule that everything stays a draft until a gate passes is taken from
[claude-ads](https://github.com/AgriciDaniel/claude-ads) (MIT, Copyright (c)
2026 agricidaniel), as the README says. That is an idea about how to arrange a
system rather than any of its code or text, and no part of claude-ads is
reproduced here. It is named because it deserves the credit.

## Read, but not taken from

The original brief for this project named several repositories as references.
They were read; no code or text from them appears here, so no licence of theirs
is engaged:

[public-apis](https://github.com/public-apis/public-apis),
[Scrapling](https://github.com/D4Vinci/Scrapling),
[Agent-Reach](https://github.com/Panniantong/Agent-Reach),
[claude-video](https://github.com/bradautomates/claude-video),
[MoneyPrinterV2](https://github.com/FujiwaraChoki/MoneyPrinterV2),
[awesome-scalability](https://github.com/binhnguyennus/awesome-scalability),
[twenty](https://github.com/twentyhq/twenty).

## Platform APIs

The adapters in `src/platforms/` call the official APIs of Meta, TikTok,
Google, Pinterest, Snapchat, Reddit, LinkedIn and X. No vendor SDK is vendored
here; each adapter is written against the published HTTP interface. Use of
those APIs is governed by each platform's own terms, not by this licence.
