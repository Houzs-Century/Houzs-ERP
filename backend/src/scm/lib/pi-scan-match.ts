// ---------------------------------------------------------------------------
// pi-scan-match — turn a read supplier invoice (PiScanExtract) into the GRN
// LINE picks that pi-from-grn-core converts into a DRAFT Purchase Invoice.
//
// THE SAFETY RULE (tasks/PLAN-ocr-scan-gr-pi.md): a scan NEVER guesses a wrong
// link and NEVER fabricates a standalone PI. So the match is anchored on the
// DOCUMENT NUMBER first — the invoice's DO No against our grns.delivery_note_ref,
// then its PO No against our purchase_orders.po_number — and only WITHIN the
// GRN(s) that anchor identifies do we match line item codes. An invoice we
// cannot anchor to a received GRN produces ZERO picks: the caller then lands a
// needs-review outcome (a notice for the operator to bill the GRN by hand),
// never a PI billed against a guessed receipt.
//
// The doc-number and line-matching logic here is PURE (no DB, no clock) so it is
// unit-tested directly; pi-scan-run.ts does the reads and calls these.
//
// Confirmed against production 2026-09-19 (project anogrigyjbduyzclzjgn):
//   · grns.grn_number  = "HC-GRN-2609-069" / "2990-GRN-2609-018" (company prefix)
//   · grns.delivery_note_ref = the supplier's DO No, e.g. "DGSN26001880"
//   · purchase_orders.po_number = "HC-PO-010070"; the supplier writes the bare
//     "PO-010070" on the invoice — so PO matching is suffix-tolerant.
//   · supplier_material_bindings.supplier_sku -> item_code is the Article-No map
//     (for DIGLANT the two are identical; other suppliers differ).
// ---------------------------------------------------------------------------

import type { PiScanExtract, PiScanLine } from './pi-scan-extract';

/** Normalize a document reference for comparison: uppercase, alphanumerics
 *  only. "PO-010070" and "HC-PO-010070" both become …"PO010070"-suffixed, so a
 *  supplier's bare number still anchors to our prefixed one. */
export function normalizeDocRef(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Does a scanned reference identify our document number? Exact after
 *  normalization, or one is a suffix of the other (our "HCPO010070" ends with
 *  the supplier's "PO010070"). Empty scanned ref never matches. */
export function docRefMatches(scanned: string | null | undefined, ours: string | null | undefined): boolean {
  const a = normalizeDocRef(scanned);
  const b = normalizeDocRef(ours);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  // Guard against trivially-short suffixes matching by accident.
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 5 && longer.endsWith(shorter);
}

/** Normalize an item code / article number for equality matching. */
export function normalizeCode(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().trim().replace(/\s+/g, ' ');
}

/** A candidate outstanding GRN line the matcher can bill. */
export type PiMatchGrnLine = {
  grnItemId: string;
  grnNumber: string;
  itemCode: string;
  remaining: number;
  unitPriceSen: number;
};

/** One resolved pick, in the shape pi-from-grn-core wants (grnItemId + qty),
 *  plus provenance for the notice/audit. */
export type PiMatchPick = {
  grnItemId: string;
  qty: number;
  grnNumber: string;
  invoiceLineIndex: number;
};

export type PiMatchUnmatchedReason = 'no_qty' | 'no_code_match' | 'qty_short';

/** An invoice line the matcher could not (fully) bill — surfaced to the
 *  operator so nothing is silently dropped. */
export type PiMatchUnmatched = {
  invoiceLineIndex: number;
  itemCode: string | null;
  articleNo: string | null;
  description: string | null;
  qty: number | null;
  billed: number;
  reason: PiMatchUnmatchedReason;
};

export type PiLineMatchResult = {
  picks: PiMatchPick[];
  unmatched: PiMatchUnmatched[];
  /** invoice lines that produced at least one pick. */
  matchedLineCount: number;
};

/**
 * Match invoice lines to GRN lines by item code, allocating each invoice line's
 * quantity against the matching GRN lines' remaining-to-bill (FIFO by GRN
 * number, then by line). `bindingBySku` maps a supplier's Article No
 * (normalized) to OUR item code, for suppliers whose printed code differs from
 * ours (supplier_material_bindings.supplier_sku -> item_code).
 *
 * PURE. The GRN lines passed in are already anchored to the invoice's DO/PO by
 * the caller — this function only distributes quantities, it does not decide
 * which GRN to bill.
 */
export function matchInvoiceLinesToGrnLines(
  invoiceLines: PiScanLine[],
  grnLines: PiMatchGrnLine[],
  bindingBySku: Map<string, string>,
): PiLineMatchResult {
  // Index candidate GRN lines by normalized item code. Stable FIFO order so the
  // same invoice always allocates the same way (reproducible drafts).
  const byCode = new Map<string, PiMatchGrnLine[]>();
  const ordered = [...grnLines].sort((a, b) =>
    a.grnNumber !== b.grnNumber ? a.grnNumber.localeCompare(b.grnNumber) : a.grnItemId.localeCompare(b.grnItemId),
  );
  for (const g of ordered) {
    const key = normalizeCode(g.itemCode);
    if (!key) continue;
    const list = byCode.get(key) ?? [];
    list.push(g);
    byCode.set(key, list);
  }

  // Remaining-to-bill consumed WITHIN this batch (a GRN line may serve several
  // invoice lines, and must never be over-allocated across them).
  const consumed = new Map<string, number>();
  const remainingOf = (g: PiMatchGrnLine): number => g.remaining - (consumed.get(g.grnItemId) ?? 0);

  const picks: PiMatchPick[] = [];
  const unmatched: PiMatchUnmatched[] = [];
  let matchedLineCount = 0;

  invoiceLines.forEach((line, invoiceLineIndex) => {
    const wantRaw = line.qty;
    // A line with no readable positive quantity cannot be billed.
    if (wantRaw == null || !(wantRaw > 0)) {
      unmatched.push({
        invoiceLineIndex, itemCode: line.itemCode, articleNo: line.articleNo,
        description: line.description, qty: line.qty, billed: 0, reason: 'no_qty',
      });
      return;
    }

    // Resolve the code(s) to look for: the printed item code, the article no,
    // and the article no mapped through the supplier binding to our code.
    const candidateCodes = new Set<string>();
    for (const raw of [line.itemCode, line.articleNo]) {
      const c = normalizeCode(raw);
      if (c) candidateCodes.add(c);
    }
    const skuCode = normalizeCode(line.articleNo) || normalizeCode(line.itemCode);
    const mapped = skuCode ? bindingBySku.get(skuCode) : undefined;
    if (mapped) candidateCodes.add(normalizeCode(mapped));

    const matches = [...candidateCodes].flatMap((c) => byCode.get(c) ?? []);
    if (matches.length === 0) {
      unmatched.push({
        invoiceLineIndex, itemCode: line.itemCode, articleNo: line.articleNo,
        description: line.description, qty: line.qty, billed: 0, reason: 'no_code_match',
      });
      return;
    }

    // Allocate FIFO across the matching GRN lines' remaining.
    let want = Math.floor(wantRaw);
    if (want <= 0) want = 0;
    let billed = 0;
    for (const g of matches) {
      if (want <= 0) break;
      const avail = remainingOf(g);
      if (avail <= 0) continue;
      const take = Math.min(avail, want);
      picks.push({ grnItemId: g.grnItemId, qty: take, grnNumber: g.grnNumber, invoiceLineIndex });
      consumed.set(g.grnItemId, (consumed.get(g.grnItemId) ?? 0) + take);
      billed += take;
      want -= take;
    }

    if (billed > 0) matchedLineCount += 1;
    // Anything the invoice asked for beyond what the GRN(s) still had to bill —
    // the operator sees it (a real quantity mismatch to reconcile), and it never
    // over-bills the receipt.
    // Code matched (we returned early otherwise), so any shortfall — down to
    // zero when every matching GRN line was already consumed by an earlier
    // invoice line — is a quantity the receipt could not cover.
    if (billed < Math.floor(wantRaw)) {
      unmatched.push({
        invoiceLineIndex, itemCode: line.itemCode, articleNo: line.articleNo,
        description: line.description, qty: line.qty, billed, reason: 'qty_short',
      });
    }
  });

  return { picks, unmatched, matchedLineCount };
}
