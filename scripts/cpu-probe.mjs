// v3: Defuddle full options vs lean options CPU comparison — whether we can lower CPU while keeping the engine, plus the change in output quality (tokens).
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import { minimize, countTokens } from '../lib/core.js';
import { performance } from 'node:perf_hooks';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const URLS = [
  'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)',
  'https://en.wikipedia.org/wiki/Large_language_model',
  'https://overreacted.io/a-complete-guide-to-useeffect/',
  'https://react.dev/learn/thinking-in-react',
  'https://www.paulgraham.com/wealth.html',
];

const FULL = { markdown: true, useAsync: false };
const LEAN = {
  markdown: true,
  useAsync: false,
  removeLowScoring: false,
  removeContentPatterns: false,
  standardize: false,
  removeHiddenElements: false,
  removeExactSelectors: false,
  removePartialSelectors: false,
  removeSmallImages: false,
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function timeIt(html, url, opt) {
  const s = [];
  let outTok = 0;
  for (let i = 0; i < 5; i++) {
    const a = performance.now();
    const { document } = parseHTML(html);
    const r = await Defuddle(document, url, opt);
    const out = minimize((r.contentMarkdown ?? r.content) || '');
    const b = performance.now();
    s.push(b - a);
    outTok = countTokens(out);
  }
  return { ms: +med(s).toFixed(1), outTok };
}

const rows = [];
for (const url of URLS) {
  let html;
  try {
    html = await (await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) })).text();
  } catch {
    rows.push({ url: url.slice(8, 40), htmlKB: 'ERR' });
    continue;
  }
  const htmlKB = Math.round(html.length / 1024);
  for (let w = 0; w < 2; w++) { const { document } = parseHTML(html); await Defuddle(document, url, FULL); }
  const full = await timeIt(html, url, FULL);
  const lean = await timeIt(html, url, LEAN);
  rows.push({
    url: url.replace(/^https?:\/\//, '').slice(0, 30),
    htmlKB,
    full_ms: full.ms,
    lean_ms: lean.ms,
    speedup: +(full.ms / lean.ms).toFixed(1) + 'x',
    full_tok: full.outTok,
    lean_tok: lean.outTok,
  });
}

console.table(rows);
console.log('\nspeedup = how many times faster the lean options are / full_tok vs lean_tok = quality (token) change. If lean inflates tokens significantly, the trade-off is bad.');
