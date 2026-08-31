#!/usr/bin/env node
/* Purchase-side document lines carrying an internal item code that no product
   row has — the "orphan code" class, repointed onto the code the ERP actually
   uses for that sofa.

   WHAT THE OWNER SAW. A purchase order for a HOK sofa showed the internal code
   `5540-1S` while its own sales order showed `8030-*`, and the PO did not link
   back to the order at all (HC-SO-013389). Owner 2026-08-31, asked whether the
   two are the same sofa: 对相同的 — they are one physical product. His rule for
   this whole chain: 内部件号 SO 和 PO 必须一样，不同的只是供应商 SKU 那一栏.

   WHY THE CODE IS WRONG, TRACED. lib/parse-sofa.mjs holds the ERP's own
   statement of that identity:

       SOFA_MODEL_ALIAS = { 5530: 9028, 5536: 9058, 5537: 8030, 5540: 8030 }

   Every sofa path applies it, so the sales orders, the compartment SKUs and the
   catalog all spell these four models by their ALIAS. The AutoCount binding
   file did not: data/autocount-erp-mapping-1561.csv mapped `HOK-5540 SOFA` to
   `5540-1S`, a code scm.mfg_products has never carried. The importers' silent
   placeholder fallback (`codeSet.has(ph) ? ph : l.erp`) then wrote that raw
   mapped code onto the line. `item_code` is plain text with NO foreign key to
   scm.mfg_products, so nothing refused it — the row simply became an orphan.

   The CSV is fixed in the same PR and both importers now refuse a non-catalog
   code, which stops new ones. This repairs the rows already in production.

   WHAT IT CHANGES, AND WHAT IT REFUSES TO TOUCH. `item_code` only, on
   scm.purchase_order_items / scm.grn_items / scm.purchase_invoice_items.
   NOT supplier_sku — that column is supposed to differ; it holds the book's own
   `HOK-5540 SOFA`, which is what the factory reads. NOT qty, NOT received_qty,
   NOT unit_price_sen / line_total_sen, NOT a single inventory movement or lot.
   The verification re-reads all of those per row and fails if any moved.

   A code is repaired ONLY when the alias resolves it to a code the catalog
   really carries. Anything else is printed and REFUSED — an orphan whose
   replacement would be a guess stays visible rather than becoming plausible.

   MODE=plan (default) prints every row it would touch, the census per table,
   and the sweep proving no other table in scm still names the orphan code.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE ORPHAN CODE PLAN".

   RE-RUN: inert. Every statement is keyed on the ORPHAN code, which the repair
   turns into the aliased one, so a second run matches zero rows and reports
   "nothing to repair". Re-running is also the way to verify a finished repair.

     MODE=plan  DATABASE_URL=… node scripts/repair-orphan-sofa-codes.mjs
     Actions -> "repair-orphan-sofa-codes" -> mode=plan */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { SOFA_MODEL_ALIAS } from './lib/parse-sofa.mjs';
import { aliasedCode } from './lib/catalog-code-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE ORPHAN CODE PLAN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* The three purchase-side arms. The joins are the ones diag-orphan-codes.mjs
   ran against production on 2026-08-31 (run 33350184987), so the column names
   here are measured rather than read off a migration file. Company scope is on
   the PARENT — an item row proves it is on a document, never that the document
   is in these books (CLAUDE.md, company scope). */
const ARMS = [
  { name: 'PO', t: 'scm.purchase_order_items',
    ex: 'SELECT 1 FROM scm.purchase_orders h WHERE h.id = i.purchase_order_id AND h.company_id = $1' },
  { name: 'GRN', t: 'scm.grn_items',
    ex: 'SELECT 1 FROM scm.grns h WHERE h.id = i.grn_id AND h.company_id = $1' },
  { name: 'PI', t: 'scm.purchase_invoice_items',
    ex: 'SELECT 1 FROM scm.purchase_invoices h WHERE h.id = i.purchase_invoice_id AND h.company_id = $1' },
];

/* The money and quantity columns this repair must leave EXACTLY alone. Read
   before and re-read after, per row: "I only wrote item_code" is a claim about
   a statement, and the statement is not the evidence.

   RESOLVED PER ARM, never hard-coded into the SELECT. The three tables do not
   carry the same columns — `received_qty` belongs to the purchase ORDER line,
   and a receipt or an invoice line has no use for it — and a hard-coded select
   fails the WHOLE run on the first arm that lacks one. That is not a
   hypothetical: repair-array-shaped-variants.mjs took exactly that failure on
   its first production plan, over `item_code` on inventory_movements. */
const UNTOUCHED = ['supplier_sku', 'qty', 'received_qty', 'unit_price_sen', 'line_total_sen'];

/** The guarded columns this arm actually has, in UNTOUCHED order. */
async function untouchedColumnsFor(client, arm) {
  const table = arm.t.replace(/^scm\./, '');
  const have = new Set((await client`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}`).map((r) => r.column_name));
  return UNTOUCHED.filter((c) => have.has(c));
}

/* The mapping file's own dialect, same reader both importers use. NOT
   `line.split(',')`: three rows quote the ERP code because it holds an inch
   mark — `DL-GENERASI (K),"DUNLOPILLO GENERASI 5"" MATT (K)",…` — and a naive
   split hands back the code WITH its quotes, which no catalog row can match.
   The audit below would then have reported three products that are perfectly
   fine as missing, which is the shape of finding that gets a real one ignored. */
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}

/**
 * Rows on ANY scm BASE TABLE whose item-code column still names one of these
 * codes — the proof that repairing three arms repairs the whole reference, and
 * not just the three places somebody happened to look.
 *
 * BASE TABLES only, deliberately. A view over one of these tables would report
 * the same rows a second time and make "references remaining" read higher than
 * the storage actually holds; a MATERIALIZED view is not in information_schema
 * at all (mig 0305 bought that lesson on mv_ar_aging), so this cannot claim to
 * cover one. The claim is exactly: every stored column in scm that could name a
 * product code.
 *
 * TWO column names, not four. `material_code` (purchasing) and `product_code`
 * (inventory) were the drift and migration 0307 renamed 18 columns off them on
 * 2026-08-19 — scripts/lib/vocabulary.mjs holds that ruling and the audit
 * enforces it. Sweeping for names the schema no longer has would not have found
 * anything; it would only have made the sweep look wider than it is.
 */
async function shapeCheckOrphansAcrossSchema(client, codes) {
  if (!codes.length) return [];
  const cols = await client`
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'scm'
       AND t.table_type = 'BASE TABLE'
       AND c.column_name IN ('item_code', 'sku_code')
     ORDER BY c.table_name, c.column_name`;
  const out = [];
  for (const c of cols) {
    /* Identifiers come from information_schema, never from a caller — the same
       rule check-sequence-drift.mjs states. Values stay bound. */
    const [r] = await client.unsafe(
      `SELECT COUNT(*)::int AS n FROM scm.${c.table_name} WHERE upper(${c.column_name}) = ANY($1::text[])`,
      [codes.map((x) => x.toUpperCase())]);
    if (r.n > 0) out.push({ table: `scm.${c.table_name}`, column: c.column_name, n: r.n });
  }
  return out;
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  /* The catalog, and it is the authority on BOTH ends: which codes are orphans,
     and whether the alias target is a code that really exists. */
  const products = await sql`SELECT code, name, status::text AS status FROM scm.mfg_products WHERE company_id = ${CO}`;
  const byCode = new Map(products.map((p) => [String(p.code).toUpperCase(), p]));
  note(`catalog: ${products.length} product(s) for company ${CO}`);

  /* THE BINDING FILE, audited against that same catalog. The orphan rows below
     are the damage; this is the SOURCE, and it answers the question the row
     census cannot: which OTHER mapping rows would write a code nobody minted
     the next time an importer runs. Read-only, and printed in both modes. */
  const csv = fs.readFileSync(path.join(here, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8')
    .replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  csv.shift();
  const csvBad = [];
  for (const line of csv) {
    const f = parseCsvLine(line);
    const acCode = (f[0] || '').trim();
    const erpCode = (f[1] || '').trim();
    if (!acCode || !erpCode) continue;
    if (!byCode.has(erpCode.toUpperCase())) {
      csvBad.push({ acCode, erpCode, cat: (f[3] || '').trim(), alias: aliasedCode(erpCode, SOFA_MODEL_ALIAS) });
    }
  }
  note(`\n=== autocount-erp-mapping-1561.csv vs the catalog ===`);
  note(`  ${csv.length} mapping row(s); ${csvBad.length} point at an ERP code company ${CO} does not carry`);
  for (const r of csvBad.slice(0, 60)) {
    note(`    ${r.acCode.padEnd(34)} -> ${r.erpCode.padEnd(24)} [${r.cat || '-'}]${r.alias ? `  (alias says ${r.alias})` : ''}`);
  }
  if (csvBad.length > 60) note(`    ... and ${csvBad.length - 60} more`);

  note('\n=== ORPHAN item codes on purchase-side documents ===');
  const rows = [];
  const guarded = new Map();
  for (const arm of ARMS) {
    const cols = await untouchedColumnsFor(sql, arm);
    guarded.set(arm.name, cols);
    const r = await sql.unsafe(
      `SELECT i.id::text AS id, i.item_code${cols.length ? ', ' + cols.map((c) => `i.${c}`).join(', ') : ''}
         FROM ${arm.t} i
        WHERE EXISTS (${arm.ex})
          AND i.item_code IS NOT NULL AND btrim(i.item_code) <> ''
          AND NOT EXISTS (SELECT 1 FROM scm.mfg_products p
                           WHERE p.company_id = $1 AND upper(p.code) = upper(i.item_code))
        ORDER BY i.item_code, i.id`, [CO]);
    for (const x of r) rows.push({ arm: arm.name, t: arm.t, ...x });
    const absent = UNTOUCHED.filter((c) => !cols.includes(c));
    note(`  ${arm.name}: ${r.length} orphan line(s) on ${new Set(r.map((x) => x.item_code)).size} code(s)`
      + `; guarded columns ${cols.join(', ') || '(none)'}${absent.length ? ` — this table has no ${absent.join(', ')}` : ''}`);
  }
  note(`  total: ${rows.length}`);
  if (!rows.length) { note('\nNothing to repair.'); await sql.end({ timeout: 5 }); return; }

  const fix = [], refuse = [];
  for (const r of rows) {
    const target = aliasedCode(r.item_code, SOFA_MODEL_ALIAS);
    if (!target) { refuse.push({ ...r, why: `no SOFA_MODEL_ALIAS entry for "${String(r.item_code).split('-')[0]}" — the right code would be a guess` }); continue; }
    const p = byCode.get(target.toUpperCase());
    if (!p) { refuse.push({ ...r, why: `alias resolves to "${target}", which is ALSO not in the catalog` }); continue; }
    fix.push({ ...r, target: p.code, targetName: p.name, targetStatus: p.status });
  }

  note('\n=== EXACTLY WHICH ROWS, AND WHAT THEY BECOME ===');
  for (const r of fix) {
    note(`  ${r.arm.padEnd(3)} ${r.id}  ${String(r.item_code).padEnd(16)} -> ${String(r.target).padEnd(16)} (${r.targetName ?? '-'} / ${r.targetStatus ?? '-'})`);
    const stays = (guarded.get(r.arm) ?? []).map((c) => `${c}=${JSON.stringify(r[c] ?? null)}`).join(' ');
    note(`        STAYS: ${stays || '(this table carries none of the guarded columns)'}`);
  }
  for (const r of refuse) bad(`  ${r.arm.padEnd(3)} ${r.id}  ${String(r.item_code).padEnd(16)} REFUSED — ${r.why}`);
  note(`\n  repairable: ${fix.length}   refused: ${refuse.length}`);
  const perPair = new Map();
  for (const r of fix) { const k = `${r.item_code} -> ${r.target}`; perPair.set(k, (perPair.get(k) ?? 0) + 1); }
  for (const [pair, n] of perPair) note(`    ${pair}: ${n} line(s)`);

  /* THE SWEEP. Repointing three tables is only a repair if nothing ELSE in the
     schema still names the orphan code — otherwise this moves the divergence
     rather than removing it. Driven off information_schema so a table added
     later is included without editing this file. */
  const orphanCodes = [...new Set(rows.map((r) => String(r.item_code)))];
  note('\n=== EVERY scm COLUMN THAT STILL NAMES ONE OF THESE CODES ===');
  const before = await shapeCheckOrphansAcrossSchema(sql, orphanCodes);
  for (const h of before) note(`  ${h.table}.${h.column}: ${h.n}`);
  const outside = before.filter((h) => !ARMS.some((a) => a.t === h.table && h.column === 'item_code'));
  if (!outside.length) note('  (nothing outside the three arms above — the repair is complete by itself)');
  else for (const h of outside) bad(`  OUTSIDE THE REPAIR: ${h.table}.${h.column} holds ${h.n} — this repair does NOT touch it`);
  note('  supplier_sku is deliberately absent from that list: it is SUPPOSED to hold the book code.');

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== REPAIRING ${fix.length} ROW(S) — item_code ONLY ===`);
  let wrote = 0;
  for (const r of fix) {
    /* Keyed on the orphan value, so a row somebody already repaired matches
       nothing and the second run is inert. One column in the SET list: there is
       no way for this statement to move money even if the WHERE were wrong. */
    const back = await sql.unsafe(
      `UPDATE ${r.t} SET item_code = $2 WHERE id = $1 AND upper(item_code) = upper($3) RETURNING id::text AS id`,
      [r.id, r.target, r.item_code]);
    wrote += back.length;
    note(`  ${back.length ? 'OK  ' : 'SKIP'} ${r.arm} ${r.id} ${r.item_code} -> ${r.target}`);
  }
  note(`  written: ${wrote} of ${fix.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    /* (1) Every repaired row now READS as the aliased code AND that code
       resolves to a real product. A row count would have said "31 of 31" while
       the value was anything at all — the jsonb repair counted 7 of 7 while
       re-corrupting all 7. */
    let wrong = 0;
    for (const r of fix) {
      const cols = guarded.get(r.arm) ?? [];
      const [row] = await check.unsafe(
        `SELECT i.item_code${cols.length ? ', ' + cols.map((c) => `i.${c}`).join(', ') : ''},
                (SELECT p.name FROM scm.mfg_products p
                  WHERE p.company_id = $2 AND upper(p.code) = upper(i.item_code)) AS product
           FROM ${r.t} i WHERE i.id = $1`, [r.id, CO]);
      const okCode = row && String(row.item_code).toUpperCase() === String(r.target).toUpperCase();
      const known = row && row.product !== null;
      /* (2) The columns this repair promised not to touch, compared VALUE by
         VALUE against what the plan read. Stringified so 0 and null cannot pass
         for each other. */
      const moved = cols.filter((c) => JSON.stringify(row ? row[c] : undefined) !== JSON.stringify(r[c]));
      if (!okCode || !known || moved.length) {
        wrong++;
        bad(`  ${r.arm} ${r.id}: item_code="${row?.item_code}" product=${JSON.stringify(row?.product ?? null)}${moved.length ? ` CHANGED ${moved.map((c) => `${c}: ${JSON.stringify(r[c])} -> ${JSON.stringify(row[c])}`).join(', ')}` : ''}`);
      } else {
        note(`  ${r.arm} ${r.id}: item_code "${row.item_code}" resolves to "${row.product}"; unchanged — ${cols.map((c) => `${c}=${JSON.stringify(row[c] ?? null)}`).join(' ') || '(no guarded column on this table)'}`);
      }
    }
    /* (3) And the schema-wide sweep again: what is left must be exactly the
       refused rows, nothing more. */
    const after = await shapeCheckOrphansAcrossSchema(check, orphanCodes);
    const left = after.reduce((s, h) => s + h.n, 0);
    for (const h of after) note(`  still naming an orphan code: ${h.table}.${h.column} = ${h.n}`);
    note(`  rows failing the shape check: ${wrong}`);
    note(`  orphan-code references remaining: ${left} (was ${before.reduce((s, h) => s + h.n, 0)}); ${refuse.length} of those are the REFUSED rows this repair would not guess at`);
    if (wrong) { bad('the repair did not land as planned — read the rows above before doing anything else'); process.exitCode = 1; }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
