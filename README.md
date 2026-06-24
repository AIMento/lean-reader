# Lean Reader

Turn any URL into **token-minimized clean text for LLMs**, with a token-savings receipt on every call. MCP server + library.

LLMs don't need your nav bar, your cookie banner, your `<script>` tags, or 200 KB of inlined SVG — but raw page HTML makes them pay for all of it. Lean Reader strips a page down to the article and tells you exactly how many tokens (and dollars) you just saved.

```
231,276 → 15,735 tokens (93% saved · 14.7× vs raw HTML · ~$0.54 on gpt-4o) · cleaned by lean reader
```

## Use as an MCP server

Add to your client's MCP config (Claude Desktop/Code, Cursor, …):

```json
{
  "mcpServers": {
    "lean-reader": { "command": "npx", "args": ["-y", "lean-reader"] }
  }
}
```

Then the `lean_read(url, format?)` tool returns clean text plus the receipt.

## Use as a library

```js
import { leanRead } from 'lean-reader/lib/core.js';

const r = await leanRead('https://example.com/article', { format: 'markdown' });
console.log(r.content);   // token-minimized text
console.log(r.receipt);   // { beforeTokens, afterTokens, savedPct, ratio, estCostSavedUsd, ... }
```

## How much does it save?

Measured, not marketed — the [open benchmark](https://github.com/AIMento/lean-reader-bench) ships the corpus, the tokenizer, and every raw output, and flags the cases where Lean Reader **loses**:

- **~29% fewer tokens than Mozilla Readability** (the standard extractor) at the median, while keeping ~99% of the body text. Be honest about where that edge comes from: it's the `minimize` post-pass (link/image/footnote/whitespace strip), not smarter extraction — run both through `minimize` and they're roughly par. Lean actually runs Readability as one of its two extractors (see Honest limits), so it doesn't lose to it.
- Versus **raw page HTML** the multiple is much larger (median ~8.7×, down to ~3.1× on already-clean blog prose, 100×+ on script-heavy docs) — but that's HTML nobody feeds an LLM, so read it as "don't dump raw pages," not as a competitive claim.
- Versus **Jina Reader** (measured, anonymous tier): ~1.6× fewer tokens on a like-for-like body, ~4.3× if you count the nav and reference dumps Jina also returns. Firecrawl is not yet measured (needs an API key).

The receipt uses the `o200k_base` tokenizer (GPT-4o/4.1 class); the model and tokenizer are always shown, and counts are vs the raw page HTML so you can check the math.

## Honest limits

- **Static HTML only (v1).** Pages whose body is client-rendered (some SPAs, GitHub repo landing pages) return little — Lean Reader flags `partial` instead of emitting empty text. Jina/Firecrawl render JS and will beat us there.
- **Two extractors, body-max selection.** Defuddle and Mozilla Readability each silently drop the body on *different* pages (Defuddle on some large Wikipedia articles, Readability on some docs/SPAs). Lean runs both and keeps whichever recovers more body, so neither's blind spot becomes a silent content drop. A ROUGE-L ground-truth pass on a 14-page hand-labeled sample is done: reference-body recall 0.99, equal to Readability on the same ground truth, so the word-count gap is noise removal, not body loss (see the bench repo).
- Token counts are `o200k_base`; Claude/Gemini tokenize differently.

## Open-core

The extraction + token-minimization core (`lib/`) and the MCP server (`src/`) are MIT. Hosted service, sharing UI, and metering are separate.

MIT © 2026
