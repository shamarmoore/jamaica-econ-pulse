// Runs every scraper exactly as the phone would and prints what it parsed.
// Used by CI on each build (and weekly) so a broken source shows up as a red line in GitHub.
import { writeFileSync, appendFileSync } from 'node:fs';
import { SOURCES } from '../www/js/sources.js';
import { analyse, borrowing } from '../www/js/analysis.js';
import { decide } from '../www/js/decisions.js';

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
// Listings, commute times and jobs
if (d.listings) {
  const { geocode, driveTimes, bestScenario, FIN_DEFAULTS } = await import('../www/js/homes.js');
  const it = d.listings.items;
  const by = (k) => it.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {});
  console.log('LISTINGS', it.length, JSON.stringify(by('src')), JSON.stringify(by('type')), 'preferred', it.filter((x) => x.preferred).length, 'errors', d.listings.errors);
  console.log('PRECISION', JSON.stringify(it.reduce((m, x) => ((m[x.loc.precision] = (m[x.loc.precision] || 0) + 1), m), {})));
  const work = await geocode('Half Way Tree Road, Kingston, Jamaica');
  const qs = [...new Set(it.filter((x) => x.loc.query).map((x) => x.loc.query))].slice(0, 10);
  const pts = [];
  for (const q of qs) { await new Promise((r) => setTimeout(r, 1100)); try { const g = await geocode(q); if (g) pts.push([q, g]); } catch (e) { console.log('GEO ERR', q, e.message); } }
  const dt = work && pts.length ? await driveTimes(work, pts.map((p) => p[1])) : [];
  pts.forEach((p, i) => console.log('DRIVE', p[0], '→', dt[i]?.min?.toFixed(0), 'min', dt[i]?.km?.toFixed(1), 'km'));
  const f = { ...FIN_DEFAULTS, myIncome: 350000, savings: 3000000, coOn: true, coIncome: 250000 };
  it.filter((x) => x.price).slice(0, 12).forEach((x) => { const b = bestScenario(x.price, f, { land: x.type === 'land', bankRateLive: 7.6 }); console.log('LIST', x.src, '|', x.type, '|', x.title.slice(0, 50), '|', x.where || x.loc.place, '| J$', x.price, '|', b.mode, b.verdict, Math.round(b.monthly), 'cash', Math.round(b.cash), x.preferred ? '★' : ''); });
}
if (d.jobs) { const j = d.jobs.jobs; console.log('JOBS', j.length, 'Jamaica', j.filter((x) => /jamaica/i.test(x.country)).length); j.slice(0, 8).forEach((x) => console.log('JOB', x.title, '|', x.company, '|', x.country, x.location, '|', x.updated, '|', x.salary)); }
const bo = borrowing(d);
console.log('BORROWING:', bo.label, bo.score, '|', bo.reasons.map((r) => r.txt).join(' / '));
console.log('CAR:', bo.carLabel, JSON.stringify(bo.car));
const dx = decide(d);
for (const k of ['spend', 'borrow', 'home', 'invest', 'work']) console.log(`DECIDE ${k}: ${dx[k].label}`);
console.log('MIX balanced:', JSON.stringify(dx.invest.mixes.balanced));
writeFileSync('smoke-cache.json', JSON.stringify(cache));

const ok = rows.filter((r) => r[1] === 'OK').length;
const md = [`### Source check: ${ok}/${rows.length} sources OK`, '', '| Source | Status | Time | Detail |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '/').slice(0, 220)).join(' | ')} |`), '',
  `**Headline:** ${a.headline}`, '', `**Loan rates outlook:** ${bo.label}`, '', ...['spend', 'home', 'invest', 'work'].map((k) => `- ${dx[k].title}: **${dx[k].label}**`), '', ...a.insights.map((i) => `- **${i.title}** (${i.level}) — ${i.signal}`)].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
