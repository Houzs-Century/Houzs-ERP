// Pure resolution logic for "put the REAL purchase-invoice price on a purchase
// line". No database, no network — so every safety rule below is unit-testable.
//
// THE RULES, and why each exists:
//
//  1. NEVER OVERWRITE. A line that already carries a non-zero price was either
//     entered by a human or already correct. We only ever fill a blank (0/NULL).
//     Overwriting is how a hand-corrected price silently reverts.
//
//  2. AMBIGUOUS IS A REFUSAL, NOT A GUESS. AutoCount publishes no line-to-line
//     key on PO -> GR -> PI, so a key can legitimately hold several lines. When
//     those lines disagree on price we DO NOT pick one (not max, not last, not
//     first). We leave the line blank and list it for a human. A blank is
//     visible and a gate refuses it; a plausible wrong number is silent forever.
//
//  3. THE MAPPING IS USED AC -> ERP ONLY. autocount-erp-mapping-1561.csv is
//     many-to-one (NB-KHJ21(Q) and HOK-1041 (Q) are both ERP VICTORIA-(Q)).
//     AC -> ERP is deterministic; the reverse is ambiguous and is never used to
//     pick a price. Because several AC codes can collapse onto one ERP code,
//     collapsing can only ever ADD ambiguity (rule 2 then refuses) — it can
//     never invent agreement that was not there.
//
//  4. ZERO IS NOT A PRICE. A PI line at 0.00 does not resolve anything; it is
//     reported as PI_UNPRICED. Writing 0 over 0 is a no-op that would only
//     inflate the "fixed" count.
//
//  5. IDEMPOTENT. planWrite() returns SKIP_ALREADY_PRICED once a value is in
//     place, so a second APPLY run writes nothing.

/** Normalise a document number so "PO 000255" and "PO-000255" are one key. */
export const normDoc = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Normalise an item code / free text for comparison. */
export const normCode = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/**
 * Build the AC item code -> ERP item code map from the mapping CSV rows.
 * Only the AC -> ERP direction (rule 3).
 */
export function buildAcToErp(csvRows) {
  const m = new Map();
  for (const r of csvRows) {
    const ac = normCode(r.ac_code);
    const erp = String(r.erp_code ?? "").trim();
    if (ac && erp) m.set(ac, erp);
  }
  return m;
}

/**
 * Index the extractor payload by (AutoCount PO number, ERP item code).
 *
 * That is the granularity the ERP can actually match on: our purchase lines
 * carry the ERP code and the PO's linked_ac_docno, and nothing else that ties
 * back to an AutoCount line. Desc2 is kept on every observation for provenance
 * and for the ambiguity report, but it is NOT part of the key, because the ERP
 * side has no field that reliably equals it.
 */
export function buildPriceIndex(rows, acToErp) {
  const idx = new Map();
  for (const r of rows) {
    if (r.status !== "RESOLVED" && r.status !== "AMBIGUOUS") continue;
    const erp = acToErp.get(normCode(r.acItem));
    if (!erp) continue; // unmapped AC item — cannot be tied to an ERP line
    const key = `${normDoc(r.poNo)}|${normCode(erp)}`;
    let e = idx.get(key);
    if (!e) { e = { prices: new Map(), unmappedFrom: [] }; idx.set(key, e); }
    for (const o of r.obs ?? []) {
      if (!(o.price > 0)) continue;
      const p = Math.round(Number(o.price) * 100); // MYR -> centi
      if (!e.prices.has(p)) {
        e.prices.set(p, { piNo: o.piNo, piDate: o.piDate, grNo: o.grNo, acItem: r.acItem, desc2: r.desc2 });
      }
    }
  }
  return idx;
}

/**
 * Resolve one ERP purchase line to a single invoice price.
 * Returns one of:
 *   { status: "RESOLVED",   priceCenti, piNo, piDate, grNo, acItem, desc2 }
 *   { status: "AMBIGUOUS",  prices: [centi...], sources: [{centi, piNo}...] }
 *   { status: "NO_INVOICE_PRICE" }
 */
export function resolvePrice(idx, acPoNo, erpCode) {
  const e = idx.get(`${normDoc(acPoNo)}|${normCode(erpCode)}`);
  if (!e || e.prices.size === 0) return { status: "NO_INVOICE_PRICE" };
  if (e.prices.size > 1) {
    const prices = [...e.prices.keys()].sort((a, b) => a - b);
    return {
      status: "AMBIGUOUS",
      prices,
      sources: prices.map((c) => ({ centi: c, piNo: e.prices.get(c).piNo })),
    };
  }
  const [centi, meta] = [...e.prices.entries()][0];
  return { status: "RESOLVED", priceCenti: centi, ...meta };
}

/**
 * Index the extractor's observations by (AutoCount GR number, AutoCount item).
 *
 * This is the RECEIPT-level view, not the PO-level one. It answers exactly one
 * question: "for the goods received on this GR, what did the invoice say?" —
 * which is the only honest way to cost a cutover stock layer, because a layer
 * knows its receipt (import-ac-stock-layers.mjs writes `AC <Src> <SrcDoc>` into
 * the movement's notes) and nothing else.
 */
export function buildGrPriceIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    for (const o of r.obs ?? []) {
      if (!(o.price > 0)) continue;
      const k = `${normDoc(o.grNo)}|${normCode(r.acItem)}`;
      if (!idx.has(k)) idx.set(k, new Map());
      idx.get(k).set(Math.round(Number(o.price) * 100), o.piNo);
    }
  }
  return idx;
}

/**
 * For each ZERO-COST cutover stock layer, ask whether its OWN receipt's invoice
 * carries a price. This is the measurement that decides whether reading the
 * invoice can cost the cutover lots at all — see the header of
 * stamp-real-po-costs.mjs. It is computed, never asserted from memory, so the
 * number in the PR can never go stale.
 *
 * `layers` are the rows of data/ac-stock-layers.json.gz, already filtered the
 * same way import-ac-stock-layers.mjs filters them (sofa excluded — whole-sofa
 * balances were deliberately never imported).
 */
export function measureLayerCostability(layers, grIdx) {
  const out = { total: 0, units: 0, resolved: [], ambiguous: 0, noInvoicePrice: 0, noSourceDoc: 0 };
  for (const l of layers) {
    if (Number(l.Cost) > 0) continue;
    out.total++;
    out.units += Number(l.Qty ?? 0);
    if (!l.SrcDoc) { out.noSourceDoc++; continue; }
    const m = grIdx.get(`${normDoc(l.SrcDoc)}|${normCode(l.ItemCode)}`);
    if (!m || m.size === 0) { out.noInvoicePrice++; continue; }
    if (m.size > 1) { out.ambiguous++; continue; }
    const [centi, piNo] = [...m.entries()][0];
    out.resolved.push({ itemCode: l.ItemCode, location: l.Location, qty: Number(l.Qty ?? 0), grNo: l.SrcDoc, centi, piNo });
  }
  return out;
}

/**
 * Decide what to do with one ERP line. `currentCenti` is what the line carries
 * today. This is the single place the never-overwrite and idempotency rules
 * live, so a test can pin them without a database.
 */
export function planWrite(currentCenti, resolution) {
  const cur = Number(currentCenti ?? 0);
  if (cur > 0) return { action: "SKIP", reason: "SKIP_ALREADY_PRICED" };
  if (resolution.status === "AMBIGUOUS") return { action: "SKIP", reason: "SKIP_AMBIGUOUS" };
  if (resolution.status !== "RESOLVED") return { action: "SKIP", reason: "SKIP_NO_INVOICE_PRICE" };
  if (!(resolution.priceCenti > 0)) return { action: "SKIP", reason: "SKIP_ZERO_PRICE" };
  return { action: "WRITE", priceCenti: resolution.priceCenti, piNo: resolution.piNo };
}
