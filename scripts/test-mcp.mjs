// MCP server local verification — a test client spawns the server and runs tools/list + tools/call.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'src', 'server.js');

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
const client = new Client({ name: 'lean-reader-test', version: '1.0.0' });

await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => `${t.name} — ${t.description.slice(0, 50)}…`));

const res = await client.callTool({
  name: 'lean_read',
  arguments: { url: 'https://news.ycombinator.com/item?id=1', format: 'markdown' },
});
console.log('\n--- lean_read result (first 500 chars) ---');
console.log(res.content[0].text.slice(0, 500));

await client.close();
console.log('\n[ok] MCP stdio round-trip succeeded');
