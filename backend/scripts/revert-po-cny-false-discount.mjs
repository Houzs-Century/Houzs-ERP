#!/usr/bin/env node
/* Revert the FABRICATED line discount that repair-po-line-discount wrote onto
 * HC-PO-009335, a purchase order denominated in CHINESE YUAN.
 *
 * WHAT HAPPENED, traced. `repair-po-line-discount.yml` ran against production on
 * 2026-09-07 (run 34116301278) and corrected 89 lines across 10 purchase orders.
 * Nine of those orders are right. The tenth is not, and the reason is currency:
 *
 *   PO-009335       currency CNY  rate 0.619380  Total 34,334.90 CNY  LocalNetTotal 21,266.35 MYR
 *   the other nine  currency MYR  rate 1.000000
 *
 * `export-ac-reconcile-truth.mjs:196` exports `ISNULL(h.LocalNetTotal, h.NetTotal)`
 * and `:224` exports `ISNULL(d.LocalSubTotal, d.SubTotal)` — the LOCAL-currency
 * (MYR) figures. The ERP holds the DOCUMENT-currency figures, and
 * `import-ac-outstanding-po.mjs:401` hard-codes 'MYR' into
 * `purchase_orders.currency` regardless of what the book says. So on a non-MYR
 * document the repair compared MYR against CNY, found the ERP "higher", and
 * booked the difference as a discount. 34,334.90 x 0.61938 = 21,266.35 — the
 * "38.06% discount" it reported IS the exchange rate.
 *
 * Read live from AED_HOUZS, all five lines of this document carry
 * `DiscountAmt = 0.00` and `SubTotal = Qty x UnitPrice` exactly. THERE IS NO
 * DISCOUNT ON THIS DOCUMENT. The repair wrote RM 13,068.55 of discount that the
 * book does not state, and pushed the header from 34,334.90 down to 21,266.35.
 *
 * WHAT THIS WRITES. `discount_sen = 0` and `line_total_sen = qty x unit_price_sen`
 * on the five lines, and the header re-summed over EVERY line of the order --
 * the same three-part shape the repair used, and for the same reason:
 * `mfg-purchase-orders.ts:3042` computes `lineTotal = max(0, qty*unit - discount)`
 * on every edit, so a line total put back without the discount beside it is
 * undone by the next person who touches that line in the UI. A partial revert
 * is self-erasing.
 *
 * WHAT THIS DOES NOT TOUCH. `unit_price_sen` -- the repair never changed it, and
 * AutoCount's own UnitPrice is what the ERP holds. `currency` stays 'MYR': this
 * script's job is to put back what was taken, not to re-denominate a live
 * purchase order, which is an owner decision with GRN / PI / PV consequences.
 * Stock cost did not move in either direction (`grns.ts:555` costs a receipt at
 * the UNDISCOUNTED unit price), and no goods receipt or purchase invoice already
 * raised is reached into.
 *
 * EVERY VALUE IS CROSS-CHECKED, NOT ASSUMED. `EXPECT` below carries, per
 * AutoCount DtlKey, the book's own qty / unit price / document-currency amount
 * AND the exact wrong pair the repair wrote (read out of run 34116301278's log).
 * A row that does not match its entry is REFUSED and printed -- never written
 * past. The target line total is COMPUTED from the ERP row's own
 * qty x unit_price_sen and then asserted against the book's amount, so two
 * independent statements of the same number have to agree before anything moves.
 *
 * MODE=plan (default) prints and writes nothing.
 * MODE=apply needs CONFIRM="I HAVE REVIEWED THE PO-009335 CNY REVERT".
 *
 * RE-RUN: idempotent. Every write is guarded on the row still holding the exact
 * values the plan read. A second run finds discount 0 and the line total already
 * equal to qty x unit price, plans nothing, and writes nothing.
 */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const AC_DOCNO = process.env.AC_DOCNO || 'PO-009335';
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE PO-009335 CNY REVERT';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" -- refusing to write.`);
  process.exit(2);
}

const rm = (s) => `RM ${(s / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s, n) => String(s).padEnd(n);

/* AutoCount PO-009335, read live from AED_HOUZS on 2026-09-07: five lines, every
   one of them DiscountAmt = 0.00 and SubTotal = Qty x UnitPrice. `wasDiscount` /
   `wasLineTotal` are what run 34116301278 wrote over them. */
const EXPECT = new Map([
  ['851335', { item: 'JM-CL JAC WP MP (K)', qty: 240, unitSen: 6854, bookSen: 1644960, wasDiscount: 626105, wasLineTotal: 1018855 }],
  ['851336', { item: 'JM-CL JAC WP MP (Q)', qty: 230, unitSen: 5965, bookSen: 1371950, wasDiscount: 522192, wasLineTotal: 849758 }],
  ['851337', { item: 'JM-CL JAC WP MP (SS)', qty: 40, unitSen: 4618, bookSen: 184720, wasDiscount: 70308, wasLineTotal: 114412 }],
  ['851338', { item: 'JM-CL JAC WP MP (SK)', qty: 20, unitSen: 7437, bookSen: 148740, wasDiscount: 56613, wasLineTotal: 92127 }],
  ['851339', { item: 'JM-CL JAC WP MP (S)', qty: 20, unitSen: 4156, bookSen: 83120, wasDiscount: 31637, wasLineTotal: 51483 }],
]);
const BOOK_TOTAL_SEN = 3433490;     // RM 34,334.90 -- the header AutoCount states, in CNY
const FALSE_DISCOUNT_SEN = 1306855; // RM 13,068.55 -- what the repair took off

const sen = (v) => (v == null ? 0 : Math.round(Number(v)));

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} document=${AC_DOCNO}`);
  note(`AutoCount ${AC_DOCNO} is a CNY document: Total 34,334.90 CNY at rate 0.619380 = 21,266.35 MYR.`);
  note(`Its five lines all carry DiscountAmt 0.00. The repair booked ${rm(FALSE_DISCOUNT_SEN)} that the book does not state.`);

  const rowsRead = await sql`
    SELECT h.id::text          AS po_id,
           h.po_number         AS po_number,
           h.linked_ac_docno   AS ac_no,
           h.currency          AS currency,
           h.status            AS status,
           h.subtotal_sen::bigint AS hdr_subtotal_sen,
           h.total_sen::bigint    AS hdr_total_sen,
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
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ${AC_DOCNO}
     ORDER BY i.linked_ac_dtlkey, i.id`;

  if (!rowsRead.length) {
    bad(`REFUSED: the ERP holds no purchase order with linked_ac_docno = ${AC_DOCNO} in company ${CO}.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  const poIds = new Set(rowsRead.map((r) => r.po_id));
  if (poIds.size !== 1) {
    bad(`REFUSED: ${poIds.size} purchase orders carry linked_ac_docno = ${AC_DOCNO}. This revert names ONE document.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  const hdr = {
    poId: rowsRead[0].po_id,
    poNumber: rowsRead[0].po_number,
    currency: rowsRead[0].currency,
    status: rowsRead[0].status,
    hdrSubtotal: sen(rowsRead[0].hdr_subtotal_sen),
    hdrTotal: sen(rowsRead[0].hdr_total_sen),
  };
  const lines = rowsRead.map((r) => ({
    itemId: r.item_id,
    dtlKey: r.dtlkey == null ? null : String(r.dtlkey).trim(),
    itemCode: r.item_code,
    qty: Number(r.qty),
    unitSen: sen(r.unit_price_sen),
    discountSen: sen(r.discount_sen),
    lineTotalSen: sen(r.line_total_sen),
    receivedQty: Number(r.received_qty ?? 0),
  }));

  plain('');
  plain(`${hdr.poNumber} (${AC_DOCNO})  status ${hdr.status}  ERP currency field ${hdr.currency}  lines ${lines.length}`);
  plain(`  header NOW: subtotal ${rm(hdr.hdrSubtotal)}  total ${rm(hdr.hdrTotal)}`);
  plain('');

  /* -- the plan ---------------------------------------------------------- */
  const writes = [];
  const refusals = [];
  const seen = new Set();

  for (const l of lines) {
    /* A line this revert does not name is left exactly as it is. It still counts
       toward the header sum below, which is why every line is read. */
    if (!l.dtlKey || !EXPECT.has(l.dtlKey)) continue;
    seen.add(l.dtlKey);
    const e = EXPECT.get(l.dtlKey);

    if (Math.round(l.qty) !== e.qty || l.unitSen !== e.unitSen) {
      refusals.push(
        `DtlKey ${l.dtlKey} ${l.itemCode ?? e.item}: the ERP line is ${l.qty} x ${rm(l.unitSen)} but AutoCount says ` +
        `${e.qty} x ${rm(e.unitSen)}. Quantity or price has moved since the repair -- REFUSED, this revert states neither.`,
      );
      continue;
    }
    /* Two independent statements of the target, required to agree: the ERP row's
       own arithmetic, and AutoCount's stated line amount. */
    const targetLineTotal = Math.round(l.qty * l.unitSen);
    if (targetLineTotal !== e.bookSen) {
      refusals.push(
        `DtlKey ${l.dtlKey} ${l.itemCode ?? e.item}: qty x unit price = ${rm(targetLineTotal)} but the book states ` +
        `${rm(e.bookSen)}. The two do not agree -- REFUSED.`,
      );
      continue;
    }
    if (l.discountSen === 0 && l.lineTotalSen === targetLineTotal) {
      plain(`  ALREADY CORRECT  DtlKey ${l.dtlKey} ${pad(l.itemCode ?? e.item, 22)} discount ${rm(0)}  line total ${rm(targetLineTotal)}`);
      continue;
    }
    if (l.discountSen !== e.wasDiscount || l.lineTotalSen !== e.wasLineTotal) {
      refusals.push(
        `DtlKey ${l.dtlKey} ${l.itemCode ?? e.item}: the row holds discount ${rm(l.discountSen)} / line total ${rm(l.lineTotalSen)}, ` +
        `and run 34116301278 wrote ${rm(e.wasDiscount)} / ${rm(e.wasLineTotal)}. Somebody has edited this line since -- ` +
        'REFUSED, reverting it would overwrite their work.',
      );
      continue;
    }
    writes.push({
      itemId: l.itemId, dtlKey: l.dtlKey, itemCode: l.itemCode ?? e.item,
      qty: l.qty, unitSen: l.unitSen, receivedQty: l.receivedQty,
      discountSen: 0, lineTotalSen: targetLineTotal,
      wasDiscount: l.discountSen, wasLineTotal: l.lineTotalSen,
    });
  }

  for (const k of EXPECT.keys()) {
    if (!seen.has(k)) {
      refusals.push(`DtlKey ${k} ${EXPECT.get(k).item}: the ERP holds no line on ${hdr.poNumber} carrying that AutoCount key -- REFUSED.`);
    }
  }

  /* The header, re-summed the way recomputePoTotals does it: SUM(line_total_sen)
     over EVERY line of the order, written to both subtotal_sen and total_sen. */
  const planned = new Map(writes.map((w) => [w.itemId, w.lineTotalSen]));
  const plannedSubtotal = lines.reduce((s, l) => s + (planned.has(l.itemId) ? planned.get(l.itemId) : l.lineTotalSen), 0);

  plain('');
  plain('LINE BY LINE -- what this puts back:');
  for (const w of writes) {
    plain(
      `  DtlKey ${w.dtlKey}  ${pad(w.itemCode, 22)} qty ${String(w.qty).padStart(3)} @ ${String(rm(w.unitSen)).padStart(11)}  ` +
      `discount ${rm(w.wasDiscount)} -> ${rm(w.discountSen)}   line total ${rm(w.wasLineTotal)} -> ${rm(w.lineTotalSen)}` +
      (w.receivedQty > 0 ? `   [${w.receivedQty} already received]` : ''),
    );
  }
  plain('');
  plain(`  header ${rm(hdr.hdrTotal)} -> ${rm(plannedSubtotal)}   (AutoCount states ${rm(BOOK_TOTAL_SEN)})`);
  plain('');

  if (refusals.length) {
    plain('REFUSED -- printed in full, never guessed at:');
    for (const r of refusals) bad(`  ${r}`);
    plain('');
  }

  if (!writes.length) {
    note('Nothing to write: every named line already reads discount RM 0.00 with the line total AutoCount states.');
    if (plannedSubtotal !== hdr.hdrTotal || plannedSubtotal !== hdr.hdrSubtotal) {
      bad(`  but the header reads ${rm(hdr.hdrTotal)} while its lines sum to ${rm(plannedSubtotal)} -- the header is still wrong.`);
    }
    await sql.end({ timeout: 5 });
    if (refusals.length) process.exit(2);
    return;
  }

  /* The one assertion this revert exists for. */
  if (plannedSubtotal !== BOOK_TOTAL_SEN) {
    bad(
      `REFUSED: after this revert the header would read ${rm(plannedSubtotal)}, and AutoCount states ${rm(BOOK_TOTAL_SEN)}. ` +
      'Those must be equal. Nothing written.',
    );
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  if (refusals.length) {
    bad('REFUSED: this revert writes all five lines of one document or none of them. Nothing written.');
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  note(`Plan: ${writes.length} line(s) back to discount RM 0.00, header ${rm(hdr.hdrTotal)} -> ${rm(plannedSubtotal)}, restoring ${rm(FALSE_DISCOUNT_SEN)}.`);

  if (!APPLY) {
    note(`PLAN ONLY -- nothing written. To apply: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
    await sql.end({ timeout: 5 });
    return;
  }

  /* -- the write --------------------------------------------------------- */
  plain('');
  note(`=== APPLYING ${writes.length} line(s) and 1 header ===`);
  let wroteLines = 0;
  for (const w of writes) {
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
    if (!back.length) bad(`  SKIP DtlKey ${w.dtlKey} ${w.itemCode} -- the row no longer holds the values the plan read`);
  }
  note(`  lines written: ${wroteLines} of ${writes.length}`);

  const hb = await sql`
    UPDATE scm.purchase_orders
       SET subtotal_sen = ${plannedSubtotal}, total_sen = ${plannedSubtotal}, updated_at = now()
     WHERE id = ${hdr.poId}::uuid
       AND company_id = ${CO}
       AND subtotal_sen = ${hdr.hdrSubtotal}
       AND total_sen = ${hdr.hdrTotal}
     RETURNING po_number`;
  note(`  headers written: ${hb.length} of 1`);
  if (!hb.length) bad(`  SKIP header ${hdr.poNumber} -- it no longer holds the totals the plan read`);

  await sql.end({ timeout: 5 });

  /* -- verified on a FRESH connection, on the SHAPE ----------------------- */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let redFlags = 0;
  try {
    plain('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    const back = await check`
      SELECT h.po_number, h.subtotal_sen::bigint AS subtotal_sen, h.total_sen::bigint AS total_sen,
             i.linked_ac_dtlkey::text AS dtlkey, i.item_code,
             i.qty::float8 AS qty, i.unit_price_sen::bigint AS unit_price_sen,
             i.discount_sen::bigint AS discount_sen, i.line_total_sen::bigint AS line_total_sen
        FROM scm.purchase_orders h
        JOIN scm.purchase_order_items i ON i.purchase_order_id = h.id
       WHERE h.id = ${hdr.poId}::uuid
       ORDER BY i.linked_ac_dtlkey, i.id`;
    let lineSum = 0;
    for (const r of back) {
      lineSum += sen(r.line_total_sen);
      const key = r.dtlkey == null ? null : String(r.dtlkey).trim();
      const e = key ? EXPECT.get(key) : null;
      const shape = Math.round(Number(r.qty) * sen(r.unit_price_sen)) - sen(r.discount_sen);
      const okShape = shape === sen(r.line_total_sen);
      const okBook = !e || sen(r.line_total_sen) === e.bookSen;
      const okDisc = !e || sen(r.discount_sen) === 0;
      if (!okShape || !okBook || !okDisc) redFlags++;
      (okShape && okBook && okDisc ? note : bad)(
        `  DtlKey ${key ?? '-'} ${pad(r.item_code ?? '-', 22)} qty ${String(r.qty).padStart(3)} @ ${String(rm(sen(r.unit_price_sen))).padStart(11)} ` +
        `- discount ${rm(sen(r.discount_sen))} = ${rm(sen(r.line_total_sen))}` +
        (okShape ? '' : `  [INVARIANT BROKEN: qty*unit - discount = ${rm(shape)}]`) +
        (okBook ? '' : `  [AutoCount states ${rm(e.bookSen)}]`) +
        (okDisc ? '' : '  [discount is not zero]'),
      );
    }
    const h0 = back[0];
    const okHdr = sen(h0.total_sen) === lineSum && sen(h0.subtotal_sen) === lineSum && lineSum === BOOK_TOTAL_SEN;
    if (!okHdr) redFlags++;
    (okHdr ? note : bad)(
      `  ${h0.po_number}: header subtotal ${rm(sen(h0.subtotal_sen))}, total ${rm(sen(h0.total_sen))}, sum of its ${back.length} line(s) ${rm(lineSum)}, ` +
      `AutoCount states ${rm(BOOK_TOTAL_SEN)}${okHdr ? '' : ' -- THESE DISAGREE'}`,
    );
    (redFlags ? bad : note)(
      redFlags
        ? `REVERT INCOMPLETE: ${redFlags} check(s) failed. Read the lines above before touching this document again.`
        : `REVERT VERIFIED: ${h0.po_number} reads ${rm(sen(h0.total_sen))}, discount RM 0.00 on all five lines. ${rm(FALSE_DISCOUNT_SEN)} restored.`,
    );
  } finally {
    await check.end({ timeout: 5 });
  }
  if (redFlags) process.exit(1);
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
