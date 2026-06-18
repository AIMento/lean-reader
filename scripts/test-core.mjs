// Core smoke test — verify that leanRead returns content + receipt correctly.
import { leanRead } from '../lib/core.js';

const urls = [
  'https://react.dev/learn/thinking-in-react',
  'https://en.wikipedia.org/wiki/Large_language_model',
  'https://news.ycombinator.com/item?id=1',
];

for (const url of urls) {
  try {
    const r = await leanRead(url, { format: 'markdown', model: 'gpt-4o' });
    console.log('\n===', r.title, '| words:', r.wordCount, '| partial:', r.partial, '===');
    console.log('receipt:', JSON.stringify(r.receipt));
    console.log('content[0:200]:', JSON.stringify(r.content.slice(0, 200)));
  } catch (e) {
    console.log('\n===', url, '=== ERROR:', e.message);
  }
}
