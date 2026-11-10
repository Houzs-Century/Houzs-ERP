// ---------------------------------------------------------------------------
// pi-scan-check — the "check before it becomes a draft" step for supplier
// invoices, the PI twin of grn-scan-check.ts (owner 2026-11-04: "PI也是需要").
// The working copy (scan_jobs.review) holds the invoice head and each row with
// the Goods Receipt line it bills. Create converts exactly those lines through
// createDraftPiFromGrnItems: DRAFT only, always from GRN lines, never over what
// is left to bill, the GRN's own price.
// ---------------------------------------------------------------------------

import { nameFits } from './grn-scan-check';
import type { PiScanExtract, PiScanLine } from './pi-scan-extract';
import { sameSize, type PiLineMatchResult } from './pi-scan-match';
import { proposeGrnLines, skuOfRow, type SkuRow } from './pi-scan-sku';
import { bestLines, familiesPrinted, familyOf, lineSizeOf, printedSize, wordsOf } from './scan-word-match';

/** A posted GRN line with something left to bill. */
export type BillableLine = {
  grnItemId: string; grnNumber: string; supplierId: string | null; poNumber: string | null;
  itemCode: string; supplierSku: string | null; description: string | null; remaining: number; unitPriceSen: number;
  receivedAt: string | null;
};

export type PiReviewLine = {
  key: string;
  grnItemId: string | null;
  // The GRN chosen on the row before its item is (narrows the SKU dropdown).
  grnNumber: string | null;
  qty: number;
  // Tied by the product name printed, not by a code: shown for the operator to check.
  suggested: boolean;
  // Tied by the AI reading the row against the supplier's open SKUs: shown as "AI match, please check".
  ai: boolean;
  read: { itemCode: string | null; description: string | null; qty: number; unitPrice: number | null; lineTotal: number | null } | null;
};

export type PiReview = {
  v: number;
  supplierId: string | null;
  supplierRead: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  doNo: string | null;
  poNo: string | null;
  notes: string | null;
  // What the sales tax did to the rows, or why the rows do not reach the invoice total.
  taxNote: string | null;
  // Which receipt lines the matcher was offered: the PO printed on the invoice,
  // or (none of those matched) every unbilled line of the receipt. null: no PO printed.
  lineTier: PiLineTier | null;
  lines: PiReviewLine[];
};

export type PiLineTier = 'invoice_po' | 'whole_receipt';

export const PI_REVIEW_VERSION = 5;

/** The invoice as read, rebuilt from a working copy's own rows, for a copy whose
 *  stored read is not kept (no scan sample): it can still take newer matching.
 *  Each row keeps its own pieces, so a printed row split across two GRN lines
 *  adds back to what was printed and two identical printed rows stay two. PURE. */
export function extractOfReview(r: PiReview): PiScanExtract | null {
  const lines: PiScanLine[] = r.lines
    .filter((l) => l.read && l.qty > 0)
    .map((l) => {
      const read = l.read!;
      const whole = read.qty === l.qty;
      return {
        itemCode: read.itemCode, articleNo: null, description: read.description, qty: l.qty,
        unitPrice: read.unitPrice, salesTax: null,
        lineTotal: whole ? read.lineTotal : read.unitPrice != null ? Math.round(read.unitPrice * l.qty * 100) / 100 : null,
      };
    });
  if (lines.length === 0) return null;
  return {
    supplierName: r.supplierRead, supplierCode: null, invoiceNumber: r.invoiceNumber, invoiceDate: r.invoiceDate,
    poNo: r.poNo, doNo: r.doNo, salesTax: null, totalAmount: null, lines,
  };
}

let seq = 0;
const lineKey = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;
const readOf = (l: PiScanLine) => ({ itemCode: l.itemCode ?? l.articleNo, description: l.description, qty: l.qty ?? 0, unitPrice: l.unitPrice, lineTotal: l.lineTotal });
/** One printed row across two builds of the working copy: its code and its name. */
export const readKey = (read: PiReviewLine['read']): string => (read ? `${read.itemCode ?? ''}|${read.description ?? ''}` : '');

/** One invoice row for a set ("DSL 8075 - 2 + L" x1 at RM 1,950), which the receipt
 *  holds piece by piece: when the pieces' prices add up to the row's within a fifth,
 *  the row becomes one row per piece, its price shared as the pieces' prices share. */
export function setPieces(row: PiReviewLine, lines: ReadonlyArray<BillableLine>): PiReviewLine[] | null {
  const printed = row.read?.unitPrice;
  if (!row.read || printed == null || printed <= 0 || row.qty !== 1 || lines.length < 2) return null;
  const sum = lines.reduce((a, l) => a + l.unitPriceSen, 0);
  const ratio = sum / (printed * 100);
  if (sum <= 0 || ratio < 0.8 || ratio > 1.25) return null;
  return lines.map((l) => {
    const unitPrice = Math.round((printed * l.unitPriceSen) / sum * 100) / 100;
    return { key: lineKey(), grnItemId: l.grnItemId, grnNumber: l.grnNumber, qty: 1, suggested: true, ai: row.ai, read: { ...(row.read as NonNullable<PiReviewLine['read']>), qty: 1, unitPrice, lineTotal: unitPrice } };
  });
}

/** Rows whose SKU is known but whose receipt line is not: a line of that SKU on
 *  the receipts the invoice is for, else the proposal across the supplier's open
 *  receipts (pi-scan-sku proposeGrnLines). Each is marked for the operator to check. */
export function tieToSkus(pending: ReadonlyArray<{ line: PiReviewLine; itemCode: string }>, open: ReadonlyArray<BillableLine>, anchored: ReadonlySet<string>, left: Map<string, number>, ai: boolean): void {
  const rest: Array<{ line: PiReviewLine; itemCode: string }> = [];
  for (const p of pending) {
    const on = open.filter((o) => o.itemCode === p.itemCode && anchored.has(o.grnNumber) && (left.get(o.grnItemId) ?? 0) > 0);
    if (on.length === 0) { rest.push(p); continue; }
    const pick = on.find((o) => (left.get(o.grnItemId) ?? 0) >= p.line.qty) ?? on[0]!;
    Object.assign(p.line, { grnItemId: pick.grnItemId, suggested: true, ai });
    left.set(pick.grnItemId, (left.get(pick.grnItemId) ?? 0) - p.line.qty);
  }
  const rows: SkuRow[] = rest.map((p) => ({ key: p.line.key, itemCode: p.itemCode, qty: p.line.qty }));
  const picked = proposeGrnLines(rows, open, left);
  for (const p of rest) {
    const id = picked.get(p.line.key);
    if (id) Object.assign(p.line, { grnItemId: id, suggested: true, ai });
  }
}

/** What each line still has to bill once the rows already tied take theirs. */
const leftAfter = (lines: ReadonlyArray<PiReviewLine>, open: ReadonlyArray<BillableLine>): Map<string, number> => {
  const left = new Map(open.map((l) => [l.grnItemId, l.remaining]));
  for (const l of lines) if (l.grnItemId) left.set(l.grnItemId, (left.get(l.grnItemId) ?? 0) - l.qty);
  return left;
};

/** The receipts the invoice is for: those it is anchored to and those its tied rows bill. */
const anchoredOf = (lines: ReadonlyArray<PiReviewLine>, open: ReadonlyArray<BillableLine>, anchorGrns: ReadonlyArray<string>): Set<string> => {
  const anchored = new Set(anchorGrns);
  for (const l of lines) { const hit = open.find((o) => o.grnItemId === l.grnItemId); if (hit) anchored.add(hit.grnNumber); }
  return anchored;
};

/** Tie rows the matcher left untied. First the SKU: the printed code, a model
 *  prefix the supplier's other sizes teach (1007-(K) is CODY-(K), so 1007-(Q) is
 *  CODY-(Q)), the model name printed, then the name heuristics. Then the line: on
 *  the receipts this invoice is anchored to, else the supplier's receipt holding
 *  most of the invoice, then the oldest, never a pick between two equally good. */
export function suggestBills(lines: PiReviewLine[], open: ReadonlyArray<BillableLine>, anchorGrns: ReadonlyArray<string>, families: ReadonlyMap<string, ReadonlySet<string>>, prefixes: ReadonlyMap<string, ReadonlySet<string>>): void {
  const left = leftAfter(lines, open);
  const anchored = anchoredOf(lines, open, anchorGrns);
  const pending: Array<{ line: PiReviewLine; itemCode: string }> = [];
  for (const l of [...lines]) {
    if (l.grnItemId || !l.read) continue;
    const owing = open.filter((o) => (left.get(o.grnItemId) ?? 0) > 0);
    const sku = skuOfRow(l.read.itemCode, l.read.description, prefixes, [...new Set(owing.map((o) => o.itemCode))]);
    if (sku) { pending.push({ line: l, itemCode: sku }); continue; }
    if (!l.read.description) continue;
    const printed = `${l.read.itemCode ?? ''} ${l.read.description}`;
    /* NB prints SB10-B11EC-KHJ50(A)(MH-12") 5 FTS for HILTON (A)-(Q): the code names
       the family through any size bound to this supplier, the row names the size. */
    const printedFamilies = familiesPrinted(printed, families);
    const size = printedSize(printed);
    const family = owing.filter((o) => printedFamilies.has(familyOf(o.itemCode)) && (!size || lineSizeOf(o.itemCode) === size));
    const named = family.length > 0 ? family : owing.filter((o) => nameFits(l.read?.description, o.itemCode));
    const fits = named.length > 0 ? named : bestLines(`${l.read.itemCode ?? ''} ${l.read.description}`, owing, (o) => `${o.itemCode} ${o.supplierSku ?? ''} ${o.description ?? ''}`);
    const scoped = anchored.size > 0 ? fits.filter((o) => anchored.has(o.grnNumber)) : fits;
    if (scoped.length === 0 || (anchored.size === 0 && scoped.length > 1)) {
      // One SKU on several receipts, or only off the anchored ones: the proposal decides.
      const skus = new Set(fits.map((o) => o.itemCode));
      if (skus.size === 1) pending.push({ line: l, itemCode: [...skus][0]! });
      continue;
    }
    const pieces = setPieces(l, scoped);
    if (pieces) {
      lines.splice(lines.indexOf(l), 1, ...pieces);
      for (const p of pieces) if (p.grnItemId) left.set(p.grnItemId, (left.get(p.grnItemId) ?? 0) - p.qty);
      continue;
    }
    const pick = scoped.find((o) => (left.get(o.grnItemId) ?? 0) >= l.qty) ?? scoped[0];
    l.grnItemId = pick.grnItemId;
    l.suggested = true;
    left.set(pick.grnItemId, (left.get(pick.grnItemId) ?? 0) - l.qty);
  }
  tieToSkus(pending, open, anchored, left, false);
  /* What is left of an anchored receipt, one row for one line of the same size:
     the invoice bills that receipt, so the last row of a size can only be that line. */
  const bySize = new Map<string, PiReviewLine[]>();
  for (const l of lines) {
    const size = l.grnItemId || !l.read ? null : printedSize(`${l.read.itemCode ?? ''} ${l.read.description ?? ''}`);
    if (size) bySize.set(size, [...(bySize.get(size) ?? []), l]);
  }
  /* ...unless the row prints a name the line does not carry: CODY printed, JAGER left on
     the receipt, is a bed the receipt does not hold, not the last one of the size. A row
     that prints only codes and generic words (NB's SB12-KHB(C)-NH79(A)) still fills. */
  const nameWords = (text: string): string[] => wordsOf(text).filter((w) => /^[A-Z]{4,}$/.test(w));
  for (const [size, rows] of bySize) {
    const lefts = open.filter((o) => anchored.has(o.grnNumber) && lineSizeOf(o.itemCode) === size && (left.get(o.grnItemId) ?? 0) > 0);
    if (rows.length !== 1 || lefts.length !== 1) continue;
    const read = rows[0]!.read;
    const named = nameWords(`${read?.itemCode ?? ''} ${read?.description ?? ''}`);
    const own = new Set(wordsOf(familyOf(lefts[0]!.itemCode)));
    if (named.length > 0 && !named.some((w) => own.has(w))) continue;
    rows[0]!.grnItemId = lefts[0]!.grnItemId;
    rows[0]!.suggested = true;
  }
}

/** Within this much of the receipt's price (RM) a row IS that price: a printed
 *  1,409.09 plus 10% is 1,549.999, and the PO says 1,550.00. */
const NEAR = 0.05;
const sen2 = (rm: number) => Math.round(rm * 100) / 100;
const rm = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The invoice prints rows before tax and the tax once at the bottom, and a PI
 *  price is what the goods cost us, tax in (owner 2026-11-06). So each priced row
 *  takes its share by amount, a free gift stays free, and a result next to the
 *  receipt's price is that price. A row printed at the receipt's price already
 *  holds its tax and takes no share. No rate is assumed: the tax is the invoice's,
 *  or its total less its rows, and neither read leaves the rows as printed.
 *  Returns what happened, for the card. */
export function addSalesTax(lines: PiReviewLine[], open: ReadonlyArray<BillableLine>, taxRead: number | null, total: number | null): string | null {
  const unitOf = (l: PiReviewLine) => l.read?.unitPrice ?? (l.read?.lineTotal != null && l.qty > 0 ? l.read.lineTotal / l.qty : 0);
  const priced = lines.filter((l) => unitOf(l) > 0);
  if (priced.length === 0) return null;
  const receiptPrice = (l: PiReviewLine) => {
    const hit = open.find((o) => o.grnItemId === l.grnItemId);
    return hit ? hit.unitPriceSen / 100 : null;
  };
  const near = (a: number, b: number | null) => b != null && Math.abs(a - b) <= NEAR;
  const amount = (l: PiReviewLine) => unitOf(l) * l.qty;
  const printed = priced.reduce((a, l) => a + amount(l), 0);
  const tax = taxRead ?? (total == null ? null : sen2(total - printed));
  if (tax == null || tax <= 0) return null;
  const notYet = priced.filter((l) => !near(unitOf(l), receiptPrice(l)));
  const taxed = notYet.length > 0 ? notYet : priced;
  const base = taxed.reduce((a, l) => a + amount(l), 0);
  const rate = tax / base;
  const free: PiReviewLine[] = [];
  for (const l of taxed) {
    const po = receiptPrice(l);
    const gross = unitOf(l) * (1 + rate);
    const unit = po != null && near(gross, po) ? po : sen2(gross);
    if (unit !== po) free.push(l);
    l.read = { ...l.read!, unitPrice: unit, lineTotal: sen2(unit * l.qty) };
  }
  const sum = () => sen2(priced.reduce((a, l) => a + (l.read?.lineTotal ?? 0), 0));
  /* Rounding left over goes on the biggest row the receipt does not fix. */
  const want = total ?? sen2(printed + tax);
  if (free.length > 0 && sum() !== want) {
    const big = free.reduce((a, l) => ((l.read?.lineTotal ?? 0) > (a.read?.lineTotal ?? 0) ? l : a));
    const lineTotal = sen2((big.read?.lineTotal ?? 0) + want - sum());
    big.read = { ...big.read!, lineTotal, unitPrice: sen2(lineTotal / big.qty) };
  }
  if (Math.abs(sum() - want) > NEAR) return `The rows add to RM ${rm(sum())}, the invoice says RM ${rm(want)}. Check the prices.`;
  return `Prices include sales tax RM ${rm(tax)}, shared across the rows.`;
}

/** What the supplier's codes teach: model words (familiesByModelWord) and model
 *  prefixes (pi-scan-sku modelPrefixes). */
export type SupplierCodes = { families: ReadonlyMap<string, ReadonlySet<string>>; prefixes: ReadonlyMap<string, ReadonlySet<string>> };
export const NO_CODES: SupplierCodes = { families: new Map(), prefixes: new Map() };

/** The first working copy. Matched rows arrive tied to their GRN line; rows the
 *  matcher could not place arrive with what was printed, so nothing read is
 *  silently dropped. `aiSkus` (printed row -> our SKU, readKey) ties what the
 *  rules left, marked as an AI match. */
export function buildPiReview(parsed: PiScanExtract | null, supplierId: string | null, match: PiLineMatchResult | null, open: ReadonlyArray<BillableLine>, anchorGrns: ReadonlyArray<string>, codes: SupplierCodes, aiSkus: ReadonlyMap<string, string> | null): PiReview {
  const lines: PiReviewLine[] = [];
  for (const p of match?.picks ?? []) {
    const printed = parsed?.lines[p.invoiceLineIndex];
    lines.push({ key: lineKey(), grnItemId: p.grnItemId, grnNumber: p.grnNumber, qty: p.qty, suggested: false, ai: false, read: printed ? readOf(printed) : null });
  }
  for (const u of match?.unmatched ?? []) {
    const left = (u.qty ?? 0) - u.billed;
    const printed = parsed?.lines[u.invoiceLineIndex];
    if (left > 0 && printed) lines.push({ key: lineKey(), grnItemId: null, grnNumber: null, qty: left, suggested: false, ai: false, read: readOf(printed) });
  }
  if (!match && parsed) for (const l of parsed.lines) if ((l.qty ?? 0) > 0) lines.push({ key: lineKey(), grnItemId: null, grnNumber: null, qty: l.qty ?? 0, suggested: false, ai: false, read: readOf(l) });
  suggestBills(lines, open, anchorGrns, codes.families, codes.prefixes);
  if (aiSkus && aiSkus.size > 0) {
    const pending = lines.flatMap((l) => { const sku = l.grnItemId ? undefined : aiSkus.get(readKey(l.read)); return sku ? [{ line: l, itemCode: sku }] : []; });
    tieToSkus(pending, open, anchoredOf(lines, open, anchorGrns), leftAfter(lines, open), true);
  }
  const taxNote = addSalesTax(lines, open, parsed?.salesTax ?? null, parsed?.totalAmount ?? null);
  // In the order the invoice prints them, so the card reads down beside the paper.
  const printedAt = new Map(parsed?.lines.map((l, i) => [l.description, i]) ?? []);
  const order = (l: PiReviewLine) => printedAt.get(l.read?.description ?? null) ?? Number.MAX_SAFE_INTEGER;
  return {
    v: PI_REVIEW_VERSION,
    supplierId,
    supplierRead: parsed?.supplierName ?? null,
    invoiceNumber: parsed?.invoiceNumber ?? null,
    invoiceDate: parsed?.invoiceDate ?? null,
    doNo: parsed?.doNo ?? null,
    poNo: parsed?.poNo ?? null,
    notes: null,
    taxNote,
    lineTier: null,
    lines: [...lines].sort((a, b) => order(a) - order(b)),
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The operator's edit as saved: only known fields, quantities non-negative, at
 *  most 500 rows. Ownership of each GRN line is checked at Create, by the
 *  convert core's company-scoped read. */
export function cleanPiReview(input: unknown): PiReview | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const lines: PiReviewLine[] = (Array.isArray(r.lines) ? r.lines.slice(0, 500) : []).map((x) => {
    const l = (x ?? {}) as Record<string, unknown>;
    const qty = Number(l.qty);
    const read = l.read && typeof l.read === 'object' ? (l.read as Record<string, unknown>) : null;
    return {
      key: str(l.key) ?? lineKey(),
      grnItemId: str(l.grnItemId),
      grnNumber: str(l.grnNumber),
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      suggested: l.suggested === true,
      ai: l.ai === true,
      read: read ? { itemCode: str(read.itemCode), description: str(read.description), qty: Number(read.qty) || 0, unitPrice: num(read.unitPrice), lineTotal: num(read.lineTotal) } : null,
    };
  });
  const date = str(r.invoiceDate);
  return {
    v: PI_REVIEW_VERSION,
    supplierId: str(r.supplierId),
    supplierRead: str(r.supplierRead),
    invoiceNumber: str(r.invoiceNumber),
    invoiceDate: date && ISO.test(date) ? date : null,
    doNo: str(r.doNo),
    poNo: str(r.poNo),
    notes: str(r.notes),
    taxNote: str(r.taxNote),
    lineTier: r.lineTier === 'invoice_po' || r.lineTier === 'whole_receipt' ? r.lineTier : null,
    lines,
  };
}

/** What Create converts: rows tied to a GRN line with a quantity, one per line. */
export function billPicks(review: PiReview): Array<{ grnItemId: string; qty: number; unitPriceSen: number | null }> {
  const byLine = new Map<string, { qty: number; pricedQty: number; sen: number }>();
  for (const l of review.lines) {
    if (!l.grnItemId || l.qty <= 0) continue;
    const seen = byLine.get(l.grnItemId) ?? { qty: 0, pricedQty: 0, sen: 0 };
    seen.qty += l.qty;
    const price = l.read?.unitPrice;
    if (price != null) { seen.pricedQty += l.qty; seen.sen += Math.round(price * 100) * l.qty; }
    byLine.set(l.grnItemId, seen);
  }
  /* Two printed rows on one receipt line can carry two prices: the line holds one, so their average by qty. */
  return [...byLine].map(([grnItemId, s]) => ({ grnItemId, qty: s.qty, unitPriceSen: s.pricedQty > 0 ? Math.round(s.sen / s.pricedQty) : null }));
}

/** Why a document cannot be created yet, in plain words, or null when it can. */
export function billBlocked(review: PiReview, open: ReadonlyMap<string, BillableLine>): string | null {
  const picks = billPicks(review);
  if (picks.length === 0) return 'Choose the SKU for at least one row.';
  for (const p of picks) {
    const line = open.get(p.grnItemId);
    if (!line) return 'A row points to a Goods Receipt line that is no longer open to bill.';
    if (p.qty > line.remaining) return `${line.itemCode} on ${line.grnNumber}: ${p.qty} is more than the ${line.remaining} left to bill.`;
  }
  return null;
}

const refKey = (s: string | null | undefined) => s?.replace(/\s+/g, '').toUpperCase() ?? '';

export type ExistingPi = { id: string; invoiceNumber: string; supplierId: string | null; supplierInvoiceRef: string | null; status: string; invoiceDate: string | null };

/** "Already billed" — a purchase invoice of this supplier already carries this
 *  supplier invoice number. The operator still chooses: create anyway, or delete. */
export function duplicatePi(review: PiReview, existing: ReadonlyArray<ExistingPi>): ExistingPi | null {
  const ref = refKey(review.invoiceNumber);
  if (!ref) return null;
  return existing.find((p) => refKey(p.supplierInvoiceRef) === ref && (!review.supplierId || !p.supplierId || p.supplierId === review.supplierId)) ?? null;
}

/** The same invoice twice in the waiting list: each later copy names the first. */
export function repeatedPis(docs: ReadonlyArray<{ id: string; fileName: string | null; review: PiReview | null }>): Map<string, string> {
  const first = new Map<string, string>();
  const out = new Map<string, string>();
  for (const d of docs) {
    const ref = refKey(d.review?.invoiceNumber);
    if (!ref) continue;
    const key = `${d.review?.supplierId ?? ''}|${ref}`;
    const seen = first.get(key);
    if (seen === undefined) first.set(key, d.fileName ?? 'another scan');
    else out.set(d.id, seen);
  }
  return out;
}

/** Printed code -> our item, from rows tied to a GRN line: the delivery-order
 *  scanner and this one share what is learned. */
export function billCodesToTeach(review: PiReview, itemOf: (grnItemId: string) => string | undefined): Array<{ printedCode: string; itemCode: string }> {
  return review.lines.flatMap((l) => {
    const item = l.grnItemId ? itemOf(l.grnItemId) : undefined;
    return item && l.read?.itemCode && sameSize(l.read.itemCode, item) ? [{ printedCode: l.read.itemCode, itemCode: item }] : [];
  });
}

/** A waiting copy rebuilt by newer matching: rows already tied stay as they are
 *  (the operator may have chosen them), a row still untied takes the newer
 *  build's tie for the same printed row, and a row the operator removed is not
 *  brought back. */
export function mergeRebuiltLines(kept: ReadonlyArray<PiReviewLine>, rebuilt: ReadonlyArray<PiReviewLine>): PiReviewLine[] {
  const used = new Set<string>();
  return kept.flatMap((l) => {
    if (l.grnItemId || !l.read) return [l];
    const key = readKey(l.read);
    const fresh = rebuilt.filter((r) => !used.has(r.key) && r.grnItemId && readKey(r.read) === key);
    if (fresh.length === 0) return [l];
    // A set split into its pieces comes back as several rows of the one printed row.
    const take = fresh.length > 1 && fresh.every((r) => r.qty === 1) && l.qty === 1 ? fresh : [fresh[0]!];
    for (const r of take) used.add(r.key);
    return take;
  });
}
