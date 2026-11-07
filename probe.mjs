const u = 'https://api.imf.org/external/sdmx/2.1/data/IMF.RES,WEO/JAM+USA+CAN+GBR.NGDP_RPCH+PCPIPCH+LUR+GGXWDG_NGDP+BCA_NGDPD+GGXCNL_NGDP.A?startPeriod=2015';
let r = await fetch(u); let t = await r.text(); console.log(r.status, r.headers.get('content-type'), t.length);
console.log(t.slice(0, 1500).replace(/></g, '>\n<'));
const series = [...t.matchAll(/<Series [^>]*>/g)].map((m) => m[0]); console.log('series', series.length); console.log(series.slice(0, 3).join('\n'));
r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json;version=1.0.0' } }); t = await r.text(); console.log('JSON?', r.status, r.headers.get('content-type'), t.slice(0, 300));
