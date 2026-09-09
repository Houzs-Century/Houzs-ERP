/* gr-money-from-book — the PURE decision behind repair-gr-money-from-book.
 *
 * Lives in lib/ so the test exercises the SAME function the repair calls. A
 * self-test against a copy proves nothing, and this repo has already paid for
 * one of those (docs/bugs/0700, the guard that counted the whole table).
 *
 * ── IT DECIDES ONE THING ────────────────────────────────────────────────────
 * Given one migrated goods receipt — its header facts, its ERP lines, and the
 * ACCOUNT BOOK's own GRDTL lines paired by line key — what money should each
 * line carry, and may it be written at all. It opens nothing, reads no file and
 * knows no SQL.
 *
 * ── ONE BOOK LINE IS ONE SOFA, AND THE ERP HOLDS IT AS N COMPARTMENT ROWS ──
 * The first version of this module gave EVERY ERP row sharing a book line key
 * that line's whole SubTotal, and the plan run against production
 * (34302355074) printed the consequence in one line: `HC-GR-000815
 * RM 2,867.43 -> RM 8,602.29`, the same sofa's price three times over, across
 * 105 receipts and RM 199,232.36 of invented money. Nothing was written; the
 * plan is what caught it.
 *
 * So the rows are GROUPED by the book's line key, and the book's figure lands
 * on the group's LEAD row with every other row set to zero — this repo's own
 * sofa convention, stated by apply-sofa-compartment-corrections.mjs: "the lead
 * piece keeps the lead row's own unit_price_sen and its own total column
 * verbatim; every other piece is 0 in both". The document's total is then the
 * sum over DISTINCT book lines, never over rows.
 *
 * ── THE MONEY IS COPIED, NOT COMPUTED ───────────────────────────────────────
 * `SubTotal` becomes `line_total_sen` and `UnitPrice` becomes `unit_price_sen`,
 * both unchanged. `discount_sen` is the gap the BOOK states between them —
 * `qty x UnitPrice - SubTotal` — and never a percentage this module picks. That
 * distinction is the whole repair: three receipts read exactly book x 4/3 today
 * because our importer wrote `qty x price` and dropped AutoCount's own 25%.
 *
 * ── A REFUSAL IS AN ANSWER, AND EVERY ONE IS NAMED ──────────────────────────
 * `keyless`, `foreign-key`, `foreign-currency` and `moved-stock` are verdicts,
 * not exceptions, so the caller can print WHICH receipt was refused and WHY
 * next to the ringgit it would have moved. `moved-stock` in particular is
 * 「库存先不看」 honoured by construction: a receipt with inventory movements has
 * costed layers hanging off its price, so re-pricing it moves an on-hand VALUE,
 * and this returns the figure rather than writing it.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */

/** @typedef {"write"|"agree"|"keyless"|"foreign-key"|"foreign-currency"|"moved-stock"} GrMoneyVerdict */

const n0 = (v) => Number(v || 0);
const key = (v) => String(v ?? "").trim();

/**
 * What one migrated goods receipt's money should be.
 *
 * @param {object} a
 * @param {{ acGr: string, currency: string, subtotalSen: number, totalSen: number,
 *           migratedNoStock: boolean, movements: number }} a.header
 * @param {Array<{ id: unknown, itemCode: string, acDtlKey: unknown,
 *                 unitPriceSen: number, discountSen: number, lineTotalSen: number }>} a.items
 *   the ERP's own receipt lines
 * @param {(k: string) => ({ docNo: string, qty: number, unitPriceSen: number, subTotalSen: number }|null|undefined)} a.bookLine
 *   the ACCOUNT BOOK's GRDTL row for a line key, or nullish when it holds none
 * @param {boolean} a.localCurrency  the book's own verdict on this receipt's currency
 * @returns {{ verdict: GrMoneyVerdict, rows: Array<object>, wantTotal: number, deltaSen: number, why: string }}
 */
export function planReceiptMoney({ header, items, bookLine, localCurrency }) {
  const out = (verdict, why, rows = [], wantTotal = 0) => ({
    verdict, why, rows, wantTotal,
    deltaSen: wantTotal - n0(header.totalSen),
  });

  /* CURRENCY FIRST. An exchange rate looks exactly like a discount, and reading
     a local-currency figure as the document's is what wrote RM 13,068.55 of
     invented discount onto a CNY purchase order (docs/bugs/0721). A receipt
     that is not in the book's local currency is refused, never converted. */
  if (!localCurrency || key(header.currency || "MYR") !== "MYR")
    return out("foreign-currency", "the book does not state this receipt in the local currency; a rate is not a discount and it will not be converted");

  if (!items.length) return out("agree", "the receipt holds no lines");

  /* THE LINE KEY IS THE ONLY PAIRING. Position pairs two identical bedframes
     backwards — PO-009081 ordered two and two receipts each took one, and a
     position-based test failed 6 of 8 where the key-based one passed 8 of 8
     (docs/bugs/0690). A receipt with ANY keyless line is refused WHOLE: half of
     it priced from the book and half left on the order's figure is a document
     whose total means nothing. */
  const keyless = items.filter((i) => !key(i.acDtlKey));
  if (keyless.length)
    return out("keyless", `${keyless.length} of ${items.length} line(s) carry no AutoCount line key, so they cannot be paired to a book line`);

  const paired = [];
  const foreign = [];
  for (const i of items) {
    const bl = bookLine(key(i.acDtlKey));
    if (!bl || key(bl.docNo) !== key(header.acGr)) { foreign.push(i); continue; }
    paired.push({ i, bl });
  }
  if (foreign.length)
    return out("foreign-key", `${foreign.length} line key(s) name no line of ${header.acGr}: ${foreign.map((i) => key(i.acDtlKey)).join(", ")}`);

  /* GROUPED BY THE BOOK'S LINE, IN DOCUMENT ORDER. `paired` preserves the order
     the caller read the rows in, so the group's LEAD is the first ERP row of
     that book line — the same row the importer put the money on. */
  const groups = new Map();
  for (const pr of paired) {
    const k = key(pr.i.acDtlKey);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(pr);
  }

  const rows = [];
  let wantTotal = 0;
  for (const [, members] of groups) {
    const bl = members[0].bl;
    const unit = Math.round(n0(bl.unitPriceSen));
    const total = Math.round(n0(bl.subTotalSen));
    const disc = Math.max(0, Math.round(n0(bl.qty) * unit) - total);
    /* The document's total counts each BOOK LINE once, never each row. */
    wantTotal += total;
    members.forEach(({ i }, n) => {
      const lead = n === 0;
      const u = lead ? unit : 0, t = lead ? total : 0, d = lead ? disc : 0;
      rows.push({
        item: i, unit: u, total: t, disc: d, lead, siblings: members.length,
        changed: u !== n0(i.unitPriceSen) || t !== n0(i.lineTotalSen) || d !== n0(i.discountSen),
      });
    });
  }
  const moved = rows.some((r) => r.changed)
    || wantTotal !== n0(header.totalSen)
    || wantTotal !== n0(header.subtotalSen);
  if (!moved) return out("agree", "every line already carries the book's own money", rows, wantTotal);

  /* ASKED LAST, so a receipt that needs nothing is never reported as blocked by
     stock it also does not need. */
  if (header.migratedNoStock !== true || n0(header.movements) !== 0)
    return out(
      "moved-stock",
      header.migratedNoStock !== true
        ? "not migrated paperwork"
        : `${header.movements} inventory movement(s) name it`,
      rows, wantTotal,
    );

  return out("write", "the book prices this receipt and the ERP does not hold that figure", rows, wantTotal);
}
