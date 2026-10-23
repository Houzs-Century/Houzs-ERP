#!/usr/bin/env node
// check-3pl-ap-files.mjs — READ-ONLY. Owner 2026-10-23 (先检查): 「msj 本身的单时有的，
// 只是后来他们成lumpsum / nest Living 的单本身也是有每个do 的 / brightsun 本身也有另外一个
// 文件关于那个费用时送什么货的」. The per-delivery detail is in the FILES attached to
// the transport AP invoices, not on the AP lines. This reads those files from R2
// (never writes), has the production bill model (acc/bill-extract.ts BILL_MODEL)
// list every delivery charged on each, and resolves the DO / SO / slip numbers
// against the system. Writes nothing anywhere.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const MODEL = 'claude-sonnet-4-6';
const MAX_FILES = 40;
const PROMPT = `This is a bill, or a page attached to a bill, from a Malaysian transport / logistics company to a furniture retailer (Houzs or 2990).
List every delivery or job it charges for. Return VALID JSON ONLY, first char '{', last char '}', no prose:
{"kind":"per-delivery"|"lump-sum"|"other","rows":[{"doNo":string|null,"soNo":string|null,"ref":string|null,"customer":string|null,"place":string|null,"date":"YYYY-MM-DD"|null,"amountRm":number|null,"what":"transport"|"handling"|"storage"|"setup"|"dismantle"|"dispose"|"other"}]}
doNo: a delivery order number exactly as printed (e.g. HC-DO-2609-152, 2990-DO-2610-004, DO 11558). soNo: a sales order number as printed (e.g. HC-SO-012467, SO012467). ref: any other order / slip / invoice number tied to the customer (e.g. HC12975, ZNT6656). Null when the line has none. One row per printed line; amountRm null when the line shows none.`;

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
const rm = (sen) => (Number(sen ?? 0) / 100).toFixed(2);
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const key = (s) => String(s ?? '').toUpperCase().replace(/[\s-]/g, '');

async function readFile(file, mime) {
  const buf = readFileSync(file);
  const isPdf = mime === 'application/pdf' || buf.slice(0, 4).toString() === '%PDF';
  const media = isPdf ? 'application/pdf' : (buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : mime);
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, temperature: 0, messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: `model ${res.status} ${one(body?.error?.message).slice(0, 120)}` };
  const txt = body?.content?.find((c) => c.type === 'text')?.text ?? '';
  try { return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch { return { error: 'unreadable answer' }; }
}

try {
  const inv = await sql`
    SELECT i.id, i.company_id, i.invoice_number, i.supplier_invoice_ref, i.invoice_date, i.total_sen, s.name AS supplier
      FROM scm.ap_invoices i JOIN scm.suppliers s ON s.id = i.supplier_id
     WHERE i.status <> 'CANCELLED' AND s.name ~* '(MSJ|NEST LIVING|BRIGHTSUN|EU LOGISTICS|HAO HUA)'
     ORDER BY s.name, i.invoice_date DESC`;
  const files = inv.length ? await sql`
    SELECT ap_invoice_id, file_key, file_name, mime, size_bytes, sort_no FROM scm.acc_ap_invoice_files
     WHERE ap_invoice_id IN ${sql(inv.map((i) => i.id))} ORDER BY ap_invoice_id, sort_no` : [];
  const filesOf = new Map();
  for (const f of files) { const a = filesOf.get(f.ap_invoice_id) ?? []; a.push(f); filesOf.set(f.ap_invoice_id, a); }
  console.log(`ROW|transport AP invoices: ${inv.length}; files attached: ${files.length}`);
  for (const i of inv) {
    const fs = filesOf.get(i.id) ?? [];
    console.log(`ROW|${i.supplier.slice(0, 28)} | ${i.invoice_number} ${i.invoice_date} ref=${one(i.supplier_invoice_ref) || '-'} RM ${rm(i.total_sen)} | files ${fs.length}: ${fs.map((f) => `${f.file_name} (${f.mime}, ${Math.round(Number(f.size_bytes) / 1024)} KB)`).join('; ') || '-'}`);
  }
  if (!process.env.ANTHROPIC_API_KEY) { console.log('ROW|ANTHROPIC_API_KEY not set — listing only'); process.exit(0); }

  /* Read each file, newest bills first, up to MAX_FILES. */
  const dir = mkdtempSync(path.join(tmpdir(), 'ap3pl-'));
  const found = []; // { inv, file, row }
  let readCount = 0;
  for (const i of inv) {
    for (const f of filesOf.get(i.id) ?? []) {
      if (readCount >= MAX_FILES) break;
      const local = path.join(dir, `${readCount}`);
      const g = spawnSync('npx', ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${f.file_key}`, '--remote', '--file', local], { encoding: 'utf8' });
      if (g.status !== 0) { console.log(`ROW|  ${i.invoice_number} ${f.file_name}: R2 read failed`); continue; }
      readCount += 1;
      const r = await readFile(local, f.mime);
      if (r.error) { console.log(`ROW|  ${i.invoice_number} ${f.file_name}: ${r.error}`); continue; }
      const rows = Array.isArray(r.rows) ? r.rows : [];
      const numbered = rows.filter((x) => x.doNo || x.soNo || x.ref);
      const total = rows.reduce((s, x) => s + (Number(x.amountRm) || 0), 0);
      console.log(`ROW|  ${i.invoice_number} ${f.file_name}: kind=${r.kind} rows=${rows.length} with a number=${numbered.length} sum RM ${total.toFixed(2)}`);
      for (const x of rows.slice(0, 60)) {
        console.log(`ROW|     do=${x.doNo ?? '-'} so=${x.soNo ?? '-'} ref=${x.ref ?? '-'} ${one(x.customer).slice(0, 24) || '-'} @${one(x.place).slice(0, 24) || '-'} ${x.date ?? '-'} RM ${x.amountRm ?? '-'} ${x.what ?? '-'}`);
        found.push({ inv: i, row: x });
      }
    }
  }

  /* Resolve the numbers against the system. */
  const doKeys = [...new Set(found.map((f) => key(f.row.doNo)).filter(Boolean))];
  const soKeys = [...new Set(found.map((f) => key(f.row.soNo)).filter(Boolean))];
  const refKeys = [...new Set(found.map((f) => key(f.row.ref)).filter(Boolean))];
  const dos = doKeys.length ? await sql`SELECT company_id, do_number, so_doc_no FROM scm.delivery_orders WHERE upper(replace(replace(do_number, '-', ''), ' ', '')) IN ${sql(doKeys)}` : [];
  const doHit = new Map(dos.map((d) => [key(d.do_number), d]));
  /* A printed "DO 11558" may drop the prefix: try the digits against the tail too. */
  const tailMiss = doKeys.filter((k) => !doHit.has(k));
  for (const k of tailMiss) {
    const digits = k.replace(/\D/g, '');
    if (digits.length < 4) continue;
    const t = await sql`SELECT company_id, do_number, so_doc_no FROM scm.delivery_orders WHERE replace(do_number, '-', '') LIKE ${'%' + digits}`;
    if (t.length === 1) doHit.set(k, t[0]);
  }
  let soHit = 0;
  for (const k of soKeys) {
    const digits = k.replace(/\D/g, '');
    const t = await sql`SELECT doc_no FROM scm.mfg_sales_orders WHERE replace(doc_no, '-', '') ILIKE ${'%SO' + digits}`;
    if (t.length) soHit += 1;
  }
  let refHit = 0;
  for (const k of refKeys) {
    const t = await sql`SELECT doc_no FROM scm.mfg_sales_orders WHERE upper(regexp_replace(coalesce(customer_so_no,'') || ' ' || coalesce(ref,''), '[\\s-]', '', 'g')) LIKE ${'%' + k + '%'} LIMIT 2`;
    if (t.length) refHit += 1;
  }
  console.log(`ROW|numbers read: DO ${doKeys.length} (in system ${doHit.size}), SO ${soKeys.length} (in system ${soHit}), slip/ref ${refKeys.length} (in system ${refHit})`);
  console.log(`ROW|DO numbers not found: ${doKeys.filter((k) => !doHit.has(k)).slice(0, 30).join(', ') || 'none'}`);
} finally {
  await sql.end();
}
