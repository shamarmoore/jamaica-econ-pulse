// Runs every scraper exactly as the phone would and prints what it parsed.
// Used by CI on each build (and weekly) so a broken source shows up as a red line in GitHub.
import { writeFileSync, appendFileSync } from 'node:fs';
import { SOURCES } from '../www/js/sources.js';
import { analyse } from '../www/js/analysis.js';

const cache = {}; const rows = [];
for (const s of SOURCES) {
  const t0 = Date.now();
  try {
    const data = await s.fn();
    cache[s.id] = { data, at: Date.now() };
    const brief = JSON.stringify(data).slice(0, 300);
    rows.push([s.name, 'OK', `${Date.now() - t0} ms`, brief]);
    console.log(`✔ ${s.name}: ${brief}\n`);
  } catch (e) {
    rows.push([s.name, 'FAIL', `${Date.now() - t0} ms`, String(e.message || e)]);
    console.log(`✘ ${s.name}: ${e.stack || e}\n`);
  }
}
const d = Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, v.data]));
const a = analyse(d);
console.log('HEADLINE:', a.headline);
console.log('GAUGES:', JSON.stringify(a.gauges));
for (const i of a.insights) console.log(`[${i.level}/${i.severity}] ${i.title} — ${i.signal}`);
writeFileSync('smoke-cache.json', JSON.stringify(cache));

const ok = rows.filter((r) => r[1] === 'OK').length;
const md = [`### Source check: ${ok}/${rows.length} sources OK`, '', '| Source | Status | Time | Detail |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '/').slice(0, 220)).join(' | ')} |`), '',
  `**Headline:** ${a.headline}`, '', ...a.insights.map((i) => `- **${i.title}** (${i.level}) — ${i.signal}`)].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
