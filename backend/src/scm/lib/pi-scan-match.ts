
import type { PiScanExtract, PiScanLine } from './pi-scan-extract';

/** Normalize a document reference for comparison: uppercase, alphanumerics
 *  only. "PO-010070" and "HC-PO-010070" both become …"PO010070"-suffixed, so a
 *  supplier's bare number still anchors to our prefixed one. */
export function normalizeDocRef(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const EXCHANGE_MARK = /^(?:EXCH|EX)(?:\s*-\s*|\s+)(?=[A-Z0-9])/i;
const printedRefs = (printed: string | null | undefined): string[] =>
  (printed ?? '').split(/[,;&\n]|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);

/** Each D.O. or PO an invoice names: it may print several in one field. An
 *  exchange mark ("EX-", "EX ", "EXCH-") is dropped, leaving the order it replaces. */
export function docRefsOf(printed: string | null | undefined): string[] {
  return printedRefs(printed).map((s) => s.replace(EXCHANGE_MARK, '').trim()).filter(Boolean);
}

/** The references the invoice marks as exchange, without the mark. */
export function exchangeRefsOf(printed: string | null | undefined): string[] {
  return printedRefs(printed).filter((s) => EXCHANGE_MARK.test(s)).map((s) => s.replace(EXCHANGE_MARK, '').trim()).filter(Boolean);
}

/** The PO refs for a sentence, and what the invoice's exchange mark means. */
export function poRefsNote(poNo: string | null | undefined): { refs: string; exchange: string | null } {
  const refs = docRefsOf(poNo);
  const ex = exchangeRefsOf(poNo);
  return {
    refs: refs.length > 0 ? refs.join(', ') : (poNo ?? ''),
    exchange: ex.length > 0 ? `The invoice marks ${ex.join(', ')} as exchange (EX): replacement goods for those orders.` : null,
  };
}

/** A row printed at RM 0: a replacement or a free gift, nothing to bill. */
export function isFreePrice(unitPrice: number | null | undefined, lineTotal: number | null | undefined): boolean {
  return unitPrice === 0 || (unitPrice == null && lineTotal === 0);
}

export function docRefMatches(scanned: string | null | undefined, ours: string | null | undefined): boolean {
  const a = normalizeDocRef(scanned);
  const b = normalizeDocRef(ours);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 5 && longer.endsWith(shorter);
}

/** Normalize an item code / article number for equality matching. */
export function normalizeCode(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().trim().replace(/\s+/g, ' ');
}

/** The size a code ends with, "(Q)" in "DIVAN-(Q)"; null when it names none. */
export function sizeTag(code: string | null | undefined): string | null {
  const m = /\(([^()]+)\)\s*$/.exec(normalizeCode(code));
  return m ? m[1]! : null;
}

/** A learned or bound code may stand in for the printed one only when it does not name
 *  another size: a printed queen is never billed against a king. */
export function sameSize(printed: string | null | undefined, ours: string | null | undefined): boolean {
  const a = sizeTag(printed);
  const b = sizeTag(ours);
  return a == null || b == null || a === b;
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

  const consumed = new Map<string, number>();
  const remainingOf = (g: PiMatchGrnLine): number => g.remaining - (consumed.get(g.grnItemId) ?? 0);

  const picks: PiMatchPick[] = [];
  const unmatched: PiMatchUnmatched[] = [];
  let matchedLineCount = 0;

  invoiceLines.forEach((line, invoiceLineIndex) => {
    const wantRaw = line.qty;
    if (wantRaw == null || !(wantRaw > 0)) {
      unmatched.push({
        invoiceLineIndex, itemCode: line.itemCode, articleNo: line.articleNo,
        description: line.description, qty: line.qty, billed: 0, reason: 'no_qty',
      });
      return;
    }

    const candidateCodes = new Set<string>();
    for (const raw of [line.itemCode, line.articleNo]) {
      const c = normalizeCode(raw);
      if (c) candidateCodes.add(c);
    }
    const skuCode = normalizeCode(line.articleNo) || normalizeCode(line.itemCode);
    const mapped = skuCode ? bindingBySku.get(skuCode) : undefined;
    if (mapped && sameSize(skuCode, mapped)) candidateCodes.add(normalizeCode(mapped));

    const free = isFreePrice(line.unitPrice, line.lineTotal);
    const matches = [...candidateCodes].flatMap((c) => byCode.get(c) ?? []).filter((g) => !free || g.unitPriceSen === 0);
    if (matches.length === 0) {
      unmatched.push({
        invoiceLineIndex, itemCode: line.itemCode, articleNo: line.articleNo,
        description: line.description, qty: line.qty, billed: 0, reason: 'no_code_match',
      });
      return;
    }

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
    if (billed < Math.floor(wantRaw)) {
      unmatched.push({
        invoiceLineIndex, itemCode: line.itemCode, articleNo: line.articleNo,
        description: line.description, qty: line.qty, billed, reason: 'qty_short',
      });
    }
  });

  return { picks, unmatched, matchedLineCount };
}
