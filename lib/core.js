// Lean Reader core — single source of truth shared by the MCP server and the Vercel API routes (open-core, MIT).
// Pipeline: SSRF-safe fetch (size-capped) → linkedom → [Defuddle ‖ Readability] pick-the-fuller-body → minimize → token receipt.
// Dual extraction: Defuddle sometimes drops entire body sections on certain pages (large wiki articles), while Readability
// drops content on other pages (some SPAs/docs). We run both and keep whichever yields more body text, guaranteeing fidelity
// (honesty: never silently return a worse extraction).
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { getEncoding } from 'js-tiktoken';
import { Agent } from 'undici';
import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

const enc = getEncoding('o200k_base');

// Errors follow a message=code convention (web/MCP map the message to a user-facing message).
const codeErr = (code) => new Error(code);

// Honest bot UA. No Chrome spoofing (honesty) — the "compatible;" form is the convention for legitimate bots, and it
// includes a contact URL.
const UA = 'Mozilla/5.0 (compatible; LeanReaderBot/0.1; +https://github.com/AIMento/lean-reader)';

const MAX_BYTES = 3_000_000; // Hard cap on response body (after decompression) — decompression-bomb defense
const TOKENIZE_MAX = 400_000; // Upper bound (chars) on input we'll exact-encode

// ---- Token counting (DoS guard) -------------------------------------------------
// js-tiktoken BPE is O(n^2) on low-entropy/repetitive input (10KB of 'A' ≈ 16s, attacker-controllable).
// Regardless of entropy, only exact-encode inputs known to be safe; fall back to a chars/4 estimate for
// pathological/oversized input. Real article text always takes the exact path.
const estimateTokens = (s) => Math.ceil(s.length / 4);

function isPathological(s) {
  if (/(.)\1{300,}/.test(s)) return true; // 300+ runs of the same character
  const head = s.slice(0, 4000);
  if (head.length > 200 && new Set(head).size < 12) return true; // extremely low character diversity
  return false;
}

/** o200k_base token count. The receipt always exposes tokenizer + model together (honesty). Adversarial input falls back to an estimate. */
export function countTokens(s) {
  if (!s) return 0;
  if (s.length > TOKENIZE_MAX || isPathological(s)) return estimateTokens(s);
  try {
    return enc.encode(s).length;
  } catch {
    return estimateTokens(s);
  }
}

// Input price in $/1M tokens. The receipt names the reference model to prevent inflated claims.
export const PRICING = {
  'gpt-4o': 2.5,
  'gpt-4o-mini': 0.15,
  'claude-sonnet': 3.0,
  'claude-haiku': 0.8,
};

// ---- SSRF defense: resolve → validate every IP → pin to the validated IP (undici connect.lookup) ----------
// A string-based blocklist (the old approach) was vulnerable to 172.16/12, IPv6 ULA, decimal/hex IPs, DNS rebinding,
// and redirect bypasses. The undici dispatcher's connect.lookup fires on every connection (including redirects) →
// it validates every hop and pins the connection to the validated IP (blocking rebinding). SNI keeps the original
// hostname → TLS stays valid.
function ipIsPublic(ipStr) {
  let addr;
  try {
    addr = ipaddr.parse(ipStr);
  } catch {
    return false;
  }
  if (addr.kind() === 'ipv6') {
    if (addr.isIPv4MappedAddress()) return ipIsPublic(addr.toIPv4Address().toString());
    return addr.range() === 'unicast'; // excludes ULA/loopback/linkLocal/reserved/multicast
  }
  return addr.range() === 'unicast'; // excludes private/loopback/linkLocal/CGNAT/reserved/broadcast
}

// IP-literal normalization (undici skips lookup for strict IP literals and connects directly, so we validate
// them ourselves up front).
// Reduce strict v4/v6 + decimal 32-bit (http://2130706433) + hex (http://0x7f000001) to dotted-quad IPv4.
// Shorthand/octal forms (e.g. 127.1) yield net.isIP=0 and are treated as hostnames → the dispatcher lookup resolves
// and validates them.
function literalIp(host) {
  if (!host) return null;
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // IPv6 bracket
  if (net.isIP(h)) return h;
  if (/^[0-9]+$/.test(h)) {
    const n = Number(h);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff)
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  if (/^0x[0-9a-f]+$/i.test(h)) {
    const n = parseInt(h, 16);
    if (n >= 0 && n <= 0xffffffff)
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return null;
}

function safeLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : options || {};
  const cb = typeof options === 'function' ? options : callback;
  dns.lookup(hostname, { all: true, family: opts.family || 0 }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: opts.family || 4 }];
    for (const a of list) {
      if (!ipIsPublic(a.address)) return cb(codeErr('blocked_host'));
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

const safeAgent = new Agent({ connect: { lookup: safeLookup } });

// Follow redirects manually so every hop is validated. (Automatic following would let a redirect → IP-literal hop
// bypass both Layer 1 [which only checks the initial URL] and the dispatcher lookup [which skips IP literals], so we
// walk the chain ourselves.)
async function fetchSafe(startUrl, { fetchImpl, timeoutMs }) {
  let current = startUrl;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw codeErr('unsupported_protocol');
    const lit = literalIp(u.hostname);
    if (lit && !ipIsPublic(lit)) throw codeErr('blocked_host');

    let res;
    try {
      res = await fetchImpl(current, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: safeAgent,
      });
    } catch (e) {
      const msg = ((e && e.cause && e.cause.message) || (e && e.message) || '') + '';
      if (/blocked_host/.test(msg)) throw codeErr('blocked_host');
      if ((e && e.name === 'TimeoutError') || /timed?\s?out|timeout|aborted/i.test(msg)) throw codeErr('timeout');
      throw codeErr('fetch_failed');
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      if (res.body && res.body.cancel) {
        try {
          await res.body.cancel();
        } catch {}
      }
      continue;
    }
    return res;
  }
  throw codeErr('too_many_redirects');
}

/** Read the body capped by post-decompression byte count (streaming — memory-bomb defense). */
async function readCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return await res.text();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {}
      throw codeErr('response_too_large');
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** token-minimize layer. Further compresses Defuddle output while preserving code blocks and table information. */
export function minimize(md) {
  let s = md || '';

  // 1) Preserve fenced code blocks (never touch their internal whitespace/indentation)
  const fences = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return 'F' + (fences.length - 1) + '';
  });

  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // strip image markdown
    .replace(/\[\s*\]\([^)]*\)/g, '') // strip empty-text links (e.g. wiki thumbnails Readability leaves behind, [](…/File:…) — zero information, pure noise)
    .replace(/\[([^\]]+)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '$1') // keep only the link's display text
    .replace(/[ \t]*\[edit\]/gi, '') // wiki section-edit link markers (trail every heading on the Readability path)
    .replace(/^\[\^[^\]]+\]:.*$/gm, '') // strip footnote-definition lines (Wikipedia citation dumps = pure LLM noise)
    .replace(/\[\^[^\]]+\]/g, '') // strip inline footnote markers
    .replace(/[ \t]+\n/g, '\n') // strip trailing whitespace
    .replace(/\n{3,}/g, '\n\n'); // collapse runs of blank lines
  // Note: a former global `[ \t]{2,}→' '` collapse mangled code/tables/nested lists, so it was removed.

  // 2) Restore fences
  s = s.replace(/F(\d+)/g, (_, i) => fences[+i]);
  return s.trim();
}

/** markdown → plain text (rough symbol stripping). Used when format='text'. */
const turndown = new TurndownService({ codeBlockStyle: 'fenced', headingStyle: 'atx', bulletListMarker: '-' });
// HTML→markdown for the Readability fallback (Defuddle emits its own markdown; Readability emits article.content HTML).
function htmlToMarkdown(html) {
  try {
    return turndown.turndown(html || '');
  } catch {
    return '';
  }
}
// Word count for comparing body volume (the extractor-selection criterion).
const wordsOf = (s) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

function toPlainText(md) {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Fetch a URL and extract the body with Defuddle. SSRF-safe, size-capped, content-type validated. */
export async function extract(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw codeErr('invalid_url');
  }
  if (!/^https?:$/.test(u.protocol)) throw codeErr('unsupported_protocol');

  const res = await fetchSafe(url, { fetchImpl, timeoutMs });
  if (!res.ok) throw codeErr('fetch_' + res.status);

  const ctype = res.headers.get('content-type') || '';
  if (ctype && !/text\/html|application\/xhtml|text\/plain|\+xml/i.test(ctype)) {
    throw codeErr('unsupported_content_type');
  }

  const html = await readCapped(res);

  let document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    throw codeErr('parse_failed');
  }
  if (!document || !document.documentElement) throw codeErr('empty_or_non_html');

  // Readability mutates the document destructively → capture a clone before running Defuddle.
  let readabilityDoc = null;
  try {
    readabilityDoc = document.cloneNode(true);
  } catch {
    readabilityDoc = null; // if cloning fails, use Defuddle only with no fallback
  }

  let defuddle;
  try {
    defuddle = await Defuddle(document, url, { markdown: true });
  } catch {
    throw codeErr('extract_failed');
  }
  const defuddleMd = defuddle.contentMarkdown ?? defuddle.content ?? '';

  // Second extractor — defends against pages where Defuddle drops entire body sections (some large wiki articles).
  // Reuses the same linkedom document (no jsdom needed). leanRead picks whichever yields more body text.
  let readabilityMd = '';
  if (readabilityDoc) {
    try {
      const art = new Readability(readabilityDoc).parse();
      if (art && art.content) readabilityMd = htmlToMarkdown(art.content);
    } catch {
      readabilityMd = ''; // ignore fallback failure — use the Defuddle result
    }
  }

  return { html, defuddle, defuddleMd, readabilityMd };
}

/**
 * The full pipeline. A single entry point shared by the MCP tool, the HTTP API, and the CLI.
 * @returns {{ url, title, wordCount, content, receipt, partial, extractor }}
 */
export async function leanRead(url, { format = 'markdown', model = 'gpt-4o', includeFooter = false } = {}) {
  const { html, defuddle, defuddleMd, readabilityMd } = await extract(url);

  // Body-fidelity-first selection: minimize both Defuddle and Readability outputs, then keep whichever has more body
  // text (word count). On a tie, keep Defuddle (slightly more token-efficient). Switch only when Readability has 15%+
  // more body. (The two drop body content on different pages — Defuddle: some large wikis / Readability: some SPAs/docs.)
  const defuddleMin = minimize(defuddleMd);
  const readabilityMin = readabilityMd ? minimize(readabilityMd) : '';
  const useReadability = wordsOf(readabilityMin) > wordsOf(defuddleMin) * 1.15;
  const extractor = useReadability ? 'readability' : 'defuddle';
  const md = useReadability ? readabilityMd : defuddleMd; // raw markdown used for the integrity-guard check
  let content = useReadability ? readabilityMin : defuddleMin;

  // Integrity guard: if the selected output is dominated by footnote definitions (citations), treat it as a failed
  // body extraction (honesty: never pretend success).
  const footnoteLines = (md.match(/^\[\^[^\]]+\]:.*$/gm) || []).length;
  const footnoteChars = (md.match(/^\[\^[^\]]+\]:.*$/gm) || []).join('\n').length;
  const citationHeavy = md.length > 0 && footnoteChars / md.length > 0.5 && footnoteLines > 20;

  if (format === 'text') content = toPlainText(content);

  // Static-extraction failure (likely an SPA) or a citation-dump page — flag it honestly instead of padding empty
  // text with a guess (honesty: surface partial results rather than fake completeness).
  const partial = content.length < 200 || citationHeavy;

  if (includeFooter) content += `\n\n---\ncleaned by lean reader — lean.tld/${url}`;

  const beforeTokens = countTokens(html);
  const afterTokens = countTokens(content);
  const savedTokens = Math.max(0, beforeTokens - afterTokens);
  // An unsupported model name is priced at the gpt-4o rate, so the receipt's model reflects the actual billed model
  // (honesty: avoid a label/price mismatch).
  const pricedModel = PRICING[model] ? model : 'gpt-4o';
  const price = PRICING[pricedModel];

  const receipt = {
    tokenizer: 'o200k_base',
    model: pricedModel,
    beforeTokens,
    afterTokens,
    savedTokens,
    savedPct: beforeTokens ? Math.round((savedTokens / beforeTokens) * 100) : 0,
    ratio: afterTokens ? Number((beforeTokens / afterTokens).toFixed(1)) : null,
    estCostSavedUsd: Number(((savedTokens / 1e6) * price).toFixed(4)),
  };

  // wordCount is based on the actually-returned content (Defuddle's pre-strip count overstates it by including
  // citations and the like — honesty: keep the reported count consistent with what's returned).
  const wordCount = content ? content.trim().split(/\s+/).filter(Boolean).length : 0;

  return {
    url,
    title: defuddle.title || '',
    wordCount,
    content,
    receipt,
    partial,
    extractor,
  };
}
