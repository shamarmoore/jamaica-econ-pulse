import fs from 'node:fs'; import { execSync } from 'node:child_process';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = await fetch('https://www.jamstockex.com/wp-json/wp/v2/posts?categories=8&per_page=40&_fields=id,date,title,content', { headers: { 'user-agent': UA } });
const posts = await r.json(); let n = 0;
for (const p of posts) {
  const links = [...p.content.rendered.matchAll(/href="([^"]+\.pdf)"/gi)].map((m) => m[1]);
  if (!links.length) { console.log('## NOPDF', p.title.rendered.slice(0, 70)); continue; }
  if (n >= 22) break; n++;
  await sleep(2500);
  try {
    const f = await fetch(links[0], { headers: { 'user-agent': UA } }); const b = Buffer.from(await f.arrayBuffer());
    fs.writeFileSync('x.pdf', b);
    const pages = +execSync('pdfinfo x.pdf 2>/dev/null | grep Pages | awk \'{print $2}\'').toString().trim();
    const txt = execSync('pdftotext -layout x.pdf - 2>/dev/null', { maxBuffer: 5e7 }).toString();
    const has = (re) => (re.test(txt) ? 1 : 0);
    const eq = txt.match(/total (?:stockholders|shareholders)?['’]? ?equity[^\n]{0,80}/i)?.[0]?.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`## ${f.status} pages ${pages} kb ${Math.round(b.length / 1024)} chars ${txt.length} links ${links.length} | SFP ${has(/financial position|balance sheet/i)} equity ${has(/total (?:stockholders|shareholders)?['’]? ?equity/i)} assets ${has(/total assets/i)} cashops ${has(/operating activities/i)} | ${p.title.rendered.slice(0, 50)} | ${eq || ''}`);
  } catch (e) { console.log('## ERR', String(e.message).slice(0, 80), p.title.rendered.slice(0, 50)); }
}
