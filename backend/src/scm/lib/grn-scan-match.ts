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
  // A PO number printed on THIS row (a consolidated delivery order lists one of
  // our POs per line). Absent / null when the row shows none.
  poNo?: string | null;
};

export type MatchedPick = { poItemId: string; qty: number };

// A suppliers row, narrowed to what resolveScannedSupplier compares against.
export type SupplierRef = { id: string; code: string | null; name: string | null };

// Why a scan with item-level hits was still refused (no document created).
//   supplier_unknown — no PO-number hit and the printed supplier did not
//                      resolve to exactly one of our suppliers.
//   multiple_pos     — no PO-number hit and the hits spread over several POs.
// Half or fewer lines hitting the one PO is not a refusal: the picks still
// become a DRAFT, flagged by weakMatch so the operator checks the PO.
export type GrnMatchRefusal = 'supplier_unknown' | 'multiple_pos';

export type UnmatchedScanLine = {
  line: ScannedGrnLine;
  // Why it did not become a pick — plain enough for the operator note.
  //   po_not_open   — the row printed a PO number that is not one of our open
  //                   POs (another document's ref, a fair/service item, a PO
  //                   already received). Never item-matched onto some other PO.
  //   no_po_number  — the row printed no PO while other rows did; an item-only
  //                   hit is not trusted next to rows that name their PO.
  reason: 'no_open_po_line' | 'ambiguous' | 'nothing_remaining' | 'po_not_open' | 'no_po_number';
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
  // Set when the confidence gate threw every pick away; picks is then [].
  refused: GrnMatchRefusal | null;
  // Set when no PO number was recognised and half or fewer of the scanned lines
  // hit the one PO: the draft may be against the wrong PO.
  weakMatch: { matched: number; scanned: number } | null;
};

// Normalise a code/number for comparison: uppercase, drop every non-alnum char.
// "HC-PO-2609-166" -> "HCPO2609166"; "9050-2B(RHF)" -> "90502BRHF";
// "AMN-SF9050 SOFA 2B(RHF)" -> "AMNSF9050SOFA2BRHF".
export function normalizeCode(v: string | null | undefined): string {
  return (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Normalise a company name: drop "(M)", every non-alnum char and a trailing
// legal suffix. "HOOKKA INDUSTRIES (M) SDN. BHD." -> "HOOKKAINDUSTRIES".
export function normalizeSupplierName(v: string | null | undefined): string {
  return normalizeCode((v ?? '').replace(/\(M\)/gi, ''))
    .replace(/(SENDIRIANBERHAD|SDNBHD|BERHAD|BHD|PLT|LLP)$/, '');
}

/**
 * Resolve the supplier printed on a delivery order to ONE of our suppliers, or
 * null. Exact (normalised name or code) first; else a unique containment match
 * (the letterhead often carries a registration number or address tail). More
 * than one candidate is null — never guessed.
 */
export function resolveScannedSupplier(scannedName: string | null, suppliers: SupplierRef[]): string | null {
  const n = normalizeSupplierName(scannedName);
  const code = normalizeCode(scannedName);
  if (n.length < 3) return null;
  const unique = (ids: string[]): string | null => {
    const set = new Set(ids);
    return set.size === 1 ? [...set][0] : null;
  };
  const exact = suppliers
    .filter((s) => normalizeSupplierName(s.name) === n || (normalizeCode(s.code) !== '' && normalizeCode(s.code) === code))
    .map((s) => s.id);
  if (exact.length > 0) return unique(exact);
  if (n.length < 5) return null;
  const contains = suppliers
    .filter((s) => {
      const sn = normalizeSupplierName(s.name);
      return sn.length >= 5 && (n.includes(sn) || sn.includes(n));
    })
    .map((s) => s.id);
  return unique(contains);
}

/**
 * Match a scanned delivery order's lines onto open PO lines. Pure.
 *
 * @param scannedPoNo  the supplier-printed P.O. No (may be null / their own ref)
 * @param scannedLines the OCR'd delivery-order lines. A line that prints its
 *                     own PO number is matched ONLY inside that PO; one whose
 *                     PO is not open is left unmatched, never item-matched.
 * @param openLines    every open+receivable PO line in scope (company-scoped by
 *                     the loader). When the scanned PO No matches one of these
 *                     lines' po_number, matching is RESTRICTED to that PO.
 * @param bindings     supplier_material_bindings rows (company-scoped) mapping a
 *                     supplier SKU / AutoCount code -> our item code.
 * @param supplierId   the delivery order's supplier (resolveScannedSupplier), or
 *                     null when unresolved. When set, only that supplier's PO
 *                     lines are candidates. Without a PO-number hit, a null
 *                     supplier refuses the scan, and the picks must land on ONE
 *                     PO covering more than half the scanned lines — a single
 *                     stray item-code hit once linked a delivery order to
 *                     another supplier's PO and posted the wrong receipt.
 */
export function matchGrnScanToPoLines(
  scannedPoNo: string | null,
  scannedLines: ScannedGrnLine[],
  openLines: OpenPoLine[],
  bindings: SupplierSkuBinding[],
  supplierId: string | null,
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

  const supplierLines = supplierId !== null
    ? openLines.filter((l) => l.supplierId === supplierId)
    : openLines;

  // Our open PO numbers, normalised -> as stored.
  const poNumberByNorm = new Map<string, string>();
  for (const l of supplierLines) poNumberByNorm.set(normalizeCode(l.poNumber), l.poNumber);

  // PO-number scoping — does the scanned header P.O. No equal one of our open POs?
  const matchedPoNumberValue = poNumberByNorm.get(normalizeCode(scannedPoNo)) ?? null;
  const poNumberMatched = matchedPoNumberValue !== null;

  // Index the open lines by their item code AND their own supplier SKU, both
  // normalised, so a scanned line can match on either axis. A line anchored to a
  // PO (header or its own printed PO) then keeps only that PO's hits.
  const linesByItemCode = new Map<string, OpenPoLine[]>();
  const linesBySupplierSku = new Map<string, OpenPoLine[]>();
  const push = (m: Map<string, OpenPoLine[]>, key: string, line: OpenPoLine): void => {
    if (!key) return;
    const arr = m.get(key) ?? [];
    arr.push(line);
    m.set(key, arr);
  };
  for (const l of supplierLines) {
    push(linesByItemCode, normalizeCode(l.itemCode), l);
    push(linesBySupplierSku, normalizeCode(l.supplierSku), l);
  }
  const remainingById = new Map<string, number>();
  for (const l of supplierLines) remainingById.set(l.poItemId, l.remaining);

  // Anchored = the line's PO is known by number (its own printed PO, else the
  // header's). Item-only picks are kept apart: they are trusted only when NO
  // line is anchored, and then only through the confidence gate below.
  const anchoredQty = new Map<string, number>();
  const itemOnlyQty = new Map<string, number>();
  const itemOnlyLines: Array<{ line: ScannedGrnLine; poItemId: string }> = [];
  const poNumberOf = new Map<string, string>(); // poItemId -> po_number
  const unmatched: UnmatchedScanLine[] = [];
  let scannedCount = 0;
  let itemOnlyMatchedCount = 0;

  for (const sl of scannedLines) {
    if (!(sl.qty > 0)) continue; // a zero/blank qty line carries nothing to receive
    scannedCount += 1;

    let anchorPo: string | null = null;
    const linePoNorm = normalizeCode(sl.poNo);
    if (linePoNorm) {
      anchorPo = poNumberByNorm.get(linePoNorm) ?? null;
      if (anchorPo === null) {
        unmatched.push({ line: sl, reason: 'po_not_open', candidatePoItemIds: [] });
        continue;
      }
    } else if (poNumberMatched) {
      anchorPo = matchedPoNumberValue;
    }

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

    const hitList = [...hits.values()].filter((l) => anchorPo === null || l.poNumber === anchorPo);
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
    const remaining = remainingById.get(hit.poItemId) ?? 0;
    if (remaining <= 0) {
      unmatched.push({ line: sl, reason: 'nothing_remaining', candidatePoItemIds: [hit.poItemId] });
      continue;
    }
    // Clamp the running total for this PO line to its remaining qty (a delivery
    // order can never receive more than the PO still owes; the operator adjusts
    // on the draft if the physical delivery differs).
    const into = anchorPo !== null ? anchoredQty : itemOnlyQty;
    into.set(hit.poItemId, Math.min((into.get(hit.poItemId) ?? 0) + sl.qty, remaining));
    poNumberOf.set(hit.poItemId, hit.poNumber);
    if (anchorPo === null) {
      itemOnlyLines.push({ line: sl, poItemId: hit.poItemId });
      itemOnlyMatchedCount += 1;
    }
  }

  const toPicks = (m: Map<string, number>): MatchedPick[] => [...m.entries()]
    .filter(([, qty]) => qty > 0)
    .map(([poItemId, qty]) => ({ poItemId, qty }));

  let picks: MatchedPick[];
  let refused: GrnMatchRefusal | null = null;
  let weakMatch: GrnMatchResult['weakMatch'] = null;
  if (anchoredQty.size > 0) {
    // At least one row named its PO: only rows that did are received. An
    // item-only hit beside them is how DO-2609-097's fair item (printed PO
    // ART-HOK-002) was posted against a customer's PO.
    picks = toPicks(anchoredQty);
    for (const { line } of itemOnlyLines) {
      unmatched.push({ line, reason: 'no_po_number', candidatePoItemIds: [] });
    }
  } else {
    picks = toPicks(itemOnlyQty);
    // Confidence gate when no PO number was printed that we recognise.
    const itemOnlyPoNumbers = new Set(picks.map((p) => poNumberOf.get(p.poItemId)));
    if (picks.length > 0) {
      if (supplierId === null) refused = 'supplier_unknown';
      else if (itemOnlyPoNumbers.size > 1) refused = 'multiple_pos';
      else if (itemOnlyMatchedCount * 2 <= scannedCount) weakMatch = { matched: itemOnlyMatchedCount, scanned: scannedCount };
    }
  }
  const matchedPoNumbers = [...new Set(picks.map((p) => poNumberOf.get(p.poItemId) ?? ''))].filter(Boolean);

  return {
    picks: refused ? [] : picks,
    matchedPoNumbers,
    unmatched,
    poNumberMatched,
    matchedPoNumberValue,
    refused,
    weakMatch,
  };
}

const UNMATCHED_WHY: Record<UnmatchedScanLine['reason'], (l: ScannedGrnLine) => string> = {
  no_open_po_line: () => 'no open PO line',
  ambiguous: () => 'more than one PO line fits',
  nothing_remaining: () => 'PO line already fully received',
  po_not_open: (l) => `PO ${l.poNo ?? '?'} is not open`,
  no_po_number: () => 'no PO printed on the row',
};

/**
 * The scanned lines left off the draft, written out so the operator knows what
 * to add (a count alone told them nothing). Null when every line matched. Capped
 * so a long delivery order cannot flood the GRN note.
 */
export function describeUnmatchedScanLines(unmatched: UnmatchedScanLine[], max = 10): string | null {
  if (unmatched.length === 0) return null;
  const parts = unmatched.slice(0, max).map(({ line: l, reason }) => {
    const what = [l.itemCode, l.description].map((v) => (v ?? '').trim()).filter(Boolean).join(' ') || l.barcode || 'unreadable item';
    return `${what} x${l.qty} (${UNMATCHED_WHY[reason](l)})`;
  });
  const more = unmatched.length > max ? `; and ${unmatched.length - max} more` : '';
  return `Not added, please add on the draft: ${parts.join('; ')}${more}.`;
}
