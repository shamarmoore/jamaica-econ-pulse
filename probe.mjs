import * as XLSX from 'xlsx';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const r = await fetch('https://boj.org.jm/wp-content/uploads/2020/10/IR.BS.02.xls', { headers: { 'User-Agent': UA } });
const wb = XLSX.read(new Uint8Array(await r.arrayBuffer()));
console.log('sheets', wb.SheetNames);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
console.log('rows', rows.length);
rows.slice(0, 16).forEach((x, i) => console.log('H' + i, JSON.stringify(x).slice(0, 300)));
rows.slice(-5).forEach((x) => console.log('T', JSON.stringify(x).slice(0, 300)));
