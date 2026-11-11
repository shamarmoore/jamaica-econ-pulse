import fs from 'node:fs';
import { research } from './www/js/research.js';
const t = Date.now(); const r = await research();
fs.writeFileSync('data/research.json', JSON.stringify(r));
console.log('TOOK', Date.now() - t, 'ms; errors', r.errors);
for (const [k, l] of Object.entries(r.topics)) { console.log('TOPIC', k, l.length); for (const p of l.slice(0, 14)) console.log('  ', p.date, '|', p.src, '|', p.cites ?? '-', '|', p.title.slice(0, 100), '|', p.venue.slice(0, 40)); }
