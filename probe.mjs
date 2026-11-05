const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u, h = {}) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': '*/*', ...h } }); if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return r.text(); };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
async function step(n, f) { console.log(`\n===== ${n}`); try { await f(); } catch (e) { console.log('ERR', e.message); } }
await step('xposure home', async () => {
  const h = await get('https://raj.xposureapp.com/');
  console.log(strip(h).slice(0, 600));
  console.log('scripts', (h.match(/src="[^"]+\.js[^"]*"/g) || []).slice(0, 10));
  console.log('api-ish', [...new Set((h.match(/["'](\/[a-z0-9_\-\/]*(?:api|search|listing)[a-z0-9_\-\/]*)["']/gi) || []))].slice(0, 20));
  console.log('forms', (h.match(/<form[^>]*>/g) || []).slice(0, 5));
});
await step('xposure listing', async () => {
  const h = await get('https://raj.xposureapp.com/listing/2dca8');
  console.log('len', h.length, 'jsonld', /application\/ld\+json/.test(h));
  const ld = h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/); if (ld) console.log(ld[1].slice(0, 800));
  console.log('links', [...new Set((h.match(/href="[^"]*(search|listings|area|map)[^"]*"/gi) || []))].slice(0, 20));
});
for (const u of ['https://raj.xposureapp.com/search', 'https://raj.xposureapp.com/listings', 'https://raj.xposureapp.com/search?area=St.%20Thomas', 'https://raj.xposureapp.com/api/listings']) {
  await step(u, async () => { const h = await get(u); console.log('len', h.length, strip(h).slice(0, 400)); console.log((h.match(/\/listing\/[a-z0-9]+/g) || []).slice(0, 10)); });
}
for (const u of ['https://captureland.org/parishes/st-thomas/districts/yallahs', 'https://captureland.org/parishes/st-andrew/districts/bull-bay-seven-mile', 'https://captureland.org/parishes/st-thomas']) {
  await step(u, async () => { const h = await get(u); const t = strip(h); const i = t.indexOf('For Sale'); console.log('len', h.length, '|', t.slice(Math.max(0, i - 200), i + 900)); console.log('links', [...new Set((h.match(/href="[^"]*(listing|propert|district)[^"]*"/gi) || []))].slice(0, 15)); });
}
for (const u of ['https://www.caribbeanjobs.com/ShowResults.aspx?Keywords=analyst&autosuggestEndpoint=%2fautosuggest&Location=124&Category=&Recruiter=Company&Recruiter=Agency&btnSubmit=+', 'https://www.caribbeanjobs.com/Jamaica?Keywords=analyst', 'https://www.caribbeanjobs.com/analyst-jobs', 'https://www.caribbeanjobs.com/Jamaica/analyst-Jobs']) {
  await step(u, async () => { const h = await get(u); const ids = h.match(/[A-Za-z0-9\-]+-Job-\d+\.aspx/g) || []; console.log('len', h.length, 'jobs', ids.length, [...new Set(ids)].slice(0, 12)); const t = strip(h); const i = t.search(/Analyst/); console.log(t.slice(Math.max(0, i - 300), i + 600)); });
}
await step('nominatim+osrm', async () => {
  const geo = async (q) => { const j = JSON.parse(await get('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jm&q=' + encodeURIComponent(q), { 'User-Agent': 'JAEconPulse/1.3 (personal app)' })); return j[0] ? [+j[0].lat, +j[0].lon, j[0].display_name] : null; };
  const work = await geo('Half Way Tree Road, Kingston, Jamaica'); console.log('work', work);
  for (const q of ['Bull Bay, Saint Andrew, Jamaica', 'Yallahs, Saint Thomas, Jamaica', 'Albion, Saint Thomas, Jamaica', 'Morant Bay, Jamaica', 'Portmore, Jamaica', 'Harbour View, Kingston, Jamaica']) {
    await new Promise((r) => setTimeout(r, 1100));
    const g = await geo(q); if (!g || !work) { console.log(q, 'no geo'); continue; }
    const j = JSON.parse(await get(`https://router.project-osrm.org/route/v1/driving/${work[1]},${work[0]};${g[1]},${g[0]}?overview=false`));
    console.log(q, g.slice(0, 2), 'km', (j.routes[0].distance / 1000).toFixed(1), 'min', (j.routes[0].duration / 60).toFixed(0));
  }
});
