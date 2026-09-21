// ---------------------------------------------------------------------------
// grn-scan-match — map a scanned supplier DELIVERY ORDER onto our OPEN purchase
// order lines, so the GR scanner can convert (never fabricate) a DRAFT GRN.
//
// SAFETY IS THE WHOLE POINT (tasks/PLAN-ocr-scan-gr-pi.md, slice 3):
//   * We CONVERT from a PO line (grn_items.purchase_order_item_id), so a receipt
//     always clears PO outstanding. We NEVER create a standalone GRN, and we
//     NEVER guess a wrong PO link.
//   * A scanned line becomes a `pick` ONLY when it resolves to EXACTLY ONE open
//     PO line. Zero matches or an ambiguous many-match leaves it UNMATCHED — the
//     operator completes it by hand. Losing signal is acceptable; a wrong link
//     is not.
//   * When NOTHING resolves, the caller lands a NEEDS-REVIEW job (no doc, slip
//     retained) rather than any document at all.
//
// This module is PURE: it takes pre-loaded open PO lines + supplier-SKU bindings
// and returns picks + an audit of what matched / did not. The DB reads live in
// grn-scan-load.ts so this core is unit-testable without a database.
//
// WHY BINDINGS. Production POs read `HC-PO-2609-166` / `2990-PO-2609-035`, but a
// supplier's printed "P.O. No" (e.g. DIGLANT's `PO-010070`) is the SUPPLIER's
// own reference and rarely equals ours — so PO-number matching usually MISSES
// and the line falls to item matching. The supplier's Article No / Barcode is
// NOT our SKU code either (supplier prints `AMN-SF9050 SOFA 2B(RHF)`, we store
// `9050-2B(RHF)`), so scm.supplier_material_bindings.supplier_sku -> item_code
// is the bridge. Confirmed read-only against prod 2026-09-19.
// ---------------------------------------------------------------------------

// One open, receivable PO line the scan can be received against.
export type OpenPoLine = {
  poItemId: string;
  poId: string;
  poNumber: string;
  supplierId: string | null;
  // Our internal item code (e.g. "9050-2B(RHF)").
  itemCode: string;
  materialName: string | null;
  // The supplier's own SKU stamped on the PO line, when present.
  supplierSku: string | null;
  // qty - received_qty on the PO line, already computed by the loader (>= 0).
  remaining: number;
};

// A supplier_material_bindings row, narrowed to the mapping this matcher needs:
// the supplier's SKU / barcode / AutoCount code -> our item code.
export type SupplierSkuBinding = {
  supplierSku: string | null;
  acItemCode: string | null;
  itemCode: string;
};

export type ScannedGrnLine = {
  // The supplier's printed item code / Article No, as read by the OCR.
  itemCode: string | null;
  barcode: string | null;
  description: string | null;
  qty: number;
};

export type MatchedPick = { poItemId: string; qty: number };

export type UnmatchedScanLine = {
  line: ScannedGrnLine;
  // Why it did not become a pick — plain enough for the operator note.
  reason: 'no_open_po_line' | 'ambiguous' | 'nothing_remaining';
  // When ambiguous, the candidate PO lines we refused to guess between.
  candidatePoItemIds: string[];
};

export type GrnMatchResult = {
  // The confident picks to hand createDraftGrnFromPoItems. Deduped by poItemId
  // (a delivery order listing the same line twice sums, then clamps to remaining).
  picks: MatchedPick[];
  // Distinct PO numbers the picks resolved to (for the operator note).
  matchedPoNumbers: string[];
  // Scanned lines that produced no confident pick.
  unmatched: UnmatchedScanLine[];
  // True when the scanned P.O. No matched one of our open POs by number, so the
  // whole receive is scoped to that PO (the highest-confidence path).
  poNumberMatched: boolean;
  matchedPoNumberValue: string | null;
};

// Normalise a code/number for comparison: uppercase, drop every non-alnum char.
// "HC-PO-2609-166" -> "HCPO2609166"; "9050-2B(RHF)" -> "90502BRHF";
// "AMN-SF9050 SOFA 2B(RHF)" -> "AMNSF9050SOFA2BRHF".
export function normalizeCode(v: string | null | undefined): string {
  return (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Match a scanned delivery order's lines onto open PO lines. Pure.
 *
 * @param scannedPoNo  the supplier-printed P.O. No (may be null / their own ref)
 * @param scannedLines the OCR'd delivery-order lines
 * @param openLines    every open+receivable PO line in scope (company-scoped by
 *                     the loader). When the scanned PO No matches one of these
 *                     lines' po_number, matching is RESTRICTED to that PO.
 * @param bindings     supplier_material_bindings rows (company-scoped) mapping a
 *                     supplier SKU / AutoCount code -> our item code.
 */
export function matchGrnScanToPoLines(
  scannedPoNo: string | null,
  scannedLines: ScannedGrnLine[],
  openLines: OpenPoLine[],
  bindings: SupplierSkuBinding[],
): GrnMatchResult {
  // supplier SKU / AutoCount code (normalised) -> our item codes (normalised).
  // A supplier SKU that maps to more than one item code carries every candidate
  // through; if that fans out to more than one OPEN PO line the scanned line is
  // resolved as ambiguous below and left for the operator — never guessed.
  const skuToItemCodes = new Map<string, Set<string>>();
  const add = (key: string | null, itemCode: string): void => {
    const k = normalizeCode(key);
    if (!k) return;
    const set = skuToItemCodes.get(k) ?? new Set<string>();
    set.add(normalizeCode(itemCode));
    skuToItemCodes.set(k, set);
  };
  for (const b of bindings) {
    add(b.supplierSku, b.itemCode);
    add(b.acItemCode, b.itemCode);
  }

  // PO-number scoping — does the scanned P.O. No equal one of our open POs?
  const scannedPoNorm = normalizeCode(scannedPoNo);
  let matchedPoNumberValue: string | null = null;
  if (scannedPoNorm) {
    for (const l of openLines) {
      if (normalizeCode(l.poNumber) === scannedPoNorm) { matchedPoNumberValue = l.poNumber; break; }
    }
  }
  const poNumberMatched = matchedPoNumberValue !== null;
  const scope = poNumberMatched
    ? openLines.filter((l) => l.poNumber === matchedPoNumberValue)
    : openLines;

  // Index the in-scope open lines by their item code AND their own supplier SKU,
  // both normalised, so a scanned line can match on either axis.
  const linesByItemCode = new Map<string, OpenPoLine[]>();
  const linesBySupplierSku = new Map<string, OpenPoLine[]>();
  const push = (m: Map<string, OpenPoLine[]>, key: string, line: OpenPoLine): void => {
    if (!key) return;
    const arr = m.get(key) ?? [];
    arr.push(line);
    m.set(key, arr);
  };
  for (const l of scope) {
    push(linesByItemCode, normalizeCode(l.itemCode), l);
    push(linesBySupplierSku, normalizeCode(l.supplierSku), l);
  }

  const pickQtyByPoItem = new Map<string, number>();
  const pickPoNumbers = new Map<string, string>(); // poItemId -> po_number
  const remainingById = new Map<string, number>();
  for (const l of scope) remainingById.set(l.poItemId, l.remaining);
  const unmatched: UnmatchedScanLine[] = [];
  const matchedPoNumberSet = new Set<string>();

  for (const sl of scannedLines) {
    if (!(sl.qty > 0)) continue; // a zero/blank qty line carries nothing to receive

    // Candidate item-code keys this scanned line could resolve to, in priority:
    // its own printed code (direct), then the supplier-SKU / barcode bindings.
    const candidateItemCodes = new Set<string>();
    const directItem = normalizeCode(sl.itemCode);
    if (directItem) candidateItemCodes.add(directItem);
    for (const raw of [sl.itemCode, sl.barcode]) {
      const mapped = skuToItemCodes.get(normalizeCode(raw));
      if (mapped) for (const ic of mapped) candidateItemCodes.add(ic);
    }

    // Collect distinct open PO lines this scanned line could be:
    //   - a PO line whose item_code is one of the candidate item codes, OR
    //   - a PO line whose OWN supplier_sku equals the scanned printed code/barcode.
    const hits = new Map<string, OpenPoLine>();
    for (const ic of candidateItemCodes) {
      for (const l of linesByItemCode.get(ic) ?? []) hits.set(l.poItemId, l);
    }
    for (const raw of [sl.itemCode, sl.barcode]) {
      for (const l of linesBySupplierSku.get(normalizeCode(raw)) ?? []) hits.set(l.poItemId, l);
    }

    const hitList = [...hits.values()];
    if (hitList.length === 0) {
      unmatched.push({ line: sl, reason: 'no_open_po_line', candidatePoItemIds: [] });
      continue;
    }
    if (hitList.length > 1) {
      // Ambiguous — refuse to guess which PO line this delivery row clears.
      unmatched.push({ line: sl, reason: 'ambiguous', candidatePoItemIds: hitList.map((l) => l.poItemId) });
      continue;
    }
    const hit = hitList[0];
    const already = pickQtyByPoItem.get(hit.poItemId) ?? 0;
    const remaining = remainingById.get(hit.poItemId) ?? 0;
    if (remaining <= 0) {
      unmatched.push({ line: sl, reason: 'nothing_remaining', candidatePoItemIds: [hit.poItemId] });
      continue;
    }
    // Clamp the running total for this PO line to its remaining qty (a delivery
    // order can never receive more than the PO still owes; the operator adjusts
    // on the draft if the physical delivery differs).
    const want = already + sl.qty;
    pickQtyByPoItem.set(hit.poItemId, Math.min(want, remaining));
    pickPoNumbers.set(hit.poItemId, hit.poNumber);
    matchedPoNumberSet.add(hit.poNumber);
  }

  const picks: MatchedPick[] = [...pickQtyByPoItem.entries()]
    .filter(([, qty]) => qty > 0)
    .map(([poItemId, qty]) => ({ poItemId, qty }));

  return {
    picks,
    matchedPoNumbers: [...matchedPoNumberSet],
    unmatched,
    poNumberMatched,
    matchedPoNumberValue,
  };
}
