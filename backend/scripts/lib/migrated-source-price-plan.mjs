/* migrated-source-price-plan — the money AutoCount states on a RECEIPT or a
 * DELIVERY, copied onto the migrated ERP line the cutover left at RM 0.00.
 *
 * WHY THIS IS A LIBRARY AND NOT INLINE IN THE SCRIPT. The script it serves
 * WRITES MONEY onto live documents, and every interesting decision it makes is
 * a REFUSAL — a line count the book does not have, a quantity that does not
 * line up, a decomposed sofa whose pieces would each be handed the whole
 * sofa's price. None of those can be exercised against production without
 * first creating them there. Kept pure, each one is a test with a planted
 * defect.
 *
 * NO SHEBANG — a test-imported module must not carry one (CLAUDE.md: on Windows
 * vitest inlines the source and a `#!` off byte 0 is a SyntaxError at LOAD).
 *
 * ── WHAT THE BOOK ACTUALLY SAYS, AND WHERE ───────────────────────────────────
 * The price is taken from the AutoCount GOODS RECEIPT line (GRDTL) / DELIVERY
 * line (DODTL), never from the purchase order behind it. Measured on the
 * 2026-09-07 cut: on all 180 zero-priced migrated receipt lines the book's own
 * PO line reads `UnitPrice 0, SubTotal 0` — Houzs does not price factory
 * purchase orders in AutoCount (7,591 of 9,416 POs carry NetTotal 0.00). The
 * money appears first on the receipt. Worked example, GR-000815 line 209355:
 *
 *     PO-001068 DtlKey 145254   qty 1   UnitPrice 0.00      SubTotal 0.00
 *     GR-000815 DtlKey 209355   qty 1   UnitPrice 3,373.45  SubTotal 2,867.43
 *     PI-001531                                             NetTotal 2,867.43
 *
 * SUBTOTAL IS THE VALUE, NOT qty x UnitPrice. AutoCount holds the line discount
 * in the gap between the two columns, exactly as it does on a purchase order
 * (docs/bugs/0662, docs/bugs/0664). Copying 3,373.45 leaves the invoice gate
 * refusing by RM 506.02. So the write is `unit_price_sen = UnitPrice`,
 * `discount_sen = qty x UnitPrice - SubTotal`, `line_total_sen = SubTotal` —
 * all three, because the app recomputes `line_total = qty*unit - discount` on
 * every edit (grns.ts:1654, :1885, :2256) and a line total written without the
 * discount beside it is undone by the next person who touches the line.
 *
 * ── THE THREE REFUSALS THAT MATTER ───────────────────────────────────────────
 *
 * 1. ONE AUTOCOUNT LINE IS MANY ERP ROWS. A sofa is ONE GRDTL row and one ERP
 *    row per compartment, and `import-ac-outstanding-po.mjs:290` writes the
 *    price on the FIRST piece with the rest at 0 ("price rides the lead piece;
 *    the rest are 0 so the PO total still matches AutoCount"). Handing the
 *    SubTotal to every row of a group multiplies the document by its piece
 *    count — the RM 2,216,501 near miss of docs/bugs/0673. So a group is
 *    planned as a GROUP: one write on the lead row, and every sibling asserted
 *    to be at 0 already.
 *
 * 2. OUR DOCUMENT IS A PARTIAL MIRROR. The cutover imported the outstanding
 *    part of a receipt, so an AutoCount receipt spanning four purchase orders
 *    can reach the ERP as one receipt covering one of them. The book lines are
 *    therefore scoped to the AutoCount purchase order OUR document mirrors, and
 *    the ERP's line groups must line up with what is left — same count, same
 *    quantities, in order. A shape that does not line up is REFUSED and named;
 *    it is not something a price can fix.
 *
 * 3. BLANK NEVER OVERWRITES. Owner, 2026-09-07: 「保留 ERP 的价钱 — 空白不覆盖」.
 *    A book line missing its qty, its unit price or its SubTotal is skipped and
 *    printed, never read as zero — that is how an absent export column becomes
 *    a free line. A book line that STATES zero money is a different fact and is
 *    honoured as zero.
 *
 * Currency is the caller's gate, not this module's: `currencyVerdict` in
 * lib/ac-scope.mjs owns it, and a document that is not MYR at rate 1 never
 * reaches this planner. See docs/bugs/0665 for the RM 13,068.55 that cost.
 */

/** Every sen figure is an integer; a float here is a money bug waiting. */
const sen = (v) => (v == null ? 0 : Math.round(Number(v)));

/**
 * Line up the ERP's line GROUPS with the book's lines, in order, on QUANTITY.
 *
 * The book routinely states a line our document does not carry — a free pillow,
 * a bolster billed at zero. Such a line contributes nothing to any total, so it
 * may be passed over; a book line that states MONEY may not. Order is preserved
 * on both sides, so this is an alignment, not a search: nothing is matched by
 * looking for the number that would make the totals work.
 *
 * @returns {{pairs: Array<{group: object, book: object}>, error: string|null, dropped: object[]}}
 */
export function alignGroupsToBook(groups, bookLines) {
  const pairs = [];
  const dropped = [];
  let bi = 0;
  for (const g of groups) {
    let matched = null;
    while (bi < bookLines.length) {
      const b = bookLines[bi];
      if (Number(b.qty) === Number(g.qty)) { matched = b; bi++; break; }
      /* Only a line the book prices at nothing may be stepped over. */
      if (sen(b.subTotalSen) === 0 && sen(b.unitPriceSen) === 0) { dropped.push(b); bi++; continue; }
      break;
    }
    if (!matched) {
      return {
        pairs: [],
        dropped: [],
        error: `ERP line group ${g.key} (${g.itemCodes.join(' + ')}) qty ${g.qty} has no AutoCount line left to take its money from`,
      };
    }
    pairs.push({ group: g, book: matched });
  }
  for (; bi < bookLines.length; bi++) {
    const b = bookLines[bi];
    if (sen(b.subTotalSen) !== 0 || sen(b.unitPriceSen) !== 0) {
      return {
        pairs: [],
        dropped: [],
        error: `the book states ${bookLines.length} line(s) for this document and the ERP carries ${groups.length} group(s); `
          + `DtlKey ${b.dtlKey} (${b.itemKey ?? '-'}) qty ${b.qty} is priced and has no ERP line to land on`,
      };
    }
    dropped.push(b);
  }
  return { pairs, dropped, error: null };
}

/**
 * Plan one migrated source document.
 *
 * @param {object} a
 * @param {object} a.doc            { docNo, acDocNo, groups: [{key, qty, itemCodes, rows}] }
 * @param {object[]} a.bookLines    the in-scope book lines, ALREADY sorted by seq
 * @param {(n:number)=>string} [a.rm]
 */
export function planSourceDocument({ doc, bookLines, rm }) {
  const money = rm ?? ((s) => `RM ${(s / 100).toFixed(2)}`);
  const writes = [];
  const refusals = [];
  const at = `${doc.docNo}${doc.acDocNo ? ` (AutoCount ${doc.acDocNo})` : ''}`;

  /* 空白不覆盖, first: a book line whose numbers the export never carried is
     not a zero, and reading it as one manufactures a free line. */
  const blank = bookLines.filter((b) => b.qty == null || b.unitPriceSen == null || b.subTotalSen == null);
  if (blank.length) {
    for (const b of blank) {
      refusals.push(
        `${at} DtlKey ${b.dtlKey} (${b.itemKey ?? '-'}): the book states qty=${b.qty} unit=${b.unitPriceSen} `
        + `amount=${b.subTotalSen} — blank never overwrites. REFUSED.`,
      );
    }
    return { writes: [], refusals, plannedTotal: null };
  }
  if (!bookLines.length) {
    refusals.push(`${at}: the book states no line for the document this one mirrors. REFUSED.`);
    return { writes: [], refusals, plannedTotal: null };
  }

  const { pairs, error } = alignGroupsToBook(doc.groups, bookLines);
  if (error) {
    refusals.push(`${at}: ${error}. REFUSED — a price cannot fix a line-shape difference.`);
    return { writes: [], refusals, plannedTotal: null };
  }

  /* Two book lines of the same quantity and different money, landing on ERP
     groups that are not the same product, is an assignment decided by ORDER.
     Order is not evidence (rule 5 of migrated-chain). */
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const a = pairs[i];
      const b = pairs[j];
      if (Number(a.book.qty) !== Number(b.book.qty)) continue;
      if (sen(a.book.subTotalSen) === sen(b.book.subTotalSen)) continue;
      const ka = [...a.group.itemCodes].sort().join('|');
      const kb = [...b.group.itemCodes].sort().join('|');
      if (ka === kb) continue;
      refusals.push(
        `${at}: DtlKey ${a.book.dtlKey} ${money(sen(a.book.subTotalSen))} and DtlKey ${b.book.dtlKey} `
        + `${money(sen(b.book.subTotalSen))} are both qty ${a.book.qty}, and the ERP groups they would land on are `
        + `different products (${a.group.itemCodes.join(' + ')} / ${b.group.itemCodes.join(' + ')}). `
        + 'Which line is which is decided by sort order. REFUSED.',
      );
      return { writes: [], refusals, plannedTotal: null };
    }
  }

  for (const { group, book } of pairs) {
    const lead = group.rows[0];
    const siblings = group.rows.slice(1);

    /* Never overwrite. The selection is zero-priced lines, and a group that has
       acquired a price since the plan was read is left exactly as it is. */
    if (group.rows.some((r) => sen(r.unitSen) !== 0 || sen(r.discountSen) !== 0 || sen(r.lineTotalSen) !== 0)) {
      refusals.push(
        `${at} group ${group.key} (${group.itemCodes.join(' + ')}): already carries money in the ERP — `
        + 'never overwritten. SKIPPED.',
      );
      continue;
    }
    /* The gate the invoice converter applies counts qty_accepted less what has
       been invoiced or returned, while the app's own line total is computed off
       qty_received. A row where those disagree would be written to one number
       and read at another. */
    for (const r of group.rows) {
      if (Number(r.qty) !== Number(r.qtyReceived) || sen(r.invoicedQty) !== 0 || sen(r.returnedQty) !== 0) {
        refusals.push(
          `${at} ${r.itemCode}: qty ${r.qty}, qty_received ${r.qtyReceived}, invoiced ${r.invoicedQty}, `
          + `returned ${r.returnedQty} — the quantity the invoice gate counts is not the quantity the line total `
          + 'is computed from. REFUSED.',
        );
        return { writes: [], refusals, plannedTotal: null };
      }
    }

    const unitSen = sen(book.unitPriceSen);
    const undisc = Math.round(Number(lead.qty) * unitSen);
    const lineTotalSen = sen(book.subTotalSen);
    /* The book states no money for this line and the ERP already reads zero.
       There is nothing to copy, and writing three zeros over three zeros is a
       production UPDATE that changes nothing — a genuinely free line stays
       free, silently, which is what it already was. */
    if (unitSen === 0 && lineTotalSen === 0) continue;
    if (lineTotalSen > undisc) {
      refusals.push(
        `${at} ${lead.itemCode}: the book's line amount ${money(lineTotalSen)} EXCEEDS qty x unit price `
        + `${money(undisc)} — that is a surcharge, not a discount. REFUSED.`,
      );
      return { writes: [], refusals, plannedTotal: null };
    }

    writes.push({
      lineId: lead.lineId,
      docNo: doc.docNo,
      groupKey: group.key,
      itemCode: lead.itemCode,
      qty: Number(lead.qty),
      dtlKey: book.dtlKey,
      unitSen,
      discountSen: undisc - lineTotalSen,
      lineTotalSen,
      wasUnitSen: sen(lead.unitSen),
      wasDiscountSen: sen(lead.discountSen),
      wasLineTotalSen: sen(lead.lineTotalSen),
      /* Printed so the log shows which rows are deliberately left at zero — a
         reader must be able to tell a lead piece from a dropped one. */
      siblingsLeftAtZero: siblings.map((s) => s.itemCode),
    });
  }

  const plannedTotal = writes.reduce((t, w) => t + w.lineTotalSen, 0);
  return { writes, refusals, plannedTotal };
}
