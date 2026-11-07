import { SOURCES } from './www/js/sources.js';
for (const id of ['imf', 'fred']) { const s = SOURCES.find((x) => x.id === id); const t = Date.now();
  try { const d = await s.fn(); console.log('OK', id, Date.now() - t, 'ms', d.edition || d.via, Object.keys(d.series).length, JSON.stringify(Object.entries(d.series).slice(0, 2)).slice(0, 300)); } catch (e) { console.log('FAIL', id, e.message); } }
