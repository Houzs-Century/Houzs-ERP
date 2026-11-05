#!/usr/bin/env node
/* Put the supplier's barcodes onto inventory products from a JSON list
   (`[{ "code", "barcode" }]`), so the ERP inventory and every POS device read
   them: a POS item carries its product's factory barcode, so one write here
   serves both. Born for the Akemi Cash & Carry bedlines, diffusers and
   accessories (owner's sheet, 2026-10-29: backend/scripts/data/akemi-cc-barcodes-2026-10-29.json).

   A row is written ONLY when all of these hold, and every other row is
   printed with its reason and left alone:
     - the barcode is 8 to 14 digits, and a 13-digit one has a valid EAN-13
       check digit (a mistyped digit must not become a live barcode);
     - the barcode appears once in the file;
     - the code names exactly one product of the company, matched on the code
       with whitespace collapsed, case ignored, then with a leading "AK-" /
       "AK " dropped (the supplier's export carries that prefix, the ERP
       mostly does not);
     - the product has NO barcode yet, or already this one (a different one
       is a conflict the owner decides, never an overwrite);
     - the barcode is not already on another product, a POS extra barcode or
       a generated POS barcode (a barcode is unique per company across the
       three sources; `docs/modules/pos.md`).

   MODE=plan (default) prints every row's verdict and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes one row at a
   time guarded by `barcode IS NULL OR barcode = ''`, then re-reads every
   written product on a FRESH connection and asserts the barcode is the one in
   the file.

   Env: DATA=<path relative to backend/> (default the Akemi file), COMPANY (1).

   RE-RUN: inert. A product that already carries the file's barcode reads as
   "same" and is skipped; nothing is written twice. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { ean13Valid, normCode, stripAk } from './lib/barcode-match.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const DATA = process.env.DATA || 'scripts/data/akemi-cc-barcodes-2026-10-29.json';
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} data=${DATA}`);
  const rows = JSON.parse(readFileSync(resolve(process.cwd(), DATA), 'utf8'));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('the data file holds no rows');

  const seen = new Map();
  for (const r of rows) seen.set(String(r.barcode ?? '').trim(), (seen.get(String(r.barcode ?? '').trim()) ?? 0) + 1);

  const products = await sql.unsafe(
    `SELECT id, code, COALESCE(barcode, '') AS barcode FROM scm.mfg_products WHERE company_id = $1`, [CO]);
  const byExact = new Map();
  const byStripped = new Map();
  for (const p of products) {
    const k = normCode(p.code);
    byExact.set(k, [...(byExact.get(k) ?? []), p]);
    const s = stripAk(p.code);
    byStripped.set(s, [...(byStripped.get(s) ?? []), p]);
  }
  const taken = new Set([
    ...(await sql.unsafe(`SELECT barcode FROM scm.mfg_products WHERE company_id = $1 AND COALESCE(barcode, '') <> ''`, [CO])).map((r) => r.barcode),
    ...(await sql.unsafe(`SELECT barcode FROM pos_item_barcodes WHERE company_id = $1`, [CO])).map((r) => r.barcode),
    ...(await sql.unsafe(`SELECT barcode FROM pos_generated_barcodes WHERE company_id = $1`, [CO])).map((r) => r.barcode),
  ]);

  const verdicts = [];
  for (const r of rows) {
    const code = String(r.code ?? '').trim();
    const barcode = String(r.barcode ?? '').trim();
    const v = { code, barcode, kind: '', why: '', product: null };
    const matches = byExact.get(normCode(code)) ?? byStripped.get(stripAk(code)) ?? [];
    if (!/^\d{8,14}$/.test(barcode)) { v.kind = 'refused'; v.why = 'barcode is not 8 to 14 digits'; }
    else if (barcode.length === 13 && !ean13Valid(barcode)) { v.kind = 'refused'; v.why = 'EAN-13 check digit is wrong'; }
    else if (seen.get(barcode) > 1) { v.kind = 'refused'; v.why = `barcode appears ${seen.get(barcode)} times in the file`; }
    else if (matches.length === 0) { v.kind = 'no-match'; v.why = 'no product with this code'; }
    else if (matches.length > 1) { v.kind = 'refused'; v.why = `${matches.length} products share this code: ${matches.map((p) => p.code).join(' | ')}`; }
    else if (matches[0].barcode === barcode) { v.kind = 'same'; v.product = matches[0]; }
    else if (matches[0].barcode !== '') { v.kind = 'conflict'; v.why = `product already carries ${matches[0].barcode}`; v.product = matches[0]; }
    else if (taken.has(barcode)) { v.kind = 'refused'; v.why = 'barcode already used elsewhere in the company'; v.product = matches[0]; }
    else { v.kind = 'set'; v.product = matches[0]; }
    verdicts.push(v);
  }

  const by = (k) => verdicts.filter((v) => v.kind === k);
  note(`\n=== PLAN: ${rows.length} rows ===`);
  note(`  set: ${by('set').length}  same: ${by('same').length}  no-match: ${by('no-match').length}  conflict: ${by('conflict').length}  refused: ${by('refused').length}`);
  for (const v of verdicts) if (v.kind !== 'set' && v.kind !== 'same') note(`  ${v.kind.toUpperCase()} ${v.code} ${v.barcode}: ${v.why}`);
  for (const v of by('set')) note(`  set ${v.product.code} <- ${v.barcode}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  let wrote = 0;
  for (const v of by('set')) {
    const res = await sql.unsafe(
      `UPDATE scm.mfg_products SET barcode = $1, updated_at = now()
        WHERE id = $2 AND company_id = $3 AND (barcode IS NULL OR barcode = '') RETURNING id`,
      [v.barcode, v.product.id, CO]);
    if (res.length === 1) wrote++; else bad(`  ${v.product.code}: not written (barcode changed under us)`);
  }
  note(`  written: ${wrote} of ${by('set').length}`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let ok = 0;
    for (const v of by('set')) {
      const [row] = await check.unsafe(`SELECT barcode FROM scm.mfg_products WHERE id = $1 AND company_id = $2`, [v.product.id, CO]);
      if (row?.barcode === v.barcode) ok++; else bad(`  ${v.product.code}: reads "${row?.barcode ?? '(none)'}", expected ${v.barcode}`);
    }
    const [{ n }] = await check.unsafe(
      `SELECT COUNT(*)::int AS n FROM (SELECT barcode FROM scm.mfg_products WHERE company_id = $1 AND COALESCE(barcode, '') <> '' GROUP BY barcode HAVING COUNT(*) > 1) d`, [CO]);
    note(`  ${ok} of ${by('set').length} products read back with the file's barcode; duplicate barcodes across products: ${n}`);
    if (ok !== by('set').length || n > 0) process.exit(1);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
