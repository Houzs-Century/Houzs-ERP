/* so-discount-plan — the SALES-ORDER line-discount repair, decided as a pure
 * function. The sales-order twin of lib/po-discount-plan.mjs, and it exists for
 * the same reason: this repair moves money on LIVE sales orders and every
 * interesting decision it makes is a REFUSAL that cannot be exercised against
 * production without first creating the damage there.
 *
 * NO SHEBANG — imported by a test (CLAUDE.md: vitest inlines the source on
 * Windows and a `#!` off byte 0 is a SyntaxError at LOAD).
 *
 * THE DEFECT. AutoCount keeps a line discount in the gap between
 * `SODTL.UnitPrice` (undiscounted) and `SODTL.SubTotal` (the discounted
 * amount). `import-ac-outstanding-so.mjs` computes the line amount itself out
 * of the undiscounted half, so a migrated sales order OVERSTATES what the
 * customer owes. Worked example, measured on the 2026-09-08 08:03 Malaysia cut:
 *
 *   HC-SO-000021   book RM 9,876.00   ERP RM 10,852.00
 *     key 13555  DL-D.ULTIMATE SANTUARY (K)  1 x RM 9,298.00, book amount RM 9,099.00
 *     key 13556  DL-ECO COMFORT LATEX PILLOW 2 x RM   598.00, book amount RM   598.00
 *     key 13557  DL-MP(K)                    1 x RM   358.00, book amount RM   179.00
 *
 * RM 199.00 + RM 598.00 + RM 179.00 = RM 976.00, which is the difference to the
 * sen. It is the same shape as docs/bugs/0662 on the purchase side.
 *
 * THE ERP'S OWN INVARIANT, read off the write path rather than assumed:
 * `mfg-sales-orders.ts:4251` — `lineTotal = senOrZero((qty * unit) - discount)`
 * — with `total_sen`, `total_inc_sen` and `balance_sen` all set to it. So a line
 * amount written without the discount beside it is SELF-ERASING: the next edit
 * through the UI recomputes the total from a discount of zero and quietly
 * restores the overstated figure. All four columns move together, or none do.
 *
 * WHAT IS NEVER TOUCHED:
 *   `unit_price_sen` — AutoCount's own UnitPrice IS the undiscounted figure.
 *     Copy, never compute (memory: migration-copy-never-compute).
 *   The header's `paid_sen` and `balance_sen` — what a customer paid is a fact
 *     about the business, not an arithmetic consequence. Where a corrected total
 *     leaves them inconsistent the order is NAMED and the owner rules on it,
 *     exactly as repair-so-qty-from-autocount.mjs does.
 *
 * THE OWNER'S BLANK RULE, 空白不覆盖: a book line missing its quantity, its unit
 * price or its amount is SKIPPED and reported, never read as zero — reading an
 * absent column as 0.00 manufactures a 100% discount.
 */

/** Every sen figure is an integer; a float here is a money bug waiting. */
const sen = (v) => (v == null ? 0 : Math.round(Number(v)));

/**
 * The book side: every sales-order line whose own amount differs from
 * qty x unit price, restricted to `population` (see po-discount-plan's
 * `repairPopulation` — the population is what the ERP HOLDS, not what is still
 * outstanding). `bookHeaders` is REQUIRED so no caller can reach the discount
 * rule without the currency beside it.
 */
export function readBookSoDiscounts(bookSoLines, population, bookHeaders, currencyVerdict) {
  if (!(bookHeaders instanceof Map)) {
    throw new Error("readBookSoDiscounts needs the SO headers to read each document's currency — see docs/bugs/0665-*.md");
  }
  const byDoc = new Map();
  const skipped = [];
  const currencyRefused = [];
  const whole = { lines: 0, docs: new Set(), sen: 0 };

  for (const [docNo, lines] of bookSoLines) {
    const inPop = population.has(docNo);
    const verdict = inPop ? currencyVerdict(bookHeaders.get(docNo)) : null;
    const blocked = verdict != null && verdict.kind !== "local";
    if (blocked) currencyRefused.push({ docNo, kind: verdict.kind, why: verdict.why });
    for (const l of lines) {
      if (l.qty == null || l.unitPriceSen == null || l.subTotalSen == null) {
        if (inPop) skipped.push(`${docNo} DtlKey ${l.dtlKey} (${l.itemKey ?? "-"}): book qty=${l.qty} unit=${l.unitPriceSen} amount=${l.subTotalSen}`);
        continue;
      }
      const undiscSen = Math.round(l.qty * l.unitPriceSen);
      if (undiscSen === l.subTotalSen) continue;
      whole.lines++;
      whole.docs.add(docNo);
      whole.sen += undiscSen - l.subTotalSen;
      if (!inPop || blocked) continue;
      if (!byDoc.has(docNo)) byDoc.set(docNo, new Map());
      byDoc.get(docNo).set(String(l.dtlKey), {
        dtlKey: String(l.dtlKey), item: l.itemKey, qty: l.qty,
        unitSen: l.unitPriceSen, bookSen: l.subTotalSen, undiscSen,
      });
    }
  }
  const inPopulation = {
    docs: byDoc.size,
    lines: [...byDoc.values()].reduce((s, m) => s + m.size, 0),
    sen: [...byDoc.values()].reduce((s, m) => s + [...m.values()].reduce((t, x) => t + (x.undiscSen - x.bookSen), 0), 0),
  };
  return { byDoc, skipped, currencyRefused, whole, inPopulation };
}

/**
 * @param {object} a
 * @param {Map<string, object>} a.wantByKey  DtlKey -> {dtlKey, item, qty, unitSen, bookSen, undiscSen}
 * @param {object} a.doc  { acNo, docNo, hdrTotal, lines: [{itemId, dtlKey, itemCode, itemGroup, qty, unitSen, discountSen, totalSen, deliveredQty}] }
 */
export function planSoDocument({ wantByKey, doc, rm }) {
  const money = rm ?? ((s) => `RM ${(s / 100).toFixed(2)}`);
  const writes = [];
  const refusals = [];

  const byKey = new Map();
  for (const l of doc.lines) {
    if (!l.dtlKey) continue;
    if (!byKey.has(l.dtlKey)) byKey.set(l.dtlKey, []);
    byKey.get(l.dtlKey).push(l);
  }

  for (const [key, want] of wantByKey) {
    const group = byKey.get(key) ?? [];
    if (!group.length) {
      refusals.push(`${doc.docNo} (${doc.acNo}) DtlKey ${key} ${want.item ?? "-"}: the book discounts this line and the ERP has no line carrying that AutoCount key`);
      continue;
    }
    /* ONE AUTOCOUNT LINE MUST MEET ONE PRICED ERP LINE. A sofa line decomposes
       into one ERP row per compartment sharing `linked_ac_dtlkey`, with only the
       lead piece priced. Spreading one discount across the group subtracts it
       once per compartment — the same refusal repair-so-price-from-autocount
       needed after its first dry run proposed +RM 2,216,501.00 of invented
       revenue across 441 decomposed rows. */
    const priced = group.filter((l) => sen(l.unitSen) > 0);
    if (priced.length !== 1) {
      refusals.push(
        `${doc.docNo} (${doc.acNo}) DtlKey ${key} ${want.item ?? "-"}: ${group.length} ERP line(s) share this AutoCount key ` +
        `and ${priced.length} of them carry a price — a discount spread across a decomposed group would be subtracted once per piece. REFUSED, repair it by hand.`,
      );
      continue;
    }
    const line = priced[0];

    /* The discount is computed against the ERP LINE's own qty x unit price. A
       line whose quantity or price the ERP already disagrees about would
       otherwise have that difference absorbed into a "discount" — a second
       defect wearing the first one's clothes. */
    const erpUndisc = Math.round(Number(line.qty) * sen(line.unitSen));
    if (erpUndisc !== sen(want.undiscSen)) {
      refusals.push(
        `${doc.docNo} (${doc.acNo}) DtlKey ${key} ${line.itemCode ?? want.item}: the ERP line is ${line.qty} x ${money(sen(line.unitSen))} = ` +
        `${money(erpUndisc)} but the book says ${want.qty} x ${money(sen(want.unitSen))} = ${money(sen(want.undiscSen))}. ` +
        "That is a quantity or price difference, NOT a discount — repair-so-qty/price-from-autocount own it. REFUSED.",
      );
      continue;
    }

    const discountSen = erpUndisc - sen(want.bookSen);
    if (discountSen < 0) {
      refusals.push(`${doc.docNo} (${doc.acNo}) DtlKey ${key}: the book amount ${money(sen(want.bookSen))} EXCEEDS qty x unit price ${money(erpUndisc)} — that is a surcharge, not a discount. REFUSED.`);
      continue;
    }
    /* A line whose goods have already LEFT is not silently repriced downward:
       the delivery note and its invoice were raised against the old amount. */
    if (Number(line.deliveredQty ?? 0) > 0) {
      refusals.push(
        `${doc.docNo} (${doc.acNo}) DtlKey ${key} ${line.itemCode ?? want.item}: ${line.deliveredQty} unit(s) have already been delivered ` +
        `against ${money(sen(line.totalSen))}; taking ${money(discountSen)} off now would leave the delivery note and its invoice stating a different amount. REFUSED — the owner rules on it.`,
      );
      continue;
    }
    // Already correct: a second run plans nothing.
    if (sen(line.discountSen) === discountSen && sen(line.totalSen) === sen(want.bookSen)) continue;

    writes.push({
      itemId: line.itemId, docNo: doc.docNo, acNo: doc.acNo, dtlKey: key,
      itemCode: line.itemCode ?? want.item, qty: Number(line.qty), unitSen: sen(line.unitSen),
      discountSen, lineTotalSen: sen(want.bookSen),
      wasDiscount: sen(line.discountSen), wasLineTotal: sen(line.totalSen),
    });
  }

  /* The header, re-summed the way repair-so-price-from-autocount does it:
     SUM(total_sen) over EVERY line of the order, not only the discounted ones. */
  const planned = new Map(writes.map((w) => [w.itemId, w.lineTotalSen]));
  const plannedTotal = doc.lines.reduce(
    (s, l) => s + (planned.has(l.itemId) ? planned.get(l.itemId) : sen(l.totalSen)),
    0,
  );
  const header = writes.length && plannedTotal !== sen(doc.hdrTotal)
    ? { docNo: doc.docNo, totalSen: plannedTotal, wasTotal: sen(doc.hdrTotal) }
    : null;

  return { writes, header, refusals, plannedTotal };
}
