#!/usr/bin/env node
/* check-po-gr-pi-chain — 「PO GR PI的line information去吧要对其啊」, answered at
 * LINE grain, with the arithmetic shown on both sides.
 *
 * The owner, 2026-09-08, after a lane told him nine goods receipts could not be
 * reconciled because "AutoCount's receipt spans several purchase orders":
 *
 *   「PI 是from multiple的PO 所以GR的吧? 没有啊 我们一张GR to 一张PI — 可是GR
 *     会from multiple PO啊 — 所以你要去GR 每个line的amount 都对齐啊 —
 *     PO GR PI的line information去吧要对其啊」
 *
 * He is right and the schema agrees: `scm.grns.purchase_order_id` is NOT NULL
 * and names ONE order, but `scm.grn_items.purchase_order_item_id` is per line
 * and NULLABLE. The LINES model a multi-order receipt. A document TOTAL cannot,
 * which is why a total was the wrong instrument and this report is a different
 * one: it walks the chain a line at a time and shows how the lines add up to the
 * total on each side, so a difference is attributable to a LINE rather than
 * explained by a story about grain.
 *
 * READ-ONLY. One Postgres connection, SELECTs only, no DDL, no transaction, no
 * MODE=apply. Every legitimate answer exits 0 — including a large difference,
 * because the ANSWER is the output and a red job reads as "the check broke".
 * Non-zero is reserved for being UNABLE to answer: no DATABASE_URL, a missing or
 * stale snapshot, or a matcher that proves itself broken at startup.
 *
 * ── WHAT IT KEYS ON, AND WHAT IT REFUSES TO KEY ON ──────────────────────────
 * Every link is one AutoCount itself wrote:
 *
 *   our receipt line -> the book's receipt line   `grn_items.linked_ac_dtlkey`
 *   the book's receipt line -> its purchase order `GRDTL.FromDocNo`
 *   the book's invoice line -> its receipt        `PIDTL.FromDocNo`
 *
 * NOTHING is paired by position and nothing by name. Two similar rows paired by
 * position get transposed, which is `docs/bugs/0690` — and a transposition is
 * one of the things this report exists to FIND, so a comparison that pairs that
 * way cannot see the defect it is looking for. A line carrying no key is
 * reported as unkeyed, never quietly matched to the row that happens to sit at
 * the same index.
 *
 * ── THE THREE THINGS IT PRINTS ──────────────────────────────────────────────
 * 1. MULTI-ORDER RECEIPTS — how many in-scope receipts draw on more than one
 *    purchase order, and the distribution. The fact the refusal was built on.
 * 2. LINE BY LINE, per (receipt x order) pair that differs — our item, quantity
 *    and money beside the book's, matched on DtlKey, with both sides' lines
 *    summed to their document total underneath so the arithmetic is visible.
 * 3. TRANSPOSITIONS — where our line at key A holds the book's item from key B
 *    and vice versa. Named by KEY, never by the names looking swapped, so the
 *    finding survives two lines that happen to share a product.
 *
 * ── WHAT AN INVOICE TOTAL IS NOT ────────────────────────────────────────────
 * It is not the yardstick for what we hold. The migration carried the
 * OUTSTANDING population, so our documents mirror only some of the pairs an
 * invoice bills; measured on the committed snapshot, 131 of 192 live purchase
 * invoices touching an in-scope receipt bill at least one pair that was never
 * imported. `lib/ac-chain-line-grain.mjs` owns that arithmetic and this report
 * quotes it rather than restating it — there must never be a second opinion
 * about what the book owes us (docs/bugs/0723).
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1 (AED_HOUZS is company 1)
 *   SHOW           documents to detail (default 20; raise to see every one)
 *   MAX_SNAPSHOT_AGE_DAYS  default 2
 *
 * RE-RUN: read-only, so a second run answers again from current state.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import { buildChain, expectedForPairs, invoiceIdentity, pairKey } from './lib/ac-chain-line-grain.mjs';
import { normCode, readMappingCsv } from './lib/ac-mapping-csv.mjs';
import { grPairGrain } from './lib/ac-gr-pair-grain.mjs';
import { buildScope, decodeSnapshot } from './lib/ac-scope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const CO = Number(process.env.COMPANY_ID || 1);
const SHOW = Math.max(1, Number(process.env.SHOW || 20));
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);

const plain = (m) => console.log(m);
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const refuse = (why) => { console.error(`REFUSED: ${why}`); process.exit(2); };

const DSN = process.env.DATABASE_URL;
if (!DSN) refuse('DATABASE_URL not set.');

function loadGz(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) refuse(`backend/scripts/data/${file} is missing. Cut it on a machine on the office network.`);
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8').replace(/^﻿/, ''));
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  const snap = loadGz('ac-reconcile-truth.json.gz');
  const refs = loadGz('ac-invoice-refs.json.gz');
  const age = (Date.now() - Date.parse(snap.exported_at)) / 86400000;
  note(`AutoCount snapshot ${snap.exported_at} (${age.toFixed(2)} days old), company ${CO}`);
  /* Negative age is a CLOCK problem, not a fresh snapshot: the exporter runs on
     a UTC+8 desktop and this runs on a UTC runner. */
  if (age > MAX_AGE || age < -0.5) {
    refuse(`the snapshot is ${age.toFixed(2)} days old (limit ${MAX_AGE}). Re-cut it before comparing against it.`);
  }

  const book = decodeSnapshot(snap);
  const SCOPE = buildScope(book);
  const { scope: pairScope } = grPairGrain(book, SCOPE);
  const chain = buildChain(book, refs);
  const map = readMappingCsv(fs.readFileSync(path.join(DATA, 'autocount-erp-mapping-1561.csv'), 'utf8'));
  if (map.size < 100) refuse(`the item-code map loaded ${map.size} rows. An untranslated comparison reports the whole catalogue as wrong.`);
  const erpCodeFor = (acCode) => (map.get(normCode(acCode))?.erp || '').trim() || null;

  /* ── 1. THE FACT THE REFUSAL WAS BUILT ON ──────────────────────────────── */
  const dist = new Map();
  let multi = 0;
  for (const gr of SCOPE.GR) {
    const orders = chain.ordersOfReceipt.get(gr) ?? new Set();
    dist.set(orders.size, (dist.get(orders.size) ?? 0) + 1);
    if (orders.size > 1) multi++;
  }
  plain('');
  plain('═════════ 1. RECEIPTS THAT DRAW ON MORE THAN ONE PURCHASE ORDER ═════════');
  note(`${multi} of the ${SCOPE.GR.size} in-scope AutoCount receipts draw on more than one purchase order.`);
  plain(`   purchase orders per receipt: ${[...dist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}->${v}`).join('  ')}`);
  plain('   This is NORMAL and it is NOT why a document can differ. Our lines each carry their own');
  plain('   purchase-order line (scm.grn_items.purchase_order_item_id is per line and NULLABLE), so a');
  plain('   multi-order receipt is representable. Only a LINE can differ, and every one is below.');

  /* ── the ERP side, keyed ───────────────────────────────────────────────── */
  const heads = await sql`
    SELECT g.grn_number, g.linked_ac_gr_docno AS ac_gr, p.linked_ac_docno AS ac_po,
           COALESCE(g.total_sen, 0)::bigint AS total_sen, g.currency::text AS currency
      FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
       AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL
     ORDER BY g.grn_number`;
  const lines = await sql`
    SELECT g.grn_number, i.item_code, i.qty_accepted::float8 AS qty,
           i.unit_price_sen::bigint AS unit_price_sen, i.discount_sen::bigint AS discount_sen,
           i.line_total_sen::bigint AS line_total_sen,
           i.linked_ac_dtlkey::text AS ac_dtlkey, i.line_suffix
      FROM scm.grn_items i
      JOIN scm.grns g ON g.id = i.grn_id
     WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED' AND g.linked_ac_gr_docno IS NOT NULL
     ORDER BY g.grn_number, i.created_at, i.id`;

  const linesOf = new Map();
  for (const l of lines) {
    if (!linesOf.has(l.grn_number)) linesOf.set(l.grn_number, []);
    linesOf.get(l.grn_number).push(l);
  }

  /* A checker that cannot match must REFUSE, never report a clean run. */
  const keyed = lines.filter((l) => l.ac_dtlkey).length;
  if (lines.length && keyed === 0) {
    refuse(`${lines.length} ERP receipt lines and NONE carries an AutoCount line key. Every comparison below `
      + 'would be a guess by position. Run backfill-ac-downstream-line-keys.mjs first.');
  }
  note(`ERP: ${heads.length} goods receipts, ${lines.length} lines, ${keyed} carrying an AutoCount line key.`);

  /* ── 2. LINE BY LINE, AND 3. TRANSPOSITIONS ───────────────────────────── */
  const differing = [];
  const transposed = [];
  const unkeyed = [];

  for (const h of heads) {
    const key = pairKey(h.ac_gr, h.ac_po);
    const bookLines = (book.GR.lines.get(h.ac_gr) ?? []).filter((l) => l.fromDocType === 'PO' && l.fromDocNo === h.ac_po);
    if (!bookLines.length) continue;
    const ours = linesOf.get(h.grn_number) ?? [];
    const byKey = new Map(bookLines.map((b) => [String(b.dtlKey), b]));

    /* One AutoCount line is many ERP rows for a decomposed sofa; they share one
       key and the price rides the lead piece, so a group is compared as a
       group. Grouping by the KEY is what makes that safe. */
    const oursByKey = new Map();
    for (const o of ours) {
      if (!o.ac_dtlkey) { unkeyed.push({ doc: h.grn_number, item: o.item_code, qty: o.qty }); continue; }
      if (!oursByKey.has(o.ac_dtlkey)) oursByKey.set(o.ac_dtlkey, []);
      oursByKey.get(o.ac_dtlkey).push(o);
    }

    const findings = [];
    let oursSen = 0;
    let bookSen = 0;
    const rows = [];
    for (const [dk, b] of byKey) {
      bookSen += Math.round(Number(b.subTotalSen ?? 0));
      const grp = oursByKey.get(dk);
      if (!grp) { findings.push(`the book's line ${dk} (${b.itemKey}) has no ERP line`); rows.push({ dk, b, grp: null, sen: 0 }); continue; }
      const sen = grp.reduce((s, o) => s + Math.max(0, Math.round(Number(o.qty) * Number(o.unit_price_sen || 0)) - Number(o.discount_sen || 0)), 0);
      oursSen += sen;
      rows.push({ dk, b, grp, sen });
      const want = erpCodeFor(b.itemKey);
      const got = grp[0].item_code;
      /* A decomposed sofa's pieces carry a compartment suffix, so only the
         un-suffixed lead code is commensurable with the book's. */
      if (want && !grp[0].line_suffix && normCode(got) !== normCode(want)) {
        findings.push(`line ${dk}: the book says ${b.itemKey} (-> ${want}), ours says ${got}`);
      }
      const bq = Number(b.qty ?? 0);
      const oq = Math.max(...grp.map((o) => Number(o.qty)));
      if (bq !== oq) findings.push(`line ${dk}: the book says qty ${bq}, ours says ${oq}`);
      if (sen !== Math.round(Number(b.subTotalSen ?? 0))) {
        findings.push(`line ${dk}: the book says ${rm(b.subTotalSen)}, ours says ${rm(sen)}`);
      }
    }
    for (const dk of oursByKey.keys()) {
      if (!byKey.has(dk)) findings.push(`line ${dk}: we hold a line the book does not state on this pair`);
    }

    /* TRANSPOSITION: our item at key A is the book's item at key B, and the
       other way round. Detected on the KEY. Two lines of the same product are
       therefore not a transposition, and two different products swapped are one
       even when both names look plausible where they sit. */
    for (const a of rows) {
      if (!a.grp) continue;
      for (const b2 of rows) {
        if (!b2.grp || a.dk >= b2.dk) continue;
        const wantA = erpCodeFor(a.b.itemKey);
        const wantB = erpCodeFor(b2.b.itemKey);
        if (!wantA || !wantB || normCode(wantA) === normCode(wantB)) continue;
        if (normCode(a.grp[0].item_code) === normCode(wantB) && normCode(b2.grp[0].item_code) === normCode(wantA)) {
          transposed.push({
            doc: h.grn_number, pair: key,
            a: { dk: a.dk, book: a.b.itemKey, want: wantA, got: a.grp[0].item_code },
            b: { dk: b2.dk, book: b2.b.itemKey, want: wantB, got: b2.grp[0].item_code },
          });
        }
      }
    }

    if (findings.length) {
      differing.push({
        doc: h.grn_number, pair: key, inScope: pairScope.has(key),
        headerSen: Number(h.total_sen), currency: h.currency,
        oursSen, bookSen, rows, findings,
      });
    }
  }

  plain('');
  plain('═════════ 2. LINE BY LINE — every pair whose lines do not agree ═════════');
  note(`${differing.length} (receipt x purchase order) pair(s) differ on at least one LINE.`);
  for (const d of differing.slice(0, SHOW)) {
    plain('');
    plain(`── ${d.doc}  (${d.pair})${d.inScope ? '' : '  [pair is OUTSIDE the migration scope]'}`);
    plain(`   ${'AutoCount line'.padEnd(16)} ${'the book says'.padEnd(34)} ${'we say'.padEnd(34)}`);
    for (const r of d.rows) {
      const bookCell = `${String(r.b.itemKey).slice(0, 20).padEnd(21)} x${String(r.b.qty).padStart(3)} ${rm(r.b.subTotalSen).padStart(12)}`;
      const ourCell = r.grp
        ? `${String(r.grp[0].item_code).slice(0, 20).padEnd(21)} x${String(Math.max(...r.grp.map((o) => Number(o.qty)))).padStart(3)} ${rm(r.sen).padStart(12)}`
        : '(no ERP line)';
      plain(`   ${String(r.dk).padEnd(16)} ${bookCell.padEnd(34)} ${ourCell}`);
    }
    plain(`   ${''.padEnd(16)} ${'-'.repeat(34)} ${'-'.repeat(34)}`);
    plain(`   ${'TOTAL'.padEnd(16)} ${rm(d.bookSen).padStart(34)} ${rm(d.oursSen).padStart(34)}`);
    plain(`   the ERP header states ${rm(d.headerSen)} in ${d.currency}; the lines above sum to ${rm(d.oursSen)}.`);
    for (const f of d.findings) plain(`     - ${f}`);
    /* What the invoice bills, so nobody reads its total as our shortfall. */
    const invs = chain.invoicesOfReceipt.get(d.pair.slice(0, d.pair.indexOf('|'))) ?? [];
    for (const pi of invs) {
      const id = invoiceIdentity(chain, pi);
      const held = expectedForPairs(chain, [d.pair]);
      plain(`     chain: ${pi} bills ${rm(id.netTotalSen)} in ${id.currency ?? '?'}; the book's money for THIS pair is ${rm(held.sen)}.`);
      if (!id.commensurable) plain(`            ${id.why}`);
    }
  }
  if (differing.length > SHOW) plain(`   ... ${differing.length - SHOW} more (raise SHOW)`);

  plain('');
  plain('═════════ 3. TRANSPOSED LINES — our line holds the other line\'s item ═════════');
  if (!transposed.length) {
    note('0 transpositions. Detected on the AutoCount line KEY, so this is not "the names look right".');
  } else {
    note(`${transposed.length} transposition(s) — two ERP lines carrying each other's item, found BY KEY.`);
    for (const t of transposed) {
      plain(`   ${t.doc} (${t.pair})`);
      plain(`      line ${t.a.dk}: the book says ${t.a.book} (-> ${t.a.want}), we hold ${t.a.got}`);
      plain(`      line ${t.b.dk}: the book says ${t.b.book} (-> ${t.b.want}), we hold ${t.b.got}`);
      plain('      Each line holds the OTHER line\'s item. Swapping the two item codes closes it.');
    }
  }

  if (unkeyed.length) {
    plain('');
    note(`${unkeyed.length} ERP receipt line(s) carry NO AutoCount line key and were NOT compared.`);
    plain('   They are named, not guessed at by position — that guess is what put a REGAL in front of a');
    plain('   customer whose book line said TRION.');
    for (const u of unkeyed.slice(0, SHOW)) plain(`     ${u.doc}  ${u.item}  qty ${u.qty}`);
    if (unkeyed.length > SHOW) plain(`     ... ${unkeyed.length - unkeyed.length + unkeyed.length - SHOW} more`);
  }

  plain('');
  plain('═════════ 一句话 ═════════');
  note(differing.length === 0
    ? `GOODS RECEIPTS LINE UP with the account book, line by line, across ${heads.length} documents.`
    : `${differing.length} goods-receipt pair(s) differ on a LINE. Each one is named above with both sides' `
      + 'arithmetic; none of them is explained by a receipt spanning several purchase orders.');

  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch(async (e) => {
  console.error(`REFUSED: ${e?.message ?? e}`);
  try { await sql.end({ timeout: 5 }); } catch { /* the connection is already gone */ }
  process.exit(2);
});
