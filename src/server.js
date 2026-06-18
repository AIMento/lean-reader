#!/usr/bin/env node
// Lean Reader MCP server (stdio). Shares the core (lib/core.js) with the Vercel API.
// Run: npx lean-reader  /  client mcp.json: { "command": "npx", "args": ["-y", "lean-reader"] }
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { leanRead } from '../lib/core.js';

const server = new McpServer({ name: 'lean-reader', version: '0.1.0' });

server.registerTool(
  'lean_read',
  {
    title: 'Lean Reader',
    description:
      'Fetch a URL and return token-minimized clean text plus a token-savings receipt. Strips nav/scripts/boilerplate so an LLM reads the article, not the page. The receipt counts tokens vs the raw page HTML (typically ~15x fewer, but it ranges from ~1.5x on already-clean pages to 100x+ on script-heavy docs). Two extractors (Defuddle + Readability), body-max selection, so it does not silently drop the article body. Static HTML only — JS-rendered pages may come back partial.',
    inputSchema: {
      url: z.string().url().describe('The URL to fetch and clean'),
      format: z.enum(['markdown', 'text']).optional().describe('Output format (default: markdown)'),
    },
  },
  async ({ url, format }) => {
    try {
      const r = await leanRead(url, { format: format ?? 'markdown' });
      const c = r.receipt;
      const receiptLine =
        `> ${c.beforeTokens.toLocaleString()} → ${c.afterTokens.toLocaleString()} tokens ` +
        `(${c.savedPct}% saved · ${c.ratio}x · ~$${c.estCostSavedUsd} on ${c.model}, ${c.tokenizer}) · cleaned by lean reader`;
      const header = (r.title ? `# ${r.title}\n\n` : '') + receiptLine + '\n\n';
      const note = r.partial
        ? '[lean reader] This page looks JS-rendered; static extraction returned little. v1 supports static HTML only.\n\n'
        : '';
      return { content: [{ type: 'text', text: header + note + r.content }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `lean_read error: ${e.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
