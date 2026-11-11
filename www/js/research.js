// Research papers on AI forecasting, logistics management and sales innovation.
// arXiv (preprints, newest first) + OpenAlex (journal articles, ~250M works, free; no key needed for a few searches a day).
import { getText, getJSON, htmlToText } from './util.js';

export const RESEARCH_TOPICS = {
  airesearch: {
    label: 'AI research',
    // general AI: newest notable preprints + the most relevant recent papers (AI work is mostly preprints/conferences, so not journal-only)
    arxiv: '(cat:cs.AI OR cat:cs.CL OR cat:cs.LG) AND (ti:"language model" OR ti:"language models" OR ti:agent OR ti:agents OR ti:reasoning OR ti:"foundation model" OR ti:multimodal OR ti:alignment)',
    openalex: '("large language models" OR "generative AI" OR "AI agents" OR "foundation models" OR "artificial intelligence") AND (capabilities OR reasoning OR evaluation OR adoption OR survey)',
    oaFilter: 'type:article|review|preprint', sinceDays: 365,
  },
  fmcg: {
    label: 'FMCG forecasting',
    arxiv: '(ti:forecasting OR ti:forecast OR ti:"demand prediction") AND (abs:retail OR abs:grocery OR abs:"consumer goods" OR abs:FMCG OR abs:CPG OR abs:"demand forecasting" OR abs:SKU OR abs:promotion) AND (cat:cs.LG OR cat:stat.ML OR cat:cs.AI OR cat:stat.AP)',
    openalex: '("demand forecasting" OR "sales forecasting") AND (FMCG OR "fast-moving consumer goods" OR "consumer goods" OR "consumer packaged goods" OR retail OR grocery OR beverage OR SKU OR promotion)',
  },
  markets: {
    label: 'Market forecasting',
    arxiv: '(ti:forecasting OR ti:forecast OR ti:prediction OR ti:predicting OR ti:predictability OR abs:"return prediction") AND (cat:q-fin.ST OR cat:q-fin.PM OR cat:q-fin.TR OR cat:q-fin.CP OR cat:q-fin.GN)',
    openalex: '("stock price prediction" OR "stock return prediction" OR "return predictability" OR "stock market forecasting" OR "portfolio" OR "factor investing") AND ("machine learning" OR "deep learning" OR forecasting OR "emerging markets" OR "frontier markets")',
  },
  logistics: {
    label: 'Logistics',
    arxiv: '(ti:logistics OR ti:"supply chain" OR ti:inventory OR ti:"vehicle routing" OR ti:warehouse) AND (cat:math.OC OR cat:cs.AI OR cat:cs.LG OR cat:econ.GN)',
    openalex: '("logistics management" OR "supply chain management" OR "last-mile delivery" OR "distribution logistics" OR "inventory management")',
  },
  sales: {
    label: 'Sales innovation',
    arxiv: null,
    openalex: '("sales innovation" OR "sales force automation" OR "B2B sales" OR "sales management" OR "salesperson" OR "route to market") AND (technology OR digital OR AI OR analytics OR innovation)',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoAgo = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s || '');
const authorsShort = (list) => (list.length > 3 ? `${list.slice(0, 3).join(', ')} et al.` : list.join(', '));

// OpenAlex stores abstracts as an inverted index { word: [positions] }
function unInvert(inv) {
  if (!inv) return '';
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(' ');
}

export function parseArxiv(xml) {
  const out = [];
  for (const e of xml.split('<entry>').slice(1)) {
    const tag = (t) => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
    const id = tag('id').trim();
    const title = htmlToText(tag('title')).replace(/\s+/g, ' ').trim();
    if (!id || !title) continue;
    const authors = [...e.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map((m) => m[1].trim());
    const pdf = (e.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/) || e.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/) || [])[1];
    const cat = (e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [])[1];
    out.push({
      id: `arxiv:${id.split('/abs/')[1] || id}`, title, authors: authorsShort(authors), venue: `arXiv preprint${cat ? ` · ${cat}` : ''}`,
      date: tag('published').slice(0, 10), cites: null, url: id.replace('http://', 'https://'), pdf: pdf ? pdf.replace('http://', 'https://') : null,
      oa: true, preprint: true, abstract: clip(htmlToText(tag('summary')).replace(/\s+/g, ' ').trim(), 1400), src: 'arXiv',
    });
  }
  return out;
}

export function parseOpenAlex(j) {
  return (j?.results || []).map((w) => {
    const authors = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
    const src = w.primary_location?.source;
    const doi = w.doi ? w.doi.replace('https://doi.org/', '') : null;
    return {
      id: `oa:${(w.id || '').split('/').pop()}`, title: deCaps(htmlToText(w.display_name || w.title || '').trim()), authors: authorsShort(authors),
      venue: src?.display_name || (w.type ? w.type.replace(/-/g, ' ') : 'Journal article'), date: w.publication_date || String(w.publication_year || ''),
      cites: w.cited_by_count ?? null, url: w.doi || w.primary_location?.landing_page_url || w.id, pdf: w.open_access?.oa_url || w.primary_location?.pdf_url || null,
      oa: !!w.open_access?.is_oa, preprint: w.type === 'preprint', abstract: clip(unInvert(w.abstract_inverted_index).replace(/^(abstract|summary)[:.\s]+/i, ''), 1400), doi, src: 'OpenAlex',
    };
  }).filter((p) => p.title);
}

// some journals publish titles in ALL CAPS — show them in title case
export const deCaps = (t) => (t && t === t.toUpperCase() && /[A-Z]{4}/.test(t)
  ? t.toLowerCase().replace(/(^|[\s(:–-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Ai|Ml|Bsc|Crm|B2b|Sme|Smes|Lstm|Iot|Erp|Usa|Uk)\b/g, (w) => w.toUpperCase())
  : t);
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);

async function arxivSearch(q, n = 12) {
  const xml = await getText(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&max_results=${n}`, 30000);
  return parseArxiv(xml).map((p, i) => ({ ...p, rank: i + 0.5 }));  // interleave newest preprints with best journal matches
}
async function openAlexSearch(q, n = 25, sinceDays = 730, typeFilter = 'type:article|review,primary_location.source.type:journal') {
  const sel = 'id,doi,display_name,publication_date,publication_year,type,cited_by_count,open_access,primary_location,authorships,abstract_inverted_index';
  // English journal articles and reviews only (no theses, book chapters or datasets)
  const filter = `from_publication_date:${isoAgo(sinceDays)},has_abstract:true,language:en,${typeFilter}`;
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=${filter}&per-page=${n}&select=${sel}`;
  let j;
  try { j = await getJSON(url, 30000); } catch (e) {
    if (!/HTTP 429/.test(String(e.message || e))) throw e;
    await sleep(4000); j = await getJSON(url, 30000); // rate-limited: wait and try once more
  }
  return parseOpenAlex(j).map((p, i) => ({ ...p, rank: i }));
}

export async function research() {
  const topics = {}; const errors = [];
  for (const [k, t] of Object.entries(RESEARCH_TOPICS)) {
    const jobs = [t.openalex ? openAlexSearch(t.openalex, 25, t.sinceDays || 730, t.oaFilter) : null, t.arxiv ? arxivSearch(t.arxiv) : null].filter(Boolean);
    const res = await Promise.allSettled(jobs);
    await sleep(1200); // space out OpenAlex calls (free tier, shared allowance)
    const seen = new Set(); const papers = [];
    for (const r of res) {
      if (r.status !== 'fulfilled') { errors.push(`${t.label}: ${String(r.reason?.message || r.reason).slice(0, 60)}`); continue; }
      for (const p of r.value) { const key = norm(p.title); if (!seen.has(key)) { seen.add(key); papers.push(p); } }
    }
    topics[k] = papers;
  }
  if (!Object.values(topics).some((l) => l.length)) throw new Error(errors[0] || 'no papers returned');
  return { topics, errors, at: new Date().toISOString() };
}
