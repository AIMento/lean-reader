// Empirical PoC — measure token ratios: raw HTML vs Defuddle vs Lean (minimize).
// First data point to validate the "25x token tax" narrative.
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import { getEncoding } from 'js-tiktoken';

const enc = getEncoding('o200k_base');
const tok = (s) => (s ? enc.encode(s).length : 0);

// token-minimize layer (= first version of the product's moat)
function minimize(md) {
  return (md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // remove image markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')      // keep link text only
    .replace(/^\s*\|.*\|\s*$/gm, (m) => m.replace(/\s{2,}/g, ' ')) // compress tables
    .replace(/[ \t]+\n/g, '\n')                   // trailing whitespace
    .replace(/\n{3,}/g, '\n\n')                   // collapse blank lines
    .replace(/[ \t]{2,}/g, ' ')                   // collapse spaces
    .trim();
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const URLS = [
  'https://en.wikipedia.org/wiki/Large_language_model',
  'https://www.paulgraham.com/wealth.html',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction',
  'https://react.dev/learn/thinking-in-react',
  'https://news.ycombinator.com/item?id=1',
];

const rows = [];
for (const url of URLS) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    const status = res.status;
    const html = await res.text();
    const { document } = parseHTML(html);
    const r = await Defuddle(document, url, { markdown: true });
    const md = r.contentMarkdown ?? r.content ?? '';
    const lean = minimize(md);
    const rawT = tok(html);
    const defT = tok(r.content ?? '');
    const leanT = tok(lean);
    rows.push({
      url: url.replace(/^https?:\/\//, '').slice(0, 46),
      status,
      words: r.wordCount ?? '-',
      rawT,
      defT,
      leanT,
      'raw/lean': leanT ? (rawT / leanT).toFixed(1) + 'x' : '-',
      'saved%': rawT ? Math.round((1 - leanT / rawT) * 100) + '%' : '-',
      ms: Date.now() - t0,
    });
  } catch (e) {
    rows.push({ url: url.replace(/^https?:\/\//, '').slice(0, 46), status: 'ERR', words: e.message.slice(0, 40) });
  }
}

console.table(rows);

// aggregate
const ok = rows.filter((r) => typeof r.rawT === 'number' && r.leanT);
if (ok.length) {
  const totalRaw = ok.reduce((s, r) => s + r.rawT, 0);
  const totalLean = ok.reduce((s, r) => s + r.leanT, 0);
  const ratios = ok.map((r) => r.rawT / r.leanT).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  console.log('\n=== Aggregate (static extraction succeeded ' + ok.length + '/' + rows.length + ') ===');
  console.log('Total raw tokens:', totalRaw.toLocaleString(), '→ lean tokens:', totalLean.toLocaleString());
  console.log('Weighted-average ratio:', (totalRaw / totalLean).toFixed(1) + 'x', '| Median ratio:', median.toFixed(1) + 'x');
  console.log('Ratio distribution:', ratios.map((r) => r.toFixed(1) + 'x').join(' · '));
}
