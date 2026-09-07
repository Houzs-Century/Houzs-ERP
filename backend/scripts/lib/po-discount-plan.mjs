/* po-discount-plan — the PO line-discount repair, decided as a pure function.
 *
 * WHY THIS IS A LIBRARY AND NOT INLINE IN THE SCRIPT. The script it serves
 * MOVES MONEY on live purchase orders, and every interesting decision it makes
 * is a REFUSAL: a decomposed line group, a quantity the ERP disagrees about, a
 * book amount larger than qty x unit price. None of those can be exercised
 * against production without first creating them there. Kept pure, each one is
 * a test with a planted defect — which is the bar CLAUDE.md sets for a checker
 * ("a checker that cannot match reports a clean run").
 *
 * NO SHEBANG — a test-imported module must not carry one (CLAUDE.md: on Windows
 * vitest inlines the source and a `#!` off byte 0 is a SyntaxError at LOAD).
 *
 * THE RULE, in one line: the discount is `qty x unit_price - AutoCount's own
 * line amount`, computed against the ERP LINE's numbers, written to
 * `discount_sen` AND `line_total_sen`, with the header re-summed over ALL of the
 * order's lines. See the script header for why the line total alone is not
 * enough (the app's own line editor would undo it).
 */

import { currencyVerdict } from './ac-scope.mjs';

/** Every sen figure is an integer; a float here is a money bug waiting. */
const sen = (v) => (v == null ? 0 : Math.round(Number(v)));

/**
 * @param {object} a
 * @param {Map<string, object>} a.wantByKey   AutoCount DtlKey -> {dtlKey, item, qty, unitSen, bookSen, undiscSen}
 * @param {object} a.doc                      { acNo, poId, poNumber, hdrSubtotal, hdrTotal, lines: [...] }
 * @returns {{writes: object[], header: object|null, refusals: string[], plannedSubtotal: number}}
 */
export function planDocument({ wantByKey, doc, rm }) {
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
      refusals.push(
        `${doc.poNumber} (${doc.acNo}) DtlKey ${key} ${want.item ?? '-'}: the book discounts this line and the ERP has no line carrying that AutoCount key`,
      );
      continue;
    }
    /* ONE AUTOCOUNT LINE MUST MEET ONE PRICED ERP LINE. A sofa line decomposes
       into one ERP row per compartment, all sharing linked_ac_dtlkey, and only
       the lead piece carries the price. Subtracting one discount from each row
       of such a group would take it off two, three or four times. */
    const priced = group.filter((l) => sen(l.unitSen) > 0);
    if (priced.length !== 1) {
      refusals.push(
        `${doc.poNumber} (${doc.acNo}) DtlKey ${key} ${want.item ?? '-'}: ${group.length} ERP line(s) share this AutoCount key and ` +
          `${priced.length} of them carry a price — a discount spread across a decomposed group would be subtracted once per piece. ` +
          'REFUSED, repair it by hand.',
      );
      continue;
    }
    const line = priced[0];

    /* The discount is computed against the ERP LINE's own qty x unit price, not
       the book's. A line whose quantity or price the ERP already disagrees
       about would otherwise have that difference silently absorbed into a
       "discount" — which is a second defect wearing the first one's clothes. */
    const erpUndisc = Math.round(Number(line.qty) * sen(line.unitSen));
    if (erpUndisc !== sen(want.undiscSen)) {
      refusals.push(
        `${doc.poNumber} (${doc.acNo}) DtlKey ${key} ${line.itemCode ?? want.item}: the ERP line is ${line.qty} x ${money(sen(line.unitSen))} = ` +
          `${money(erpUndisc)} but the book says ${want.qty} x ${money(sen(want.unitSen))} = ${money(sen(want.undiscSen))}. ` +
          'That is a quantity or price difference, NOT a discount — the field-identity check owns it. REFUSED.',
      );
      continue;
    }

    const discountSen = erpUndisc - sen(want.bookSen);
    if (discountSen < 0) {
      refusals.push(
        `${doc.poNumber} (${doc.acNo}) DtlKey ${key}: the book amount ${money(sen(want.bookSen))} EXCEEDS qty x unit price ${money(erpUndisc)} — ` +
          'that is a surcharge, not a discount. REFUSED.',
      );
      continue;
    }
    // Already correct: a second run of the repair plans nothing.
    if (sen(line.discountSen) === discountSen && sen(line.lineTotalSen) === sen(want.bookSen)) continue;

    writes.push({
      itemId: line.itemId, poId: doc.poId, poNumber: doc.poNumber, dtlKey: key,
      itemCode: line.itemCode ?? want.item, qty: Number(line.qty), unitSen: sen(line.unitSen),
      receivedQty: Number(line.receivedQty ?? 0),
      discountSen, lineTotalSen: sen(want.bookSen),
      wasDiscount: sen(line.discountSen), wasLineTotal: sen(line.lineTotalSen),
    });
  }

  /* The header, re-summed the way the app's own recomputePoTotals does it:
     SUM(line_total_sen) over EVERY line of the order, not only the discounted
     ones, and written to both subtotal_sen and total_sen. */
  const planned = new Map(writes.map((w) => [w.itemId, w.lineTotalSen]));
  const plannedSubtotal = doc.lines.reduce(
    (s, l) => s + (planned.has(l.itemId) ? planned.get(l.itemId) : sen(l.lineTotalSen)),
    0,
  );

  const header = writes.length && (plannedSubtotal !== sen(doc.hdrTotal) || plannedSubtotal !== sen(doc.hdrSubtotal))
    ? {
      poId: doc.poId, poNumber: doc.poNumber,
      subtotalSen: plannedSubtotal, totalSen: plannedSubtotal,
      wasSubtotal: sen(doc.hdrSubtotal), wasTotal: sen(doc.hdrTotal),
    }
    : null;

  return { writes, header, refusals, plannedSubtotal };
}

/* `currencyVerdict` and `LOCAL_CURRENCY` live in lib/ac-scope.mjs — the
   snapshot library — because the reconcile CHECKER needs the same verdict this
   repair does, and two statements of one currency rule is how the first one
   came to be wrong. Re-exported here so this module still reads as the whole
   decision. */
export { currencyVerdict, LOCAL_CURRENCY } from './ac-scope.mjs';

/**
 * The AutoCount side: every PO line whose own amount differs from
 * qty x unit price. THE OWNER'S BLANK RULE, 2026-09-07 —
 * 「保留 ERP 的价钱 — 空白不覆盖」 — a book line missing its qty, unit price or
 * amount is SKIPPED and reported, never read as zero. Treating a missing export
 * column as RM 0.00 would manufacture a 100% discount out of an absent field.
 *
 * `bookPoHeaders` IS REQUIRED, and it is required rather than optional so that
 * no caller can reach the discount rule without the currency beside it. A
 * document that is not MYR at rate 1 — or whose currency this snapshot never
 * carried — never reaches `byDoc` at all; it comes back in `currencyRefused`,
 * to be printed. See `currencyVerdict` for why this is a refusal and not a
 * conversion.
 */
export function readBookDiscounts(bookPoLines, scopePo, bookPoHeaders) {
  if (!(bookPoHeaders instanceof Map)) {
    throw new Error('readBookDiscounts needs the PO headers to read each document\'s currency — see docs/bugs/0665-*.md');
  }
  const byDoc = new Map();
  const skipped = [];
  const currencyRefused = [];
  const whole = { lines: 0, docs: new Set(), sen: 0 };

  for (const [docNo, lines] of bookPoLines) {
    /* The currency gate comes FIRST, before a single line of this document is
       read as a discount. `whole` deliberately still counts it: the whole-book
       figure is a description of the book, not a plan, and hiding a foreign
       document from it would make the refusal invisible in the totals. */
    const verdict = scopePo.has(docNo) ? currencyVerdict(bookPoHeaders.get(docNo)) : null;
    const blocked = verdict != null && verdict.kind !== 'local';
    if (blocked) {
      currencyRefused.push({ docNo, kind: verdict.kind, why: verdict.why });
    }
    for (const l of lines) {
      if (l.qty == null || l.unitPriceSen == null || l.subTotalSen == null) {
        if (scopePo.has(docNo)) {
          skipped.push(`${docNo} DtlKey ${l.dtlKey} (${l.itemKey ?? '-'}): book qty=${l.qty} unit=${l.unitPriceSen} amount=${l.subTotalSen}`);
        }
        continue;
      }
      const undiscSen = Math.round(l.qty * l.unitPriceSen);
      if (undiscSen === l.subTotalSen) continue;
      whole.lines++;
      whole.docs.add(docNo);
      whole.sen += undiscSen - l.subTotalSen;
      if (!scopePo.has(docNo)) continue;
      if (blocked) continue;
      if (!byDoc.has(docNo)) byDoc.set(docNo, new Map());
      byDoc.get(docNo).set(String(l.dtlKey), {
        dtlKey: String(l.dtlKey), item: l.itemKey, qty: l.qty,
        unitSen: l.unitPriceSen, bookSen: l.subTotalSen, undiscSen,
      });
    }
  }

  const inScope = {
    docs: byDoc.size,
    lines: [...byDoc.values()].reduce((s, m) => s + m.size, 0),
    sen: [...byDoc.values()].reduce((s, m) => s + [...m.values()].reduce((t, x) => t + (x.undiscSen - x.bookSen), 0), 0),
  };
  return { byDoc, skipped, currencyRefused, whole, inScope };
}
