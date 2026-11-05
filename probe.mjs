const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': '*/*' } }); if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return r.text(); };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
async function step(n, f) { console.log(`\n===== ${n}`); try { await f(); } catch (e) { console.log('ERR', e.message); } }
for (const u of ['https://apps.nht.gov.jm/webaps/ptreaty.nsf/Anonymous_St.%20Thomas', 'https://apps.nht.gov.jm/webaps/ptreaty.nsf/Anonymous_St.%20Andrew', 'https://apps.nht.gov.jm/webaps/ptreaty.nsf/anonymous_allparishes']) {
  await step(u, async () => { const h = await get(u); console.log('len', h.length); console.log(strip(h).slice(0, 1800)); console.log('links', [...new Set(h.match(/href="[^"]+"/g) || [])].slice(0, 25)); });
}
await step('NHT detail', async () => { const h = await get('https://apps.nht.gov.jm/webaps/ptreaty.nsf/anonymous_allparishes/6B238D595E31F2CC05258CD000618EBF'); console.log(strip(h).slice(0, 1500)); });
await step('www.captureland district', async () => { const h = await get('https://www.captureland.org/parishes/st-thomas/districts/yallahs'); const t = strip(h); console.log('len', h.length, t.slice(t.indexOf('Sale') - 100, t.indexOf('Sale') + 800)); });
await step('xposure with u', async () => { const h = await get('https://raj.xposureapp.com/listing/2dca8?u=24140'); console.log('len', h.length, strip(h).slice(0, 500)); });
await step('VM private treaty', async () => { const h = await get('https://vmbuildingsociety.myvmgroup.com/?p=1834'); console.log('len', h.length, strip(h).slice(0, 1200)); console.log([...new Set(h.match(/href="[^"]*(treaty|propert|listing)[^"]*"/gi) || [])].slice(0, 15)); });
await step('homesgofast', async () => { const h = await get('https://homesgofast.com/country/Jamaica'); console.log('len', h.length, strip(h).slice(0, 600)); });
await step('JCO', async () => { for (const u of ['https://www.jamaicaclassifiedonline.com/real-estate', 'https://www.jamaicaclassifiedonline.com/']) { try { const h = await get(u); console.log(u, 'len', h.length, [...new Set(h.match(/href="[^"]*(real-estate|land|house)[^"]*"/gi) || [])].slice(0, 15)); } catch (e) { console.log(u, e.message); } } });
await step('caribbeanjobs analyst cards', async () => {
  const h = await get('https://www.caribbeanjobs.com/analyst-jobs');
  const i = h.indexOf('Business-Analyst-Job-240022'); console.log(h.slice(i - 1500, i + 2500).replace(/\s+/g, ' '));
  console.log('pagination', [...new Set(h.match(/href="[^"]*[Pp]age=\d+[^"]*"/g) || [])].slice(0, 6));
});
