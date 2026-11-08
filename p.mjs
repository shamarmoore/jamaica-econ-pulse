const H = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' };
const T = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
for (const id of [13, 1600148]) {
  const h = await (await fetch(`https://www.jamstockex.com/trading/instruments/?instrument=${id}`, { headers: H })).text();
  const tabs = h.split(/<table/i).slice(1);
  console.log('### INSTR', id, 'tables', tabs.length);
  const i0 = h.indexOf('Instrument Summary'); console.log('HEAD:', T(h.slice(i0, h.indexOf('<table', i0) > 0 ? h.indexOf('<table', i0) : i0 + 8000)).slice(0, 1500));
  tabs.forEach((tb, k) => {
    const pre = T(h.slice(Math.max(0, h.indexOf(tb) - 600), h.indexOf(tb))).slice(-120);
    console.log(`--- table ${k} (after: ${pre})`);
    for (const tr of (tb.match(/<tr[\s\S]*?<\/tr>/gi) || []).slice(0, 12)) console.log('  ', (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(T).join(' | '));
  });
}
