#!/usr/bin/env node
/* AutoCount's PO line DISCOUNT, copied into the ERP.
 *
 * WHAT IS WRONG. AutoCount stores `PODTL.UnitPrice` and `PODTL.SubTotal` as two
 * separate columns and the discount lives in the gap between them: SubTotal is
 * the DISCOUNTED amount, UnitPrice is not. Every purchase-order importer here
 * computes the line amount itself out of the undiscounted half —
 * `import-ac-outstanding-po.mjs:230` (`const lt = up * qty`), `:379`
 * (`subtotal_sen` / `total_sen` are that same sum) and
 * `import-ac-so-linked-pos.mjs:403` (`${it.qty * it.priceSen}`) — so a migrated
 * purchase order OVERSTATES what we owe the supplier. Worked example, verified:
 * PO-009948 carries a unit price of RM 1,880.00 on a line the book totals at
 * RM 1,410.00, exactly 75%. Ledger entry:
 * docs/bugs/0662-autocount-po-line-discounts-are-dropped-the-erp-stores-qty-x.md
 *
 * WHAT THIS WRITES, AND WHY IT IS NOT JUST THE LINE TOTAL. The obvious smaller
 * repair — correct `line_total_sen` and leave `discount_sen` at 0 — is
 * SELF-ERASING, and that is read off the write path rather than assumed:
 *
 *   mfg-purchase-orders.ts:3042   line ADD:  lineTotal = max(0, qty*unit - discountSen)
 *   mfg-purchase-orders.ts:3169   line EDIT: the same, from `it.discountSen ?? prev.discount_sen`
 *   mfg-purchase-orders.ts:2798   recomputePoTotals: subtotal_sen = total_sen = SUM(line_total_sen)
 *
 * So the ERP's own invariant is `line_total_sen = qty*unit - discount`. A line
 * total written without the discount beside it breaks that invariant, and the
 * NEXT edit anybody makes to that line through the UI recomputes the total from
 * qty, unit price and a discount of zero — quietly restoring the overstated
 * figure. Writing all three (discount, line total, header) is the only version
 * that both matches AutoCount and survives the next person touching the order.
 *
 * WHAT THIS DOES NOT TOUCH, said plainly:
 *   * `unit_price_sen` — AutoCount's own UnitPrice IS 1,880.00 on that line.
 *     Copy, never compute (memory: migration-copy-never-compute).
 *   * STOCK COST. `grns.ts:555` costs a receipt at
 *     `toMyrSen(unit_price_sen, rate)` — the UNDISCOUNTED unit price — so
 *     inventory valuation does not move in either direction. This repair
 *     changes what we OWE, not what the goods are carried at.
 *   * GRNs and purchase invoices ALREADY RAISED. `grns.ts:1872` copies
 *     `discount_sen` off the PO line at CONVERSION time, so a receipt raised
 *     AFTER this repair inherits the right money and one raised before it keeps
 *     its own. Those are separate documents with their own totals; correcting
 *     them is not this script's business and it says so rather than reaching.
 *   * `scm.po_revisions`. This is a data correction, not a business amendment,
 *     so it takes no revision snapshot — the same choice every other repair in
 *     this directory makes.
 *
 * THE OWNER'S BLANK RULE, 2026-09-07: 「保留 ERP 的价钱 — 空白不覆盖」. A blank in
 * the book NEVER overwrites a value in the ERP. A book line missing its qty,
 * its unit price or its SubTotal is SKIPPED and printed, never treated as zero
 * — which is what turns a missing export column into a free RM 0.00 line.
 *
 * ONE AUTOCOUNT LINE MUST MEET ONE PRICED ERP LINE. A sofa line decomposes into
 * one ERP row per compartment, all sharing `linked_ac_dtlkey`, with only the
 * lead piece carrying the price. Spreading one discount across such a group
 * would subtract it once per compartment. So the group is checked, not assumed:
 * a DtlKey whose ERP side has anything other than exactly one priced row is
 * REFUSED and printed in full. (Measured on the 2026-09-07 cut, all 21 item
 * codes on the ten in-scope orders are mattresses, so no group is expected to
 * decompose — the refusal is there for the day that stops being true.)
 *
 * ⚠ CURRENCY IS A REFUSAL, NOT A CONVERSION — added 2026-09-07 after this
 * script moved money it should not have. `PO-009335` is denominated in CHINESE
 * YUAN at 0.619380. The snapshot carried `LocalNetTotal` / `LocalSubTotal`, the
 * MYR figures; the ERP holds the document's own CNY figures and
 * `import-ac-outstanding-po.mjs:401` hard-codes 'MYR' into the currency column
 * regardless. So this script compared MYR against CNY, saw the ERP as 38.06%
 * "higher", and wrote RM 13,068.55 of discount AutoCount does not state — the
 * book's five lines all read `DiscountAmt = 0.00`. 34,334.90 x 0.61938 =
 * 21,266.35: the discount WAS the exchange rate.
 * Reverted by `revert-po-cny-false-discount.mjs`. Ledger: docs/bugs/0665-*.md.
 *
 * A discount and an exchange rate are not distinguishable from a total alone.
 * So a document that is not MYR at rate 1 is REFUSED and listed, never
 * repaired, and a snapshot that carries no currency at all REFUSES THE WHOLE
 * RUN — a script that cannot see the currency cannot claim a document does not
 * have one. On the 2026-09-07 book that is 22 CNY purchase orders out of 9,412,
 * of which exactly 1 is in the migrated scope.
 *
 * MODE=plan (default) prints, per document, the ERP total NOW, the AutoCount
 * total and the difference, and writes nothing.
 * MODE=apply needs CONFIRM="I HAVE REVIEWED THE PO DISCOUNT PLAN".
 *
 * RE-RUN: idempotent. Every write is guarded on the row still holding the exact
 * values the plan read, and the second run finds the line already equal to the
 * book's own amount, so it plans zero changes and writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import postgres from 'postgres';

import { buildScope, decodeSnapshot } from './lib/ac-scope.mjs';
/* Every decision this script makes is in lib/po-discount-plan.mjs, and it is
   there because every INTERESTING decision is a REFUSAL that cannot be
   exercised against production without first creating the damage there.
   Pure, it is a test with a planted defect. */
import { planDocument, readBookDiscounts, repairPopulation } from './lib/po-discount-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const TRUTH = 'ac-reconcile-truth.json.gz';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE PO DISCOUNT PLAN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}

const rm = (sen) => `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

/* The book, from the committed snapshot. It is REFUSED when stale rather than
   answered against: a discount plan computed from last week's book would move
   money on a figure nobody can point at. */
function loadBook() {
  const p = path.join(DATA, TRUTH);
  if (!fs.existsSync(p)) {
    bad(`backend/scripts/data/${TRUTH} is missing. Cut it on a machine on the office network:`);
    bad('  AC_CRED_FILE=<path> node backend/scripts/export-ac-reconcile-truth.mjs');
    process.exit(2);
  }
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8').replace(/^﻿/, ''));
  const ageDays = (Date.now() - Date.parse(snap.exported_at)) / 86400000;
  return { snap, ageDays };
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  const { snap, ageDays } = loadBook();
  note(`AutoCount snapshot ${snap.exported_at} (${ageDays.toFixed(2)} days old, limit ${MAX_AGE}), source ${snap.source}`);
  /* Negative age is a CLOCK problem, not a fresh snapshot: the exporter runs on
     a UTC+8 desktop and this runs on a UTC runner. A small skew is tolerated;
     a large one means the two disagree about when now is. */
  if (ageDays > MAX_AGE || ageDays < -0.5) {
    bad(`REFUSED: that snapshot is ${ageDays.toFixed(2)} days old. Re-cut it before moving money against it.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  const book = decodeSnapshot(snap);
  const scope = buildScope(book);

  /* THE POPULATION IS WHAT THE ERP HOLDS, NOT WHAT IS STILL IN SCOPE — read
     from the database BEFORE the book is filtered, because filtering by the
     scope is the defect. See `repairPopulation` and docs/bugs/0693-*.md: a
     purchase order stops being OUTSTANDING once its goods arrive, and our copy
     of it, discount and all, stays exactly where it is. */
  const heldRows = await sql`SELECT DISTINCT linked_ac_docno AS ac_no
      FROM scm.purchase_orders
     WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const { population, counts } = repairPopulation(scope.PO, heldRows.map((r) => r.ac_no));

  /* The AutoCount side: every PO line whose own amount differs from
     qty x unit price. That difference IS the discount — the book states no
     other place for it. */
  const {
    byDoc: bookDiscount, skipped: bookSkipped, currencyRefused, whole, inScope,
  } = readBookDiscounts(book.PO.lines, population, book.PO.headers);

  note('');
  note(`WHOLE BOOK: ${whole.lines} discounted line(s) across ${whole.docs.size} purchase order(s), ${rm(whole.sen)}.`);
  note(
    `POPULATION: ${population.size} purchase order(s) — ${counts.inScope} still in the outstanding scope, ` +
    `${counts.erpHeld} held by the ERP, of which ${counts.heldButOutOfScope} are held but NO LONGER IN SCOPE ` +
    `(they were outstanding when they were imported and their goods have since arrived — the scope moved, our copy did not). ` +
    `${counts.inScopeButNotHeld} are in scope and the ERP does not hold them.`,
  );
  note(`CARRYING A DISCOUNT, IN THAT POPULATION: ${inScope.lines} line(s) across ${inScope.docs} purchase order(s), ${rm(inScope.sen)}.`);

  /* THE CURRENCY GATE, printed before anything else it might affect. A document
     that is not MYR at rate 1 never reached the discount rule at all — see
     lib/po-discount-plan.mjs `currencyVerdict`, and docs/bugs/0665-*.md for the
     RM 13,068.55 this exists to have prevented. */
  if (currencyRefused.length) {
    const unknown = currencyRefused.filter((r) => r.kind === 'unknown');
    plain('');
    bad(`CURRENCY: ${currencyRefused.length} in-scope purchase order(s) REFUSED — a discount and an exchange rate are not`);
    bad('  distinguishable from a total alone, so this script does not try. Repair them by hand or not at all.');
    for (const r of currencyRefused) bad(`     ${r.docNo}: ${r.why}`);
    if (unknown.length) {
      plain('');
      bad(
        `REFUSING THE WHOLE RUN: ${unknown.length} in-scope document(s) have no currency in this snapshot. ` +
        'A script that cannot see the currency cannot claim a document does not have one. Re-cut the snapshot with ' +
        'AC_CRED_FILE=<path> node backend/scripts/export-ac-reconcile-truth.mjs and run this again.',
      );
      await sql.end({ timeout: 5 });
      process.exit(2);
    }
  }

  if (bookSkipped.length) {
    plain(`  ${bookSkipped.length} in-scope book line(s) SKIPPED because the book states no amount (blank never overwrites):`);
    for (const s of bookSkipped.slice(0, 10)) plain(`     ${s}`);
  }
  if (!bookDiscount.size) {
    note('\nNo in-scope purchase order carries a line discount on this cut. Nothing to do.');
    await sql.end({ timeout: 5 });
    return;
  }

  /* The ERP side. Read as the numbers they are, plus the identity a refusal
     needs, for exactly the documents the book named. */
  const docNos = [...bookDiscount.keys()].sort();
  const erpLines = await sql`
    SELECT h.id::text          AS po_id,
           h.po_number         AS po_number,
           h.linked_ac_docno   AS ac_no,
           h.subtotal_sen::bigint AS hdr_subtotal_sen,
           h.total_sen::bigint    AS hdr_total_sen,
           h.status            AS status,
           i.id::text          AS item_id,
           i.linked_ac_dtlkey::text AS dtlkey,
           i.item_code         AS item_code,
           i.qty::float8       AS qty,
           i.unit_price_sen::bigint AS unit_price_sen,
           i.discount_sen::bigint   AS discount_sen,
           i.line_total_sen::bigint AS line_total_sen,
           i.received_qty::float8   AS received_qty
      FROM scm.purchase_orders h
      JOIN scm.purchase_order_items i ON i.purchase_order_id = h.id
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${docNos})
     ORDER BY h.po_number, i.linked_ac_dtlkey, i.id`;

  const byDoc = new Map(); // acNo -> { po_id, po_number, hdr..., lines: [] }
  for (const r of erpLines) {
    const ac = String(r.ac_no).trim();
    if (!byDoc.has(ac)) {
      byDoc.set(ac, {
        acNo: ac, poId: r.po_id, poNumber: r.po_number, status: r.status,
        hdrSubtotal: Number(r.hdr_subtotal_sen), hdrTotal: Number(r.hdr_total_sen), lines: [],
      });
    }
    byDoc.get(ac).lines.push({
      itemId: r.item_id, dtlKey: r.dtlkey == null ? null : String(r.dtlkey).trim(),
      itemCode: r.item_code, qty: Number(r.qty),
      unitSen: Number(r.unit_price_sen), discountSen: Number(r.discount_sen ?? 0),
      lineTotalSen: Number(r.line_total_sen ?? 0), receivedQty: Number(r.received_qty ?? 0),
    });
  }

  /* ── the plan, per document ─────────────────────────────────────────── */
  const writes = [];      // { itemId, poId, discountSen, lineTotalSen, wasDiscount, wasLineTotal }
  const headers = [];     // { poId, poNumber, subtotalSen, totalSen, wasSubtotal, wasTotal }
  const refusals = [];
  const absent = [];
  const table = [];

  for (const acNo of docNos) {
    const doc = byDoc.get(acNo);
    if (!doc) { absent.push(acNo); continue; }
    const wantByKey = bookDiscount.get(acNo);

    const p = planDocument({ wantByKey, doc, rm });

    table.push({
      poNumber: doc.poNumber, acNo, status: doc.status,
      lines: doc.lines.length, discounted: wantByKey.size, refused: p.refusals.length,
      received: doc.lines.filter((l) => l.receivedQty > 0).length,
      erpNow: doc.hdrTotal, acTotal: book.PO.headers.get(acNo)?.totalSen ?? null,
      planned: p.plannedSubtotal, hdrSubtotalNow: doc.hdrSubtotal,
    });

    writes.push(...p.writes);
    refusals.push(...p.refusals);
    if (p.header) headers.push(p.header);
  }

  /* ── the table the owner reads ──────────────────────────────────────── */
  plain('');
  plain('═══════════ PER DOCUMENT: WHAT THE ERP SAYS NOW, WHAT AUTOCOUNT SAYS ═══════════');
  plain('');
  plain('PO (ERP)        AutoCount    lines disc recv     ERP total now    AutoCount total       difference');
  let sumNow = 0; let sumAc = 0; let sumDiff = 0;
  for (const t of table.sort((a, b) => (b.erpNow - (b.acTotal ?? 0)) - (a.erpNow - (a.acTotal ?? 0)))) {
    const diff = t.acTotal == null ? null : t.erpNow - t.acTotal;
    if (diff != null) { sumNow += t.erpNow; sumAc += t.acTotal; sumDiff += diff; }
    plain(
      `${pad(t.poNumber, 15)} ${pad(t.acNo, 12)} ${rpad(t.lines, 5)}${rpad(t.discounted, 5)}${rpad(t.received, 5)}` +
      `${rpad(rm(t.erpNow), 17)}${rpad(t.acTotal == null ? '(not in the cut)' : rm(t.acTotal), 19)}${rpad(diff == null ? '-' : rm(diff), 17)}`,
    );
    if (t.planned !== t.acTotal && t.acTotal != null) {
      plain(`${' '.repeat(16)}after this repair the ERP header would read ${rm(t.planned)}, and the book says ${rm(t.acTotal)}`);
    }
    if (t.refused) plain(`${' '.repeat(16)}${t.refused} of its ${t.discounted} discounted line(s) REFUSED — see below; the header figure above excludes them`);
  }
  plain('');
  plain(`${pad('TOTAL', 28)}${rpad(table.length + ' doc(s)', 15)}${rpad(rm(sumNow), 17)}${rpad(rm(sumAc), 19)}${rpad(rm(sumDiff), 17)}`);
  plain('');
  note(`The ERP overstates these ${table.length} purchase order(s) by ${rm(sumDiff)} against AutoCount.`);
  note(`Lines to correct: ${writes.length}. Headers to recompute: ${headers.length}. Refused: ${refusals.length}. In the population but absent from the ERP: ${absent.length}.`);
  const withReceipts = table.filter((t) => t.received > 0);
  if (withReceipts.length) {
    note(
      `${withReceipts.length} of these order(s) already have received line(s). This repair corrects the PURCHASE ORDER only — ` +
      'a goods receipt or purchase invoice already raised keeps its own total, and stock cost is unaffected either way ' +
      '(a receipt is costed at the UNDISCOUNTED unit price, grns.ts:555).',
    );
  }

  if (refusals.length) {
    plain('');
    plain('REFUSED — printed in full, never guessed at:');
    for (const r of refusals) bad(`  ${r}`);
  }
  for (const a of absent) bad(`  ${a}: the book discounts a line on it and the ERP holds no purchase order with that linked_ac_docno`);

  plain('');
  plain('LINE BY LINE:');
  for (const w of writes) {
    plain(
      `  ${pad(w.poNumber, 15)} ${pad(w.itemCode ?? '-', 24)} qty ${rpad(w.qty, 3)} @ ${rpad(rm(w.unitSen), 13)}  ` +
      `discount ${rm(w.wasDiscount)} -> ${rm(w.discountSen)}   line total ${rm(w.wasLineTotal)} -> ${rm(w.lineTotalSen)}` +
      (w.receivedQty > 0 ? `   [${w.receivedQty} already received]` : ''),
    );
  }

  if (!APPLY) {
    plain('');
    note(`PLAN ONLY — nothing written. To apply: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
    await sql.end({ timeout: 5 });
    return;
  }

  /* ── the write ──────────────────────────────────────────────────────── */
  plain('');
  note(`=== APPLYING ${writes.length} line(s) and ${headers.length} header(s) ===`);
  let wroteLines = 0;
  for (const w of writes) {
    /* Guarded on the row still holding exactly what the plan read. A row a
       person edited between the plan and the apply is SKIPPED, not overwritten
       — the same per-value refusal sync-ac-delta's header lane uses. */
    const back = await sql`
      UPDATE scm.purchase_order_items
         SET discount_sen = ${w.discountSen}, line_total_sen = ${w.lineTotalSen}
       WHERE id = ${w.itemId}::uuid
         AND company_id = ${CO}
         AND COALESCE(discount_sen, 0) = ${w.wasDiscount}
         AND COALESCE(line_total_sen, 0) = ${w.wasLineTotal}
         AND unit_price_sen = ${w.unitSen}
       RETURNING id::text AS id`;
    wroteLines += back.length;
    if (!back.length) bad(`  SKIP ${w.poNumber} ${w.itemCode} — the row no longer holds the values the plan read`);
  }
  note(`  lines written: ${wroteLines} of ${writes.length}`);

  let wroteHeaders = 0;
  for (const h of headers) {
    const back = await sql`
      UPDATE scm.purchase_orders
         SET subtotal_sen = ${h.subtotalSen}, total_sen = ${h.totalSen}, updated_at = now()
       WHERE id = ${h.poId}::uuid
         AND company_id = ${CO}
         AND subtotal_sen = ${h.wasSubtotal}
         AND total_sen = ${h.wasTotal}
       RETURNING po_number`;
    wroteHeaders += back.length;
    if (!back.length) bad(`  SKIP header ${h.poNumber} — the header no longer holds the totals the plan read`);
  }
  note(`  headers written: ${wroteHeaders} of ${headers.length}`);

  await sql.end({ timeout: 5 });

  /* ── verified on a FRESH connection, on the SHAPE ────────────────────── */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    plain('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    /* Not a row count. Three properties are re-read as VALUES and asserted:
         1. every corrected line satisfies the app's own invariant
            line_total_sen = qty*unit_price_sen - discount_sen;
         2. the line total now equals AutoCount's own amount for that line;
         3. the header total equals the sum of its lines, which is what
            recomputePoTotals would compute.
       A repair that reported "89 of 89" while producing the wrong shape is the
       precedent this exists for (docs/jsonb-double-encoding-coe.md). */
    const ids = writes.map((w) => w.itemId);
    const back = ids.length ? await check`
      SELECT i.id::text AS id, h.po_number,
             i.qty::float8 AS qty, i.unit_price_sen::bigint AS unit_price_sen,
             i.discount_sen::bigint AS discount_sen, i.line_total_sen::bigint AS line_total_sen
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
       WHERE i.id = ANY(${ids}::uuid[])` : [];
    const want = new Map(writes.map((w) => [w.itemId, w]));
    let invariantBroken = 0; let notBook = 0;
    for (const r of back) {
      const w = want.get(r.id);
      const lineShape = Math.round(Number(r.qty) * Number(r.unit_price_sen)) - Number(r.discount_sen);
      if (lineShape !== Number(r.line_total_sen)) {
        invariantBroken++;
        bad(`  ${r.po_number} ${r.id}: qty*unit - discount = ${lineShape} but line_total_sen reads ${r.line_total_sen}`);
      }
      if (Number(r.line_total_sen) !== w.lineTotalSen) {
        notBook++;
        bad(`  ${r.po_number} ${r.id}: line_total_sen reads ${rm(Number(r.line_total_sen))}, AutoCount says ${rm(w.lineTotalSen)}`);
      }
    }
    note(`  ${back.length} of ${writes.length} corrected line(s) re-read; invariant broken on ${invariantBroken}, disagreeing with the book on ${notBook}`);
    for (const r of back.slice(0, 10)) {
      note(`  ${r.po_number} ${r.id}: qty ${r.qty} @ ${rm(Number(r.unit_price_sen))} - ${rm(Number(r.discount_sen))} = ${rm(Number(r.line_total_sen))}`);
    }

    const poIds = [...new Set(headers.map((h) => h.poId))];
    const hdr = poIds.length ? await check`
      SELECT h.po_number, h.subtotal_sen::bigint AS subtotal_sen, h.total_sen::bigint AS total_sen,
             SUM(i.line_total_sen)::bigint AS line_sum
        FROM scm.purchase_orders h
        JOIN scm.purchase_order_items i ON i.purchase_order_id = h.id
       WHERE h.id = ANY(${poIds}::uuid[])
       GROUP BY h.po_number, h.subtotal_sen, h.total_sen
       ORDER BY h.po_number` : [];
    for (const r of hdr) {
      const ok = Number(r.total_sen) === Number(r.line_sum) && Number(r.subtotal_sen) === Number(r.line_sum);
      (ok ? note : bad)(`  ${r.po_number}: header total ${rm(Number(r.total_sen))}, sum of its lines ${rm(Number(r.line_sum))}${ok ? '' : ' — THESE DISAGREE'}`);
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
