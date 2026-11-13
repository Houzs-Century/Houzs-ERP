// ---------------------------------------------------------------------------
// grn-scan-check — the "check before it becomes a draft" step for delivery-
// order scans (owner 2026-11-03, after Hookka's scan modal). The scan reads and
// matches as before, but instead of minting the draft it keeps a working copy
// (scan_jobs.review) the operator edits: supplier, D.O. no, date, and each line
// with the PO line it receives into. Create then converts exactly those lines
// through createDraftGrnFromPoItems — the same core, the same safety: DRAFT
// only, always from PO lines, nothing standalone.
// ---------------------------------------------------------------------------

import type { GrnExtracted } from './grn-scan-extract';
import { byPrintedColour } from './grn-scan-colour';
import { isGiftRow, type GiftLine } from './grn-scan-gifts';
import type { GrnMatchResult, OpenPoLine } from './grn-scan-match';
import { bestLines, lineSizeOf, printedSize } from './scan-word-match';

/** One line of the working copy. `poItemId` null = not yet tied to a PO line
 *  (the operator picks one, marks it a free gift, or deletes the line); `gift`
 *  = received at RM0 as this product of ours, on no PO; `read` is what the
 *  paper said. */
export type ReviewLine = {
  key: string;
  poItemId: string | null;
  // The PO chosen on the row before its item is (the PO dropdown narrows the SKU one).
  poNumber: string | null;
  gift: { itemCode: string; name: string } | null;
  qty: number;
  // The rack the warehouse wrote beside the row, any product type; set on the draft line.
  rack: string | null;
  // Tied by the product name printed, not by a code: shown for the operator to check.
  suggested: boolean;
  read: { itemCode: string | null; description: string | null; qty: number; poNo: string | null } | null;
};

/** Bumped when a working copy starts holding more: older copies are rebuilt from the read. */
export const REVIEW_VERSION = 9;

export type GrnReview = {
  v: number;
  supplierId: string | null;
  // The supplier name as printed, kept beside the resolved one.
  supplierRead: string | null;
  doNo: string | null;
  // The day we received it: the day of the scan, never the date printed on the
  // delivery order, which reads as goods arriving early (owner 2026-11-06).
  deliveryDate: string | null;
  notes: string | null;
  lines: ReviewLine[];
};

let seq = 0;
const lineKey = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

const readOf = (l: { itemCode: string | null; description: string | null; qty: number; poNo?: string | null }) =>
  ({ itemCode: l.itemCode, description: l.description, qty: l.qty, poNo: l.poNo ?? null });

/** The first working copy, from the read and the matcher. Matched lines arrive
 *  tied to their PO line; lines the matcher could not place arrive untied with
 *  what was printed, so nothing read is silently dropped. */
export function buildReview(parsed: GrnExtracted | null, supplierId: string | null, match: GrnMatchResult | null, gifts: ReadonlyArray<GiftLine>, open: ReadonlyArray<OpenPoLine>, scanDate: string): GrnReview {
  const lines: ReviewLine[] = [];
  // Each piece of a set shows the one row that printed it.
  const setRow = new Map((match?.soMatches ?? []).flatMap((m) => m.poItemIds.map((id) => [id, readOf(m.line)] as const)));
  for (const p of match?.picks ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a match result built before rowOf existed has none
    const tie = { poItemId: p.poItemId, poNumber: null, gift: null, suggested: false, read: setRow.get(p.poItemId) ?? (match?.rowOf?.[p.poItemId] ? readOf(match.rowOf[p.poItemId]) : null) };
    // Rows of one PO line written onto different racks: one line per rack, each with its own qty.
    const shares = Object.entries(match?.rackQty[p.poItemId] ?? {});
    if (shares.length < 2) { lines.push({ key: lineKey(), ...tie, qty: p.qty, rack: match?.racks[p.poItemId] ?? null }); continue; }
    let left = p.qty;
    for (const [rack, q] of shares) {
      const take = Math.min(q, left);
      if (take <= 0) continue;
      lines.push({ key: lineKey(), ...tie, qty: take, rack });
      left -= take;
    }
    if (left > 0) lines.push({ key: lineKey(), ...tie, qty: left, rack: null });
  }
  for (const u of match?.unmatched ?? []) {
    if (u.line.qty <= 0) continue;
    // A printed code taught as a free gift arrives already marked as one.
    const taught = isGiftRow(u.line, gifts) ? gifts.find((g) => [u.line.itemCode, u.line.barcode].includes(g.printedCode)) : undefined;
    lines.push({
      key: lineKey(), poItemId: !taught && u.candidatePoItemIds.length === 1 ? u.candidatePoItemIds[0] : null,
      // The row's printed PO, when it is open for this supplier: the SKU list then
      // shows only what that PO still owes (DO-2611-037: 5567-1A on PO-2610-197,
      // which owes 5540-1A), so a person picks from two lines, not 640.
      poNumber: taught || u.candidatePoItemIds.length === 1 ? null : openPoNamed(u.line.poNo, open),
      gift: taught ? { itemCode: taught.itemCode, name: taught.name } : null, qty: u.line.qty, rack: u.line.rack ?? null, suggested: false, read: readOf(u.line),
    });
  }
  // A read the matcher never saw (supplier unknown, nothing matched): keep every printed line.
  if (!match && parsed) for (const l of parsed.lines) if (l.qty > 0) lines.push({ key: lineKey(), poItemId: null, poNumber: null, gift: null, qty: l.qty, rack: l.rack, suggested: false, read: readOf(l) });
  suggestByName(lines, open, [parsed?.poNo, match?.matchedPoNumberValue, ...(match?.matchedPoNumbers ?? []), ...(match?.qtyMismatch ?? []).map((m) => m.poNumber)]);
  return {
    v: REVIEW_VERSION,
    supplierId,
    supplierRead: parsed?.supplierName ?? null,
    doNo: parsed?.doNo ?? null,
    deliveryDate: scanDate,
    notes: null,
    lines: inPrintedOrder(lines, parsed?.lines ?? [], open, new Set(setRow.keys())),
  };
}

// Our PO numbers with the location inside ("HC-SBH-PO-2610-358") and without it are one PO.
// HC-SBH-PO-2610-358, SRW-2610-358, PO-2610-358 and HC-PO-2610-358_R1 are one PO: its
// running digits. KLPO10138-HC5324 is PO-010138 for sales order HC5324.
const poKey = (s: string): string => {
  const t = s.toUpperCase().replace(/[_\s-]*R\d+\s*$/, '');
  return (/PO[-\s]*([\d-]+)/.exec(t)?.[1] ?? t).replace(/\D/g, '').replace(/^0+/, '').slice(-7);
};
/** The open PO a printed number names, as our PO number, else null. */
function openPoNamed(printed: string | null | undefined, open: ReadonlyArray<OpenPoLine>): string | null {
  if (!printed) return null;
  const k = poKey(printed);
  const pos = [...new Set(open.filter((o) => poKey(o.poNumber) === k).map((o) => o.poNumber))];
  return pos.length === 1 ? pos[0] : null;
}
const words = (s: string | null | undefined): string[] => (s ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

/** Every word of our item code is printed on the row, MATT aside: AKEMI EQUINOX
 *  MATT (K) is "Mattress Akemi Medi+Health Equinox K King 183x190x30cm". */
export function nameFits(printed: string | null | undefined, itemCode: string): boolean {
  const row = new Set(words(printed));
  const need = words(itemCode).filter((w) => w !== 'MATT' && w !== 'MATTRESS');
  return need.length > 0 && need.every((w) => row.has(w));
}

/** The rows in the order the delivery order prints them, each with what it
 *  printed, so the card reads down beside the paper (owner 2026-11-04: "很难对账").
 *  A matched row knows only its PO line; it finds its printed row by name. A row
 *  matching nothing printed stays at the end. */
export function inPrintedOrder(lines: ReviewLine[], printed: GrnExtracted['lines'], open: ReadonlyArray<OpenPoLine>, setPieces: ReadonlySet<string>): ReviewLine[] {
  const placed = new Map<number, ReviewLine[]>();
  const rest: ReviewLine[] = [];
  const used = new Set<number>();
  const put = (i: number, l: ReviewLine) => { used.add(i); placed.set(i, [...(placed.get(i) ?? []), l]); };
  for (const l of lines) {
    const read = l.read;
    if (!read) continue;
    const same = (p: GrnExtracted['lines'][number]) => p.itemCode === read.itemCode && p.description === read.description;
    // A set's pieces share their row, so a row already placed still takes the next piece.
    const free = printed.findIndex((p, n) => !used.has(n) && same(p));
    const i = free >= 0 || !setPieces.has(l.poItemId ?? '') ? free : printed.findIndex(same);
    if (i >= 0) put(i, l); else rest.push(l);
  }
  for (const l of lines) {
    if (l.read) continue;
    const hit = open.find((o) => o.poItemId === l.poItemId);
    const code = hit?.itemCode;
    // A COVE-13 line never shows a COVE-09 row as its paper; a row on the line's own rack first.
    const known = open.filter((o) => o.itemCode === code);
    const fits = (p: GrnExtracted['lines'][number], n: number): boolean => !!hit && !!code && !used.has(n)
      && (nameFits(p.description, code) || p.itemCode === code)
      && byPrintedColour(`${p.itemCode ?? ''} ${p.description ?? ''}`, [hit], known).length > 0;
    const onRack = l.rack ? printed.findIndex((p, n) => fits(p, n) && (p.rack ?? '').trim() === l.rack) : -1;
    const i = onRack >= 0 ? onRack : printed.findIndex(fits);
    if (i >= 0) put(i, { ...l, read: readOf(printed[i]) }); else rest.push(l);
  }
  return [...[...placed].sort(([a], [b]) => a - b).flatMap(([, ls]) => ls), ...rest];
}

/** Tie rows the matcher left untied, by name. This fills a screen a person
 *  checks, so it may go further than the automatic draft could, but never
 *  guesses a PO: the row must fit a PO this delivery order is known to be for,
 *  or, with no such PO, exactly one open line of the supplier. Each line takes
 *  only what it still owes. */
/** One PO, a digit typed wrong in its year and month allowed: 2010279 is 2610279,
 *  the same running number (Nice Future, HC-PO-2010-279). */
const samePo = (a: string, b: string): boolean =>
  a === b || (a.length === b.length && a.length > 3 && a.slice(-3) === b.slice(-3)
    && [...a].filter((d, i) => d !== b[i]).length === 1);

export function suggestByName(lines: ReviewLine[], open: ReadonlyArray<OpenPoLine>, printedPos: ReadonlyArray<string | null | undefined>): void {
  const left = new Map(open.map((l) => [l.poItemId, l.remaining]));
  for (const l of lines) if (l.poItemId) left.set(l.poItemId, (left.get(l.poItemId) ?? 0) - l.qty);
  const onDoc = new Set(printedPos.filter((p): p is string => !!p).map(poKey));
  for (const l of lines) { const hit = open.find((o) => o.poItemId === l.poItemId); if (hit) onDoc.add(poKey(hit.poNumber)); }
  for (const l of lines) {
    if (l.poItemId || l.gift || !l.read?.description) continue;
    const rowPo = l.read.poNo ? poKey(l.read.poNo) : null;
    const owing = open.filter((o) => (left.get(o.poItemId) ?? 0) > 0);
    const size = printedSize(`${l.read.itemCode ?? ''} ${l.read.description}`);
    const named = owing.filter((o) => nameFits(l.read?.description, o.itemCode) && (!size || !lineSizeOf(o.itemCode) || lineSizeOf(o.itemCode) === size));
    const text = `${l.read.itemCode ?? ''} ${l.read.description}`;
    const byName = named.length > 0 ? named : bestLines(text, owing, (o) => `${o.itemCode} ${o.supplierSku ?? ''} ${o.materialName ?? ''}`);
    // Two lines of one code in two colours: only the line of the colour printed (HOOKKA DO-2611-035).
    const fits = byPrintedColour(text, byName, open.filter((o) => byName.some((f) => f.itemCode === o.itemCode)));
    const scoped = rowPo ? fits.filter((o) => samePo(poKey(o.poNumber), rowPo)) : onDoc.size > 0 ? fits.filter((o) => onDoc.has(poKey(o.poNumber))) : fits;
    if (scoped.length === 0 || (!rowPo && onDoc.size === 0 && scoped.length > 1)) continue;
    const pick = scoped.find((o) => (left.get(o.poItemId) ?? 0) >= l.qty) ?? scoped[0];
    l.poItemId = pick.poItemId;
    l.suggested = true;
    left.set(pick.poItemId, (left.get(pick.poItemId) ?? 0) - l.qty);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The operator's edit as saved: only known fields, quantities as non-negative
 *  numbers, at most 500 lines. Ownership of each PO line is checked at Create,
 *  by the convert core's company-scoped read. */
export function cleanReview(input: unknown): GrnReview | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const rawLines = Array.isArray(r.lines) ? r.lines.slice(0, 500) : [];
  const lines: ReviewLine[] = rawLines.map((x) => {
    const l = (x ?? {}) as Record<string, unknown>;
    const qty = Number(l.qty);
    const read = l.read && typeof l.read === 'object' ? (l.read as Record<string, unknown>) : null;
    const g = l.gift && typeof l.gift === 'object' ? (l.gift as Record<string, unknown>) : null;
    const giftCode = str(g?.itemCode);
    return {
      key: str(l.key) ?? lineKey(),
      // A line is one or the other: a gift is on no PO.
      poItemId: giftCode ? null : str(l.poItemId),
      poNumber: giftCode ? null : str(l.poNumber),
      gift: giftCode ? { itemCode: giftCode, name: str(g?.name) ?? giftCode } : null,
      rack: str(l.rack),
      suggested: l.suggested === true,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      read: read ? { itemCode: str(read.itemCode), description: str(read.description), qty: Number(read.qty) || 0, poNo: str(read.poNo) } : null,
    };
  });
  const date = str(r.deliveryDate);
  return {
    v: REVIEW_VERSION,
    supplierId: str(r.supplierId),
    supplierRead: str(r.supplierRead),
    doNo: str(r.doNo),
    deliveryDate: date && ISO.test(date) ? date : null,
    notes: str(r.notes),
    lines,
  };
}

/** What Create converts: lines tied to a PO line with a quantity, one pick per
 *  PO line (two rows of the same line add up). */
export function picksOf(review: GrnReview): Array<{ poItemId: string; qty: number }> {
  const byLine = new Map<string, number>();
  for (const l of review.lines) if (l.poItemId && l.qty > 0) byLine.set(l.poItemId, (byLine.get(l.poItemId) ?? 0) + l.qty);
  return [...byLine].map(([poItemId, qty]) => ({ poItemId, qty }));
}

/** For each PO line, the qty its rows put on each rack (as written), for
 *  applyScanRacks: split rows of one line keep their own racks. */
export function racksOf(review: GrnReview): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const l of review.lines) {
    if (!l.poItemId || !l.rack || !(l.qty > 0)) continue;
    const m = (out[l.poItemId] ??= {});
    m[l.rack] = (m[l.rack] ?? 0) + l.qty;
  }
  return out;
}

/** Printed code -> our item, from rows tied to a PO line, so the next delivery
 *  order of this supplier matches them without a person. */
export function codesToTeach(review: GrnReview, itemOf: (poItemId: string) => string | undefined): Array<{ printedCode: string; itemCode: string }> {
  return review.lines.flatMap((l) => {
    const item = l.poItemId ? itemOf(l.poItemId) : undefined;
    return item && l.read?.itemCode ? [{ printedCode: l.read.itemCode, itemCode: item }] : [];
  });
}

/** The free gifts to add to the draft: one per product, qty summed, keeping the
 *  code the supplier printed (the "teach once" key). */
export function giftsOf(review: GrnReview): GiftLine[] {
  const byItem = new Map<string, GiftLine>();
  for (const l of review.lines) {
    if (!l.gift || l.qty <= 0) continue;
    const prev = byItem.get(l.gift.itemCode);
    if (prev) prev.qty += l.qty;
    else byItem.set(l.gift.itemCode, { printedCode: l.read?.itemCode ?? '', itemCode: l.gift.itemCode, name: l.gift.name, qty: l.qty });
  }
  return [...byItem.values()];
}

/** Why a document cannot be created yet, in plain words, or null when it can. */
export function blockedReason(review: GrnReview, open: ReadonlyMap<string, OpenPoLine>): string | null {
  const picks = picksOf(review);
  if (picks.length === 0) return 'No line is tied to a PO line yet.';
  for (const p of picks) {
    const line = open.get(p.poItemId);
    if (!line) return 'A line points to a PO line that is no longer open.';
    if (p.qty > line.remaining) return `${line.itemCode} on ${line.poNumber}: ${p.qty} is more than the ${line.remaining} still owed.`;
  }
  return null;
}

const refKey = (s: string | null | undefined) => s?.replace(/\s+/g, '').toUpperCase() ?? '';

/** Spellings of a delivery order number to look for in the database, which
 *  compares exactly; duplicateOf then compares ignoring spacing and case. */
export const refVariants = (doNo: string): string[] => [...new Set([doNo, doNo.toUpperCase(), doNo.toLowerCase(), doNo.replace(/\s+/g, ''), refKey(doNo)])];

export type ExistingGrn = { id: string; grnNumber: string; supplierId: string | null; deliveryNoteRef: string | null; status: string; receivedAt: string | null };

/** "Already received" — a goods receipt of this supplier already carries this
 *  delivery order number. The operator still chooses: create anyway, or delete. */
export function duplicateOf(review: GrnReview, existing: ReadonlyArray<ExistingGrn>): ExistingGrn | null {
  const ref = refKey(review.doNo);
  if (!ref) return null;
  return existing.find((g) => refKey(g.deliveryNoteRef) === ref && (!review.supplierId || !g.supplierId || g.supplierId === review.supplierId)) ?? null;
}

/** The same delivery order twice in the waiting list, before any receipt exists:
 *  each later copy names the first. Id of the later copy -> file of the first. */
export function repeatsInList(docs: ReadonlyArray<{ id: string; fileName: string | null; review: GrnReview | null }>): Map<string, string> {
  const first = new Map<string, string>();
  const out = new Map<string, string>();
  for (const d of docs) {
    const ref = refKey(d.review?.doNo);
    if (!ref) continue;
    const key = `${d.review?.supplierId ?? ''}|${ref}`;
    const seen = first.get(key);
    if (seen === undefined) first.set(key, d.fileName ?? 'another scan');
    else out.set(d.id, seen);
  }
  return out;
}
