// Car listings: recently posted right-hand-drive Honda Civics and Toyota GT86s (AutoAdsJa, Gleaner Classifieds).
import { getText, htmlToText, decodeEntities } from './util.js';

export const MODELS = [
  { key: 'civic', label: 'Honda Civic', re: /\bhonda\s+civic\b|\bcivic\b/i, autoads: { make: 20, model: 'Civic' } },
  { key: 'gt86', label: 'Toyota GT86', re: /\b(?:toyota\s+)?(?:gt|ft)\s?-?86\b|\btoyota\s+86\b/i, autoads: { make: 53, model: '86' } },
];
const MULTI = /\b(hrv|hr-v|vezel|odyssey|spada|voxy|noah|stepwagon|step wagon|crv|cr-v|rav4|chr|c-hr|fit|accord|axio|fielder|biante|isis|premio|allion)\b/gi;
const isParts = (t) => (String(t).match(MULTI) || []).length >= 2 || /\bparts?\b|\bengine\b|\bwrecking\b|\bbody kit\b/i.test(t);
const LHD = /\b(left[\s-]*hand[\s-]*drive|lhd|left[\s-]*hand)\b/i;
const price = (t) => {
  const m = /J?\$\s?([\d,]+(?:\.\d+)?)\s*(M|mil|million|K)?/i.exec(String(t).replace(/\s+/g, ' '));
  if (!m) return null; let v = parseFloat(m[1].replace(/,/g, '')); const u = (m[2] || '').toLowerCase();
  if (u.startsWith('m')) v *= 1e6; else if (u === 'k') v *= 1e3;
  return v >= 200000 && v < 60000000 ? Math.round(v) : null;
};
const year = (t) => { const m = /\b(19[89]\d|20[0-3]\d)\b/.exec(t); return m ? +m[1] : null; };

async function autoAdsJa(model) {
  const out = [];
  let url = `https://www.autoadsja.com/search.asp?SearchVehicleMake=${model.autoads.make}&SearchVehicleModel=${encodeURIComponent(model.autoads.model)}`;
  for (let page = 0; page < 3 && url; page++) {
    const h = await getText(url);
    let rank = out.length;
    for (const m of h.matchAll(/<a href="(https:\/\/www\.autoadsja\.com\/[A-Z0-9]{3,6})" title="([^"]+)">[\s\S]{0,1600}?<span class="visible-xs">\s*([^<]+)<\/span>/g)) {
      const title = decodeEntities(m[2]);
      if (!model.re.test(title) || isParts(title)) continue;
      const [what, where = ''] = title.split(/\s+for sale in\s+/i);
      out.push({ src: 'AutoAdsJa', id: `aa:${m[1].slice(-6)}`, url: m[1], title: what.trim(), where: where.replace(/,\s*Jamaica$/i, ''), price: price(m[3]), year: year(what), rank: rank++, lhd: LHD.test(title), date: null });
    }
    const next = /<a[^>]+href="([^"]*search\.asp[^"]*)"[^>]*>\s*(?:Next|&raquo;|»)/i.exec(h);
    url = next ? new URL(decodeEntities(next[1]), 'https://www.autoadsja.com/').href : null;
  }
  return out;
}

async function gleanerCars() {
  const out = [];
  const h = await getText('https://www.gleanerclassifieds.com/marketplace/category/400-transport/462-sale-motor-cars');
  for (const b of h.split('<div id="advert_').slice(1)) {
    const link = /<h4><a href="([^"]+)">([\s\S]*?)<\/a>/.exec(b); if (!link) continue;
    const title = htmlToText(link[2]); const desc = htmlToText((/class="description[^"]*">([\s\S]*?)<\/span>/.exec(b) || [])[1] || '');
    const text = `${title} ${desc}`;
    const model = MODELS.find((m) => m.re.test(text)); if (!model || isParts(text)) continue;
    const date = (/datetime="([^"]+)"/.exec(b) || [])[1];
    out.push({ src: 'Gleaner Classifieds', id: `gc:${(/_(\d+)$/.exec(link[1]) || [])[1] || link[1]}`, url: link[1], title: title || desc.slice(0, 70) || `${model.label} for sale`, desc, model: model.key, where: '',
      price: price(htmlToText((/sr_ad_price">([\s\S]*?)<\/span>/.exec(b) || [])[1] || '')) ?? price(text), year: year(text), lhd: LHD.test(text), date: date ? date.slice(0, 10) : null });
  }
  return out;
}

export async function carListings() {
  const jobs = [...MODELS.map((m) => autoAdsJa(m).then((r) => r.map((x) => ({ ...x, model: m.key })))), gleanerCars()];
  const res = await Promise.allSettled(jobs);
  const items = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = res.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  if (!items.length && errors.length) throw new Error(errors.join('; '));
  const seen = new Set();
  return { items: items.filter((x) => (seen.has(x.id) ? false : seen.add(x.id))), errors, fetched: new Date().toISOString() };
}

export const jacarsLinks = [
  ['Honda Civic on JaCars', 'https://www.jacars.net/cars/honda/civic/'],
  ['Toyota 86 on JaCars', 'https://www.jacars.net/cars/toyota/86/'],
];
