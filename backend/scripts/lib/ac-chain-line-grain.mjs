/* ac-chain-line-grain — the PO -> GR -> PI chain of the account book, stated at
 * the grain the ERP is able to hold, and the ONE place that says what the book
 * owes an ERP document.
 *
 * ── THE BUG THIS FILE IS CUT OUT OF ─────────────────────────────────────────
 * 2026-09-08. `stamp-migrated-source-prices.mjs` looked at nine goods receipts,
 * computed the right figure to the sen, and refused to write it. Its reason,
 * printed in its own report and then repeated to the owner:
 *
 *   "our receipt mirrors ONE purchase order and AutoCount's receipt spans
 *    several, so the invoice bills more than our lines cover. A price cannot
 *    fix that."
 *
 * The owner rejected the reading:
 *
 *   「PI 是from multiple的PO 所以GR的吧? 没有啊 我们一张GR to 一张PI —
 *     可是GR 会from multiple PO啊 — 所以你要去GR 每个line的amount 都对齐啊 —
 *     PO GR PI的line information去吧要对其啊」
 *
 * ONE receipt to ONE invoice; a receipt MAY draw on several orders; align the
 * LINES. The schema had already said so and nobody read it: `grns.purchase_
 * order_id` is NOT NULL and names ONE order, while `grn_items.purchase_order_
 * item_id` is per line and NULLABLE. The LINES model a multi-order receipt
 * perfectly well. The refusal was a DOCUMENT-TOTAL measurement wearing a
 * line-level explanation — this repo's named defect, a checker counting its own
 * guess.
 *
 * ── WHAT WAS ACTUALLY WRONG: THE YARDSTICK ──────────────────────────────────
 * The gate compared an ERP group's total against the whole invoice's NetTotal.
 * But the migration carried the OUTSTANDING population (the owner's rule), so
 * the ERP deliberately mirrors only SOME of the (receipt x order) pairs an
 * invoice bills. Measured on the committed snapshot, 2026-09-08:
 *
 *   131 of the 192 live purchase invoices that touch an in-scope receipt bill
 *   at least one line whose purchase order the migration never carried —
 *   RM 625,213.71 across 892 lines.
 *
 * Against that yardstick the ERP can never reconcile, and no price can make it.
 * The correct yardstick is the BOOK'S OWN money for exactly the pairs the ERP
 * holds. Worked, on the three the stamper named — every ringgit lands:
 *
 *   PI-007287  RM 11,247.00 = GR-004909|PO-009017  3,200.00  (ours)
 *                           + GR-004909|PO-009033  3,070.00  (never carried)
 *                           + GR-004914|PO-008984  3,300.00  (never carried)
 *                           + GR-004914|PO-009074  1,677.00  (never carried)
 *   PI-007765   RM 4,580.00 = GR-005169|PO-009475  2,230.00  (ours)
 *                           + GR-005169|PO-009469  2,350.00  (never carried)
 *   PI-007771   RM 9,284.00 = GR-005171|PO-009344  2,330.00  (ours)
 *                           + GR-005171|PO-009553  2,520.00  (ours)
 *                           + GR-005171|PO-009365  1,444.00  (never carried)
 *                           + GR-005171|PO-009516  2,990.00  (never carried)
 *
 * RM 3,200.00 / RM 2,230.00 / RM 4,850.00 are exactly what the stamper said
 * "ours would be". It had the right number all along and was grading it against
 * the wrong total. NOT ONE SEN IS MISSING.
 *
 * ── KEYED ON DOCUMENT LINKS. NEVER ON POSITION, NEVER ON NAME ───────────────
 * Two similar rows paired by position get transposed (docs/bugs/0690), so this
 * module pairs NOTHING. Every attribution rides a link AutoCount itself wrote:
 *
 *   invoice line -> receipt   PIDTL.FromDocNo
 *   receipt line -> order     GRDTL.FromDocNo
 *   receipt line -> ERP line  DtlKey (the callers' own join)
 *
 * The snapshot does NOT carry a PIDTL -> GRDTL line key (the exporter requests
 * FromSODtlKey for PODTL only), so an invoice line is never matched to a
 * receipt line here. It does not need to be: the money is attributed
 * invoice -> receipt -> order, all three by document number, and the identity
 * below is what makes that exact rather than approximate.
 *
 * ── THE IDENTITY THAT MAKES DOCUMENT-GRAIN ATTRIBUTION EXACT ────────────────
 * For every in-scope receipt the book bills, the invoice's draw on that receipt
 * EQUALS that receipt's own line sum. Measured on the committed snapshot:
 * 189 receipts, 189 agree, 0 differ. So splitting the receipt by the order its
 * own lines name splits the invoice money too, with nothing left over — no line
 * pairing required and none performed.
 *
 * `invoiceIdentity` re-measures it per document at RUN time rather than
 * trusting that count, and a document where it fails is REFUSED. That is also
 * the original cross-check, kept: the line money comes from
 * ac-reconcile-truth.json.gz and the header from ac-invoice-refs.json.gz, and
 * two independent exports of one book agreeing to the sen is the evidence.
 *
 * ── CURRENCY IS NOT THIS MODULE'S JOB, AND IT MUST NOT BECOME IT ────────────
 * Every figure here is the book's own DOCUMENT-currency subtotal, compared only
 * against another figure from the same book. Nothing is converted. A local-vs-
 * document currency mix-up once wrote RM 13,068.55 of imaginary discount onto a
 * CNY purchase order (docs/bugs/0665, docs/bugs/0721); callers gate currency
 * with `currencyVerdict` in lib/ac-scope.mjs BEFORE they get here.
 *
 * NO SHEBANG — a test-imported module must not carry one (CLAUDE.md: on Windows
 * vitest inlines the source and a `#!` off byte 0 is a SyntaxError at LOAD).
 * READ-ONLY and dependency-free: pure functions over a decoded snapshot.
 */

/** The finest grain both sides can state: one AutoCount receipt x one order. */
export const pairKey = (grDocNo, poDocNo) => `${grDocNo}|${poDocNo}`;

/** Every sen figure is an integer; a float here is a money bug waiting. */
const sen = (v) => (v == null ? 0 : Math.round(Number(v)));

/**
 * Index the book's purchase chain.
 *
 * @param {object} book  decodeSnapshot(snap) output — needs `GR` and `PI`
 * @param {object} refs  ac-invoice-refs.json.gz — the INDEPENDENT header export
 */
export function buildChain(book, refs) {
  const cancelled = new Set();
  const netTotalSen = new Map();
  const currencyOf = new Map();
  const rateOf = new Map();
  for (const [doc, m] of Object.entries({ ...(refs?.piMeta ?? {}), ...(refs?.ivMeta ?? {}) })) {
    netTotalSen.set(doc, sen(Number(m.netTotal) * 100));
    /* Read OUR OWN column rather than assuming ringgit. A hardcoded "it is RM"
       was wrong for 19 hours on a CNY purchase order (docs/bugs/0721). */
    if (m.currency != null) currencyOf.set(doc, m.currency);
    if (m.rate != null) rateOf.set(doc, Number(m.rate));
    if (m.cancelled) cancelled.add(doc);
  }

  /* receipt x order -> the book's own money, and the lines behind it. */
  const pairTotalSen = new Map();
  const pairLines = new Map();
  const ordersOfReceipt = new Map();
  for (const [gr, ls] of book.GR.lines) {
    for (const l of ls) {
      /* A receipt line naming no order is keyless paperwork, not a pair. It is
         deliberately NOT folded into some other order's total: money assigned
         to a pair it does not belong to is the transposition this file refuses
         to commit, one level up. */
      if (l.fromDocType !== 'PO' || !l.fromDocNo) continue;
      const k = pairKey(gr, l.fromDocNo);
      pairTotalSen.set(k, (pairTotalSen.get(k) ?? 0) + sen(l.subTotalSen));
      if (!pairLines.has(k)) pairLines.set(k, []);
      pairLines.get(k).push(l);
      if (!ordersOfReceipt.has(gr)) ordersOfReceipt.set(gr, new Set());
      ordersOfReceipt.get(gr).add(l.fromDocNo);
    }
  }

  /* invoice -> the receipts it bills, and what it draws from each. A CANCELLED
     invoice is not evidence and never reaches any of these maps. */
  const invoicesOfReceipt = new Map();
  const receiptsOfInvoice = new Map();
  const invoiceLineSumSen = new Map();
  const drawOnReceiptSen = new Map();
  for (const [pi, ls] of book.PI.lines) {
    if (cancelled.has(pi)) continue;
    for (const l of ls) {
      invoiceLineSumSen.set(pi, (invoiceLineSumSen.get(pi) ?? 0) + sen(l.subTotalSen));
      if (l.fromDocType !== 'GR' || !l.fromDocNo) continue;
      if (!invoicesOfReceipt.has(l.fromDocNo)) invoicesOfReceipt.set(l.fromDocNo, []);
      const inv = invoicesOfReceipt.get(l.fromDocNo);
      if (!inv.includes(pi)) inv.push(pi);
      if (!receiptsOfInvoice.has(pi)) receiptsOfInvoice.set(pi, new Set());
      receiptsOfInvoice.get(pi).add(l.fromDocNo);
      const dk = pairKey(pi, l.fromDocNo);
      drawOnReceiptSen.set(dk, (drawOnReceiptSen.get(dk) ?? 0) + sen(l.subTotalSen));
    }
  }

  /* The RECEIPT's own line sum, so a caller can ask the one question that
     decides whether an invoice's money splits cleanly by purchase order:
     does this invoice bill the WHOLE receipt? Measured on the committed
     snapshot: 5,248 of 5,300 (invoice x receipt) edges do, and every one of the
     189 in-scope receipts is billed exactly. Where it bills only part, the book
     states no key saying WHICH lines, and this module will not guess one. */
  const receiptTotalSen = new Map();
  for (const [gr, ls] of book.GR.lines) {
    receiptTotalSen.set(gr, ls.reduce((s, l) => s + sen(l.subTotalSen), 0));
  }

  return {
    pairTotalSen, pairLines, ordersOfReceipt, receiptTotalSen,
    invoicesOfReceipt, receiptsOfInvoice, invoiceLineSumSen, drawOnReceiptSen,
    netTotalSen, currencyOf, rateOf, cancelled, book,
  };
}

/**
 * The BOOK's own money for exactly the (receipt x order) pairs given.
 *
 * A pair the book does not state is NAMED, never scored as zero: reading an
 * absent row as 0.00 is how a missing export column becomes a free document.
 *
 * @returns {{sen: number, unknown: string[]}}
 */
export function expectedForPairs(chain, pairs) {
  let total = 0;
  const unknown = [];
  for (const p of new Set(pairs)) {
    if (!chain.pairTotalSen.has(p)) { unknown.push(p); continue; }
    total += chain.pairTotalSen.get(p);
  }
  return { sen: total, unknown };
}

/**
 * Does the book agree with ITSELF about this invoice? The line export
 * (ac-reconcile-truth) against the header export (ac-invoice-refs).
 *
 * ⚠ THE TWO EXPORTS ARE NOT IN THE SAME CURRENCY, AND THE DIFFERENCE LOOKS
 * EXACTLY LIKE CORRUPTION. `PIDTL.SubTotal` is the DOCUMENT's currency;
 * `PI.NetTotal` as the header export carries it is the LOCAL one. Measured on
 * the committed snapshot: 5,259 of 5,279 live purchase invoices agree to the
 * sen and the 20 that do not are ALL CNY —
 *
 *     PI-001222  lines 1,635,817 sen (CNY)   header 2,641,055 sen (MYR)
 *                1,635,817 / 0.61938 = 2,641,055 exactly, and BOTH exports
 *                state that same rate.
 *
 * So the gap is an EXCHANGE RATE, not a defect and not a discount. Reporting it
 * as "the book disagrees with itself" would be the 0665 mistake in reverse —
 * that one read a rate as a discount and wrote RM 13,068.55 of imaginary money
 * onto a CNY purchase order (also docs/bugs/0721).
 *
 * NOTHING IS CONVERTED HERE. A rate is applied to CROSS-CHECK two exports, never
 * to produce a figure anything is written from: `commensurable: false` is
 * returned and callers refuse. Every figure this module hands out for a money
 * decision is the book's own document-currency subtotal.
 */
export function invoiceIdentity(chain, pi) {
  const lineSumSen = chain.invoiceLineSumSen.has(pi) ? chain.invoiceLineSumSen.get(pi) : null;
  const netTotalSen = chain.netTotalSen.has(pi) ? chain.netTotalSen.get(pi) : null;
  const currency = chain.currencyOf.get(pi) ?? null;
  const rate = chain.rateOf.get(pi) ?? null;
  const local = currency == null || (currency === 'MYR' && (rate == null || Number(rate) === 1));

  if (lineSumSen == null || netTotalSen == null) {
    return { lineSumSen, netTotalSen, currency, rate, commensurable: local, agree: false, why: 'the book states no such invoice' };
  }
  if (!local) {
    return {
      lineSumSen, netTotalSen, currency, rate, commensurable: false, agree: false,
      why: `${pi} is ${currency} at rate ${rate}: its lines are stated in ${currency} and its header in the local `
        + 'currency, so the two exports are not comparable. Not converted — a rate and a discount are not '
        + 'distinguishable from a total alone (docs/bugs/0665).',
    };
  }
  return {
    lineSumSen, netTotalSen, currency, rate, commensurable: true,
    agree: lineSumSen === netTotalSen,
    why: lineSumSen === netTotalSen ? 'the two exports agree to the sen' : 'the two exports of this book disagree',
  };
}

/**
 * THE GATE. Given an AutoCount purchase invoice and the ERP documents that
 * mirror part of it, is what we hold what the book says for THOSE pairs?
 *
 * `erpDocs` are `{ docNo, acDocNo, acScopeNo, totalSen }` — acDocNo is the
 * AutoCount RECEIPT, acScopeNo the AutoCount ORDER our document mirrors, and
 * totalSen what it would be worth after whatever the caller plans to write.
 *
 * @returns {{accepted: boolean, expectedSen: number|null, oursSen: number,
 *            outOfScopeSen: number, netTotalSen: number|null, pairs: string[],
 *            outOfScopePairs: string[], why: string}}
 */
export function invoiceGateVerdict(chain, pi, erpDocs) {
  const id = invoiceIdentity(chain, pi);
  const oursSen = erpDocs.reduce((t, d) => t + sen(d.totalSen), 0);
  const pairs = erpDocs
    .filter((d) => d.acDocNo && d.acScopeNo)
    .map((d) => pairKey(d.acDocNo, d.acScopeNo));
  const held = new Set(pairs);

  /* Everything this invoice bills, split by whether the migration carried it.
     Exact ONLY where the invoice bills the whole of each receipt — that is what
     lets the book's own (receipt x order) split stand in for an invoice-line
     split it never states. Where it does not, the share is reported as NOT
     DETERMINABLE rather than as a number nobody can defend. */
  const outOfScopePairs = [];
  let outOfScopeSen = 0;
  let outOfScopeExact = true;
  for (const gr of chain.receiptsOfInvoice.get(pi) ?? []) {
    const drew = chain.drawOnReceiptSen.get(pairKey(pi, gr)) ?? 0;
    if (drew !== (chain.receiptTotalSen.get(gr) ?? null)) outOfScopeExact = false;
    for (const po of chain.ordersOfReceipt.get(gr) ?? []) {
      const k = pairKey(gr, po);
      if (held.has(k)) continue;
      outOfScopePairs.push(k);
      outOfScopeSen += chain.pairTotalSen.get(k) ?? 0;
    }
  }

  const base = {
    oursSen, netTotalSen: id.netTotalSen, pairs, outOfScopePairs,
    outOfScopeSen: outOfScopeExact ? outOfScopeSen : null,
    outOfScopeExact,
  };

  if (!id.agree) return { ...base, accepted: false, expectedSen: null, why: id.why };

  const { sen: expectedSen, unknown } = expectedForPairs(chain, pairs);
  if (unknown.length) {
    return {
      ...base, accepted: false, expectedSen: null,
      why: `the book states no receipt line for ${unknown.join(', ')} — our document names a (receipt x order) `
        + 'pair the account book does not have. REFUSED rather than scored as zero.',
    };
  }

  if (oursSen !== expectedSen) {
    return {
      ...base, accepted: false, expectedSen,
      why: `on the ${pairs.length} pair(s) we hold the book states ${expectedSen} sen and ours would be `
        + `${oursSen} sen. That is a real difference at LINE grain, not a grain artefact.`,
    };
  }

  return {
    ...base, accepted: true, expectedSen,
    why: `ours matches the book on the ${pairs.length} pair(s) we hold (${expectedSen} sen). The rest of ${pi} is on `
      + `${outOfScopePairs.length} pair(s) the migration never carried`
      + (outOfScopeExact ? ` — ${outOfScopeSen} sen of it — ` : ' (share not determinable: this invoice bills only part of a receipt) — ')
      + "the owner's outstanding rule working, not money we are short of.",
  };
}
