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
 * -- THE KEYLESS ARM WRITES MONEY, NEVER IDENTITY --------------------------
 * `keyless` used to refuse a receipt outright, and for the three receipts the
 * owner ruled on that refusal was permanent: `HC-GR-005363` holds two
 * `AKEMI BASTION MATT (Q)` rows with no line key, no Desc2 and no purchase-order
 * line, against two book rows that differ ONLY in their venue text (measured on
 * production 2026-09-09, probe run 34314996219). `lib/ac-forced-line-pairing.mjs`
 * is right to refuse to STAMP a key there - a wrong key makes AcSyncService edit
 * somebody else's line in the live book (migration 0273) - but identity is not
 * what this module writes.
 *
 * It writes MONEY, and money can be forced where identity cannot: when every
 * unclaimed book row of one item code states the SAME quantity, the SAME
 * UnitPrice and the SAME SubTotal, then whichever ERP row is whichever book row,
 * the figure written is the same. That is the ONLY claim the arm makes, and it
 * stamps no key. Where the candidates differ on any of those three, or the two
 * sides do not hold the same NUMBER of rows for a code, the whole receipt is
 * refused exactly as before.
 *
 * An unclaimed book row that no ERP row answers is allowed through only when it
 * is priced at RM 0.00 - AutoCount bills a free gift as its own line, and the
 * reconcile already states that rule (`check-ac-erp-reconcile.mjs`, "the free
 * line we do not carry"). A PRICED one is a missing line and refuses the receipt.
 *
 * `keylessMoney` is OPTIONAL and its absence is the STRICTER direction: without
 * it the old whole-receipt refusal stands, so a caller that says nothing cannot
 * loosen anything. That is the one shape CLAUDE.md's required-parameter rule
 * allows, and it is why it is written this way.
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
 * @param {{ bookLines: Array<{dtlKey: unknown, code: string, qty: number,
 *           unitPriceSen: number, subTotalSen: number}>,
 *           codeKey: (c: string) => string }|null} [a.keylessMoney]
 *   the book's OWN rows of this receipt, plus the caller's item-code translation
 *   (this module never guesses one). ABSENT = the stricter direction: a receipt
 *   with any keyless line is refused whole, as it was before this arm existed.
 * @returns {{ verdict: GrMoneyVerdict, rows: Array<object>, wantTotal: number, deltaSen: number, why: string }}
 */
export function planReceiptMoney({ header, items, bookLine, localCurrency, keylessMoney = null }) {
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
  let forced = null;
  if (keyless.length) {
    const f = forceKeylessMoney({ items, keyless, keylessMoney });
    if (!f.ok) return out("keyless", f.why);
    forced = f.byRow;
  }

  const paired = [];
  const foreign = [];
  for (const i of items) {
    if (!key(i.acDtlKey)) { paired.push({ i, bl: forced.get(i), forced: true }); continue; }
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
    /* A forced row stands alone: the arm above only ever forces a bucket where
       the two sides hold the SAME NUMBER of rows, so one ERP row is one book
       line and there is no lead to split money across. Keying the group on the
       row itself keeps that true without a second rule. */
    const k = pr.forced ? pr.i : key(pr.i.acDtlKey);
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

/**
 * Which book row's MONEY each keyless ERP row must take - or why the receipt
 * cannot be answered at all.
 *
 * Bucketed on the canonical ITEM CODE alone. Within a bucket, every unclaimed
 * book row must be mutually identical on quantity, UnitPrice and SubTotal, and
 * the two sides must hold the same NUMBER of rows; then the assignment is
 * irrelevant to the figure and the money is FORCED. Anything else refuses the
 * whole receipt, because half of it priced from the book and half left on the
 * order's figure is a document whose total means nothing.
 *
 * @returns {{ok: true, byRow: Map<object, object>}|{ok: false, why: string}}
 */
function forceKeylessMoney({ items, keyless, keylessMoney }) {
  const no = (why) => ({ ok: false, why });
  if (!keylessMoney || !Array.isArray(keylessMoney.bookLines) || typeof keylessMoney.codeKey !== "function") {
    return no(`${keyless.length} of ${items.length} line(s) carry no AutoCount line key, so they cannot be paired to a book line`);
  }
  const { bookLines, codeKey } = keylessMoney;
  const claimed = new Set(items.map((i) => key(i.acDtlKey)).filter(Boolean));
  const unclaimed = bookLines.filter((b) => !claimed.has(key(b.dtlKey)));

  const bucket = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); return m; };
  const erpBy = keyless.reduce((m, i) => bucket(m, codeKey(i.itemCode), i), new Map());
  const bookBy = unclaimed.reduce((m, b) => bucket(m, codeKey(b.code), b), new Map());

  const byRow = new Map();
  for (const [code, rows] of erpBy) {
    const cand = bookBy.get(code) ?? [];
    if (cand.length !== rows.length) {
      return no(
        `${rows.length} keyless line(s) of ${JSON.stringify(code)} against ${cand.length} book row(s) the ` +
          "keys do not already claim, so which is which is not forced",
      );
    }
    const same = (a, b) => n0(a.qty) === n0(b.qty)
      && Math.round(n0(a.unitPriceSen)) === Math.round(n0(b.unitPriceSen))
      && Math.round(n0(a.subTotalSen)) === Math.round(n0(b.subTotalSen));
    if (!cand.every((b) => same(b, cand[0]))) {
      return no(
        `the ${cand.length} book row(s) of ${JSON.stringify(code)} do not state the same money, so which of our ` +
          "keyless lines is which decides the figure - and nothing here can decide it",
      );
    }
    for (const r of rows) byRow.set(r, cand[0]);
    bookBy.delete(code);
  }
  /* WHAT IS LEFT OVER. AutoCount bills a free gift as its own RM 0.00 line and
     the ERP legitimately holds no row for it - the reconcile states that rule as
     "the free line we do not carry". A PRICED book row nothing answers is a
     missing LINE, and this arm will not price around one. */
  for (const [code, rows] of bookBy) {
    const priced = rows.filter((b) => Math.round(n0(b.subTotalSen)) !== 0);
    if (priced.length) {
      return no(
        `${priced.length} book row(s) of ${JSON.stringify(code)} carry money and no line of ours answers them`,
      );
    }
  }
  return { ok: true, byRow };
}
