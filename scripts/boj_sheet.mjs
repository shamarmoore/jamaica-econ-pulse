// Read a Bank of Jamaica spreadsheet (same files the app reads) as rows.
import { getBinary } from '../www/js/util.js';
export async function readSheetRows(path) {
  const X = await import('../www/vendor/xlsx.mjs');
  const wb = X.read(await getBinary(`https://boj.org.jm/wp-content/uploads/${path}`), { type: 'array' });
  return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
}
