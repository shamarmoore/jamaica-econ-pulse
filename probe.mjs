const dims = encodeURIComponent(JSON.stringify({ 'weo-country': ['JAM', 'USA', 'CAN', 'GBR'], 'weo-subject': ['NGDP_RPCH', 'PCPIPCH', 'LUR', 'GGXWDG_NGDP', 'BCA_NGDPD', 'GGXCNL_NGDP'] }));
const u = `https://api.db.nomics.world/v22/series/IMF/WEO:latest?dimensions=${dims}&observations=1&limit=50`;
const r = await fetch(u, { headers: { 'User-Agent': 'okhttp/4.12.0' } }); console.log('status', r.status, r.url);
const j = await r.json();
console.log(Object.keys(j), j.series?.num_found, j.series?.docs?.length);
for (const d of j.series?.docs || []) console.log(d.series_code, JSON.stringify(d.dimensions), d.period?.slice(-3), d.value?.slice(-3));
