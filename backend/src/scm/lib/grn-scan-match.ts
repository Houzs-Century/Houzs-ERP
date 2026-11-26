
import { byPrintedColour } from './grn-scan-colour';

export type OpenPoLine = {
  poItemId: string;
  poId: string;
  poNumber: string;
  supplierId: string | null;
  itemCode: string;
  materialName: string | null;
  supplierSku: string | null;
  remaining: number;
  locationCode: string | null;
  warehouseId?: string | null;
  description2?: string | null;
  soDocNo?: string | null;
  itemGroup?: string | null;
  colours?: string[] | null;
};

export type SupplierSkuBinding = {
  supplierSku: string | null;
  acItemCode: string | null;
  itemCode: string;
};

export type ScannedGrnLine = {
  itemCode: string | null;
  barcode: string | null;
  description: string | null;
  qty: number;
  poNo?: string | null;
  rack?: string | null;
};

export type MatchedPick = { poItemId: string; qty: number };

export type PoStatusRef = { poNumber: string; status: string; supplierId?: string | null; supplierName?: string | null; onHold?: boolean };

export type SupplierRef = { id: string; code: string | null; name: string | null };

export type GrnMatchRefusal = 'supplier_unknown' | 'multiple_pos';

export type UnmatchedScanLine = {
  line: ScannedGrnLine;
  reason: 'no_open_po_line' | 'ambiguous' | 'nothing_remaining' | 'po_not_open' | 'no_po_number' | 'not_on_po' | 'colour_not_on_po' | 'not_received';
  candidatePoItemIds: string[];
};

export type GrnMatchResult = {
  picks: MatchedPick[];
  matchedPoNumbers: string[];
  unmatched: UnmatchedScanLine[];
  poNumberMatched: boolean;
  matchedPoNumberValue: string | null;
  refused: GrnMatchRefusal | null;
  weakMatch: { matched: number; scanned: number } | null;
  poFallback: string | null;
  qtyMismatch: Array<{ poNumber: string; listed: number; owed: number }> | null;
  nameMatches: Array<{ line: ScannedGrnLine; itemCode: string }>;
  soMatches: Array<{ line: ScannedGrnLine; soDocNo: string; poItemIds: string[] }>;
  racks: Record<string, string>;
  rackQty: Record<string, Record<string, number>>;
  rowOf: Record<string, ScannedGrnLine>;
  namedPos: string[];
};

/** The warehouse's X beside a row, written where the rack goes: not received. */
export function markedNotReceived(rack: string | null | undefined): boolean {
  return /^\s*[xX×✕✖✗✘]\s*$/.test(rack ?? '');
}

export function normalizeCode(v: string | null | undefined): string {
  return (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalizeSupplierName(v: string | null | undefined): string {
  return normalizeCode((v ?? '').replace(/\(M\)/gi, ''))
    .replace(/(SENDIRIANBERHAD|SDNBHD|BERHAD|BHD|PLT|LLP)$/, '');
}

const PO_PARTS = /^(.*?PO)-?(\d{4})-?(\d+)\s*$/i;

function oneDigitOffInMonth(printed: string, own: string): boolean {
  const a = PO_PARTS.exec(printed.trim());
  const b = PO_PARTS.exec(own.trim());
  if (!a || !b || a[1]!.toUpperCase() !== b[1]!.toUpperCase() || a[3] !== b[3]) return false;
  return [...a[2]!].filter((d, i) => d !== b[2]![i]).length === 1;
}

export function resolvePrintedPo<T extends { poNumber: string }>(
  printed: string | null | undefined,
  pos: T[],
  allowTail: boolean,
): T | null {
  const p = normalizeCode((printed ?? '').replace(/[_\s-]*R\d+\s*$/i, ''));
  if (!p) return null;
  const unique = (hits: T[]): T | null => {
    const byNumber = new Map(hits.map((h) => [h.poNumber, h]));
    return byNumber.size === 1 ? [...byNumber.values()][0] : null;
  };
  const exact = pos.filter((r) => normalizeCode(r.poNumber) === p);
  if (exact.length > 0) return unique(exact);
  const labelled = pos.filter((r) => {
    const n = normalizeCode(r.poNumber);
    return n.length > 0 && p.endsWith(n);
  });
  if (labelled.length > 0) return unique(labelled);
  if (!allowTail) return null;
  const typed = unique(pos.filter((r) => oneDigitOffInMonth(printed ?? '', r.poNumber)));
  if (typed) return typed;
  if ((p.match(/\d/g)?.length ?? 0) < 6) return null;
  const tail = unique(pos.filter((r) => normalizeCode(r.poNumber).endsWith(p)));
  if (tail) return tail;
  if (/[A-Z]/.test(p)) return null;
  const digits = p.replace(/\D/g, '');
  return unique(pos.filter((r) => {
    const own = /PO-?([\d-]+)$/i.exec(r.poNumber)?.[1]?.replace(/\D/g, '') ?? '';
    return own.length >= 7 && digits.endsWith(own);
  }));
}

/** Our own PO number on the paper names the supplier for certain, whatever name its
 *  letterhead carries (DIGLANT MANUFACTURING delivers for EADECO REFORM). */
export function supplierOfPrintedPo(
  parsed: { poNo?: string | null; lines: ReadonlyArray<{ poNo?: string | null }> },
  allPos: Array<{ poNumber: string; supplierId?: string | null }>,
): string | null {
  const ids = new Set([parsed.poNo, ...parsed.lines.map((l) => l.poNo)].flatMap((po) => {
    const hit = (resolvePrintedPo(po, allPos, false) ?? resolvePrintedPo(splitInnerLocation(po)?.po, allPos, false))?.supplierId;
    return hit ? [hit] : [];
  }));
  return ids.size === 1 ? [...ids][0] : null;
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

  const openPos = [...new Set(supplierLines.map((l) => l.poNumber))].map((poNumber) => ({ poNumber }));
  const resolveOpenPo = (printed: string | null | undefined): string | null => {
    const direct = resolvePrintedPo(printed, openPos, supplierId !== null)?.poNumber ?? null;
    if (direct !== null || supplierId === null) return direct;
    const m = /^([A-Z]+)[\s-]+(\d.*)$/.exec((printed ?? '').trim().toUpperCase());
    const ships = (po: string | null, loc: string): boolean => po !== null && supplierLines.some((l) =>
      l.poNumber === po && normalizeCode((l.locationCode ?? '').trim().split(/\s+/)[0]) === loc);
    if (m) {
      const po = resolvePrintedPo(m[2], openPos, true)?.poNumber ?? null;
      return ships(po, m[1]) ? po : null;
    }
    const inner = splitInnerLocation(printed);
    if (!inner) return null;
    const po = resolvePrintedPo(inner.po, openPos, false)?.poNumber ?? null;
    return ships(po, inner.location) ? po : null;
  };

  const matchedPoNumberValue = resolveOpenPo(scannedPoNo);
  const poNumberMatched = matchedPoNumberValue !== null;

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

  const anchoredQty = new Map<string, number>();
  const itemOnlyQty = new Map<string, number>();
  const itemOnlyLines: Array<{ line: ScannedGrnLine; poItemId: string }> = [];
  const poNumberOf = new Map<string, string>();
  const unmatched: UnmatchedScanLine[] = [];
  const anchoredPos = new Set<string>();
  const anchoredScanQty = new Map<string, number>();
  let scannedCount = 0;
  let itemOnlyMatchedCount = 0;
  const nameMatches: GrnMatchResult['nameMatches'] = [];
  const soMatches: GrnMatchResult['soMatches'] = [];
  const rackOf = new Map<string, string | null>();
  const rackQty: Record<string, Record<string, number>> = {};
  const rowOf: Record<string, ScannedGrnLine> = {};
  const noteRack = (poItemId: string, row: ScannedGrnLine, qty: number): void => {
    rowOf[poItemId] ??= row;
    const r = (row.rack ?? '').trim();
    if (!r) return;
    const prev = rackOf.get(poItemId);
    rackOf.set(poItemId, prev === undefined || prev === r ? r : null);
    if (qty > 0) { const m = (rackQty[poItemId] ??= {}); m[r] = (m[r] ?? 0) + qty; }
  };
  const rowText = (row: ScannedGrnLine): string => `${row.itemCode ?? ''} ${row.description ?? ''}`;
  const sameItems = (lines: OpenPoLine[]): OpenPoLine[] => {
    const codes = new Set(lines.map((l) => normalizeCode(l.itemCode)));
    return supplierLines.filter((l) => codes.has(normalizeCode(l.itemCode)));
  };
  const spread = (qty: number, lines: OpenPoLine[], target: Map<string, number>, row: ScannedGrnLine): void => {
    let left = qty;
    for (const l of lines) {
      const room = (remainingById.get(l.poItemId) ?? 0) - (target.get(l.poItemId) ?? 0);
      if (left <= 0 || room <= 0) continue;
      const take = Math.min(left, room);
      target.set(l.poItemId, (target.get(l.poItemId) ?? 0) + take);
      poNumberOf.set(l.poItemId, l.poNumber);
      noteRack(l.poItemId, row, take);
      left -= take;
    }
  };

  for (const sl of scannedLines) {
    if (!(sl.qty > 0)) continue;
    // An X where the rack goes means it did not arrive (owner 2026-11-13, DO-2611-037).
    if (markedNotReceived(sl.rack)) { unmatched.push({ line: sl, reason: 'not_received', candidatePoItemIds: [] }); continue; }
    scannedCount += 1;

    let anchorPo: string | null = null;
    const linePoNorm = normalizeCode(sl.poNo);
    if (linePoNorm) {
      anchorPo = resolveOpenPo(sl.poNo);
      if (anchorPo === null) {
        unmatched.push({ line: sl, reason: 'po_not_open', candidatePoItemIds: [] });
        continue;
      }
    } else if (poNumberMatched) {
      anchorPo = matchedPoNumberValue;
    }
    if (anchorPo !== null) {
      anchoredPos.add(anchorPo);
      anchoredScanQty.set(anchorPo, (anchoredScanQty.get(anchorPo) ?? 0) + sl.qty);
    }

    const candidateItemCodes = new Set<string>();
    const directItem = normalizeCode(sl.itemCode);
    if (directItem) candidateItemCodes.add(directItem);
    for (const raw of [sl.itemCode, sl.barcode]) {
      const mapped = skuToItemCodes.get(normalizeCode(raw));
      if (mapped) for (const ic of mapped) candidateItemCodes.add(ic);
    }

    const hits = new Map<string, OpenPoLine>();
    for (const ic of candidateItemCodes) {
      for (const l of linesByItemCode.get(ic) ?? []) hits.set(l.poItemId, l);
    }
    for (const raw of [sl.itemCode, sl.barcode]) {
      for (const l of linesBySupplierSku.get(normalizeCode(raw)) ?? []) hits.set(l.poItemId, l);
    }

    const onAnchor = [...hits.values()].filter((l) => anchorPo === null || l.poNumber === anchorPo);
    const hitList = byPrintedColour(rowText(sl), onAnchor, sameItems(onAnchor));
    if (onAnchor.length > 0 && hitList.length === 0) {
      unmatched.push({ line: sl, reason: 'colour_not_on_po', candidatePoItemIds: [] });
      continue;
    }
    if (hitList.length === 0) {
      const pieces = anchorPo !== null ? supplierLines.filter((l) => l.poNumber === anchorPo) : supplierId !== null ? supplierLines : [];
      const set = setLinesBySo(sl, pieces.filter((l) => (remainingById.get(l.poItemId) ?? 0) > 0));
      if (set) {
        for (const l of set.lines) {
          anchoredPos.add(l.poNumber);
          spread(remainingById.get(l.poItemId) ?? 0, [l], anchoredQty, sl);
        }
        soMatches.push({ line: sl, soDocNo: set.soDocNo, poItemIds: set.lines.map((l) => l.poItemId) });
        continue;
      }
    }
    if (hitList.length === 0 && anchorPo !== null) {
      const poLines = supplierLines.filter((l) => l.poNumber === anchorPo);
      const item = nameMatchItem(sl.description, poLines);
      const owing = item === null ? [] : poLines.filter((l) => l.itemCode === item && (remainingById.get(l.poItemId) ?? 0) > 0);
      const lines = byPrintedColour(rowText(sl), owing, sameItems(owing));
      if (owing.length > 0 && lines.length === 0) {
        unmatched.push({ line: sl, reason: 'colour_not_on_po', candidatePoItemIds: [] });
        continue;
      }
      const specs = new Set(lines.map((l) => (l.description2 ?? '').trim()));
      const into = specs.size > 1 ? [pickBySpec(sl.description, lines)].filter((l): l is OpenPoLine => l !== null) : lines;
      if (item === null) {
        unmatched.push({ line: sl, reason: 'not_on_po', candidatePoItemIds: [] });
      } else if (into.length === 0) {
        unmatched.push({ line: sl, reason: lines.length === 0 ? 'nothing_remaining' : 'ambiguous', candidatePoItemIds: lines.map((l) => l.poItemId) });
      } else {
        spread(sl.qty, into, anchoredQty, sl);
        nameMatches.push({ line: sl, itemCode: item });
      }
      continue;
    }
    if (hitList.length === 0) {
      unmatched.push({ line: sl, reason: 'no_open_po_line', candidatePoItemIds: [] });
      continue;
    }
    const twins = hitList.length > 1
      && new Set(hitList.map((l) => l.poNumber)).size === 1
      && new Set(hitList.map((l) => `${normalizeCode(l.itemCode)}|${(l.description2 ?? '').trim()}`)).size === 1;
    if (twins) {
      const open = hitList.filter((l) => (remainingById.get(l.poItemId) ?? 0) > 0);
      if (open.length === 0) {
        unmatched.push({ line: sl, reason: 'nothing_remaining', candidatePoItemIds: hitList.map((l) => l.poItemId) });
        continue;
      }
      spread(sl.qty, open, anchorPo !== null ? anchoredQty : itemOnlyQty, sl);
      if (anchorPo === null) {
        itemOnlyLines.push({ line: sl, poItemId: open[0].poItemId });
        itemOnlyMatchedCount += 1;
      }
      continue;
    }
    const ofSo = hitList.length > 1 && anchorPo === null ? setLinesBySo(sl, hitList)?.lines ?? hitList : hitList;
    const hit = ofSo.length === 1 ? ofSo[0] : pickBySpec(sl.description, ofSo);
    if (!hit) {
      unmatched.push({ line: sl, reason: 'ambiguous', candidatePoItemIds: ofSo.map((l) => l.poItemId) });
      continue;
    }
    const remaining = remainingById.get(hit.poItemId) ?? 0;
    if (remaining <= 0) {
      unmatched.push({ line: sl, reason: 'nothing_remaining', candidatePoItemIds: [hit.poItemId] });
      continue;
    }
    const into = anchorPo !== null ? anchoredQty : itemOnlyQty;
    const before = into.get(hit.poItemId) ?? 0;
    into.set(hit.poItemId, Math.min(before + sl.qty, remaining));
    noteRack(hit.poItemId, sl, (into.get(hit.poItemId) ?? 0) - before);
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
    picks = toPicks(anchoredQty);
    for (const { line } of itemOnlyLines) {
      unmatched.push({ line, reason: 'no_po_number', candidatePoItemIds: [] });
    }
  } else {
    picks = toPicks(itemOnlyQty);
    const itemOnlyPoNumbers = new Set(picks.map((p) => poNumberOf.get(p.poItemId)));
    if (picks.length > 0) {
      if (supplierId === null) refused = 'supplier_unknown';
      else if (itemOnlyPoNumbers.size > 1) refused = 'multiple_pos';
      else if (itemOnlyMatchedCount * 2 <= scannedCount) weakMatch = { matched: itemOnlyMatchedCount, scanned: scannedCount };
    }
  }
  // The delivery order named open POs of a known supplier, yet no row lined up
  // by item (the supplier describes a set differently from our PO lines). Draft
  // everything still owed on them for the operator to correct, but only when
  // the delivery order's qty for each PO equals what it still owes. HC-0120: a
  // 7-mattress part delivery on a PO owing 15 drafted all 15. Never without a
  // resolved supplier: a printed number alone could name another supplier's PO.
  let poFallback: string | null = null;
  let qtyMismatch: GrnMatchResult['qtyMismatch'] = null;
  const owed = (po: string): number =>
    supplierLines.reduce((sum, l) => sum + (l.poNumber === po ? l.remaining : 0), 0);
  if (picks.length === 0 && refused === null && supplierId !== null && anchoredPos.size > 0) {
    const perPo = [...anchoredPos].map((po) => ({ poNumber: po, listed: anchoredScanQty.get(po) ?? 0, owed: owed(po) }));
    if (perPo.every((p) => p.listed === p.owed)) {
      for (const l of supplierLines) {
        if (!anchoredPos.has(l.poNumber) || l.remaining <= 0) continue;
        picks.push({ poItemId: l.poItemId, qty: l.remaining });
        poNumberOf.set(l.poItemId, l.poNumber);
      }
      if (picks.length > 0) poFallback = [...anchoredPos].join(', ');
    } else {
      qtyMismatch = perPo;
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
    poFallback,
    qtyMismatch,
    nameMatches,
    soMatches,
    racks: refused ? {} : Object.fromEntries([...rackOf].filter((e): e is [string, string] => e[1] !== null)),
    rackQty: refused ? {} : Object.fromEntries(Object.entries(rackQty).filter(([id]) => picks.some((p) => p.poItemId === id))),
    rowOf: refused ? {} : rowOf,
    namedPos: [...anchoredPos],
  };
}

// Words, plus each model with its short suffix joined ("FLEXICARE-C" also
// gives FLEXICAREC), so FLEXICARE-C and FLEXICARE-S on one PO tell apart (HC-0137).
const nameWords = (s: string | null | undefined): string[] => {
  const up = (s ?? '').toUpperCase();
  return [
    ...up.split(/[^A-Z0-9]+/).filter(Boolean),
    ...[...up.matchAll(/([A-Z]{4,})-([A-Z0-9]{1,2})\b/g)].map((m) => `${m[1]}${m[2]}`),
  ];
};
const joinedBase = (s: string | null | undefined): Map<string, string> =>
  new Map([...(s ?? '').toUpperCase().matchAll(/([A-Z]{4,})-([A-Z0-9]{1,2})\b/g)].map((m) => [`${m[1]}${m[2]}`, m[1]]));

/**
 * The one item code on a known PO that a delivery-order row names by product,
 * or null. An item's model words are the alphabetic words (4+ letters) of its
 * code and name that no other item on the PO has ("BULWARK"; "HAPPI SLEEP
 * SOLITUDE" when only one Happi Sleep item is ordered). The row must print
 * every one of them, a printed word counting when it starts with the model
 * word (MATT / MATTRESS). Words of the line's item group are not model words,
 * unless that leaves no item with a model word (AKEMI BULWARK MATTRESS / PILLOW:
 * the group word is then the only difference). A hyphen suffix ("FLEXICARE-C")
 * is a model word only while another item has the same base without it
 * ("FLEXICARE-S"); a lone ECOZONE-C matches a row that leaves the -C out.
 * Exactly one item must qualify; an item with no model
 * word of its own (three MAYBATCH sofa pieces) never does. "Happi Sleep Easy
 * Sleep Pillow" lacks SOLITUDE, so it is not the Solitude mattress.
 */
export function nameMatchItem(printed: string | null | undefined, poLines: OpenPoLine[]): string | null {
  const row = nameWords(printed);
  if (row.length === 0) return null;
  const toks = (printed ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const items = [...new Set(poLines.map((l) => l.itemCode))];
  const pick = (keepGroup: boolean): string | null => {
    const parts = new Map(items.map((ic) => {
      const lines = poLines.filter((l) => l.itemCode === ic);
      const names = lines.map((l) => `${ic} ${l.materialName ?? ''}`).join(' ');
      const group = lines.flatMap((l) => nameWords(l.itemGroup)).filter((g) => g.length >= 4);
      const generic = (w: string): boolean => !keepGroup && group.some((g) => g.startsWith(w) || w.startsWith(g));
      const bases = joinedBase(names);
      const words = nameWords(names).filter((w) => /^[A-Z]{4,}$/.test(w) && !generic(w));
      return [ic, { words: new Set(words), bases }];
    }));
    const hits = items.filter((ic) => {
      const mine = parts.get(ic)!;
      const model = [...mine.words].filter((w) => items.every((o) => o === ic || !parts.get(o)!.words.has(w)))
        .filter((w) => !mine.bases.has(w) || items.some((o) => o !== ic && parts.get(o)!.words.has(mine.bases.get(w)!)));
      const clash = [...mine.bases].some(([w, base]) => toks.some((t, i) => t === base && (toks[i + 1] ?? '').length >= 1 && toks[i + 1].length <= 2 && base + toks[i + 1] !== w));
      return !clash && model.length > 0 && model.every((w) => row.some((r) => r.startsWith(w)));
    });
    return hits.length === 1 ? hits[0] : null;
  };
  return pick(false) ?? pick(true);
}

const soKeys = (v: string | null | undefined): string[] =>
  [...(v ?? '').matchAll(/(?<![A-Z])SO-?(\d+(?:-\d+)*)/gi)]
    .map((m) => m[1].replace(/-/g, '').replace(/^0+/, ''))
    .filter((k) => k.length >= 4);

const codeSuffix = (code: string | null | undefined): string | null =>
  /\(([A-Z]{1,3})\)\s*$/i.exec((code ?? '').trim())?.[1]?.toUpperCase() ?? null;

/**
 * The PO lines a delivery-order row delivers as one set: the row prints one of
 * our SO numbers ("*HC-SO-013339", or "*SO-011717" without the company prefix)
 * and the PO holds lines raised for exactly that SO. When the row also prints a
 * model number those lines start with (DSL8030 -> 8030-2A(LHF)), only those.
 * Null when the row names no SO, or none of `poLines` belongs to it.
 */
export function setLinesBySo(row: ScannedGrnLine, poLines: OpenPoLine[]): { soDocNo: string; lines: OpenPoLine[] } | null {
  const keys = new Set(soKeys(`${row.itemCode ?? ''} ${row.description ?? ''}`));
  if (keys.size === 0) return null;
  const ofSo = poLines.filter((l) => soKeys(l.soDocNo).some((k) => keys.has(k)));
  const docs = new Set(ofSo.map((l) => l.soDocNo));
  if (ofSo.length === 0 || docs.size !== 1) return null;
  const models = new Set([...(row.itemCode ?? '').matchAll(/(\d{4,})/g)].map((m) => m[1]));
  const ofModel = ofSo.filter((l) => [/^(\d{4,})/.exec(l.itemCode)?.[1], /(\d{4,})/.exec(l.supplierSku ?? '')?.[1]].some((n) => n !== undefined && models.has(n)));
  if (models.size > 0) {
    const want = codeSuffix(row.itemCode);
    const lines = want === null ? ofModel : ofModel.filter((l) => [l.itemCode, l.supplierSku].some((c) => codeSuffix(c) === want));
    return lines.length > 0 ? { soDocNo: [...docs][0] as string, lines } : null;
  }
  return { soDocNo: [...docs][0] as string, lines: ofSo };
}

const PO_STATUS_WHY: Record<string, string> = {
  RECEIVED: 'is marked Received',
  CANCELLED: 'is marked Cancelled',
  DRAFT: 'is marked Draft',
};

export function pickBySpec(printed: string | null | undefined, hits: OpenPoLine[]): OpenPoLine | null {
  const words = (s: string): string => ` ${s.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).join(' ')} `;
  const row = words(printed ?? '');
  if (row.trim() === '') return null;
  const segs = hits.map((h) => [...new Set((h.description2 ?? '').split(' / ').map(words).filter((w) => w.trim() !== ''))]);
  const scores = segs.map((mine) => mine
    .filter((s) => !segs.every((other) => other.includes(s)))
    .filter((s) => row.includes(s)).length);
  const top = Math.max(...scores);
  if (top <= 0 || scores.filter((s) => s === top).length > 1) return null;
  return hits[scores.indexOf(top)];
}

/** "HC-SRW-PO-2610-091" -> { location: "SRW", po: "HC-PO-2610-091" }; else null. */
export function splitInnerLocation(printed: string | null | undefined): { location: string; po: string } | null {
  const m = /^([A-Z0-9]+)[\s-]+([A-Z]{2,4})[\s-]+(PO[\s-]*\d[\d\s-]*)$/.exec((printed ?? '').trim().toUpperCase());
  return m ? { location: m[2], po: `${m[1]}-${m[3]}` } : null;
}

/**
 * Why a printed PO cannot take this delivery order, in words the operator can
 * act on: its status, on hold, another supplier's PO (Hookka DO-2610-079 named
 * OHANA STUDIO's HC-PO-010086), or no open line found for it. Null when the printed
 * number is not a PO of ours at all.
 */
export function printedPoWhy(printed: string | null | undefined, allPos: PoStatusRef[], scanSupplierId: string | null): string | null {
  const inner = splitInnerLocation(printed);
  const po = resolvePrintedPo(printed, allPos, true) ?? (inner ? resolvePrintedPo(inner.po, allPos, false) : null);
  if (!po) return null;
  const known = PO_STATUS_WHY[po.status];
  if (known) return `PO ${po.poNumber} ${known}`;
  if (po.onHold) return `PO ${po.poNumber} is on hold`;
  if (po.supplierName && scanSupplierId !== null && po.supplierId && po.supplierId !== scanSupplierId) {
    return `PO ${po.poNumber} is ${po.supplierName}'s PO, not this supplier's`;
  }
  return `PO ${po.poNumber} shows no open line for this supplier in our search; open the PO to check its balance`;
}

function poNotOpenWhy(l: ScannedGrnLine, allPos: PoStatusRef[], scanSupplierId: string | null): string {
  return printedPoWhy(l.poNo, allPos, scanSupplierId) ?? `PO ${l.poNo ?? '?'} is not one of our POs`;
}

const UNMATCHED_WHY: Record<UnmatchedScanLine['reason'], (l: ScannedGrnLine, allPos: PoStatusRef[], scanSupplierId: string | null) => string> = {
  no_open_po_line: () => 'no open PO line',
  ambiguous: () => 'more than one PO line fits',
  nothing_remaining: () => 'its PO line shows 0 qty remaining',
  po_not_open: poNotOpenWhy,
  no_po_number: () => 'no PO printed on the row',
  not_on_po: () => 'not on the PO',
  colour_not_on_po: () => 'its colour is on no open PO line',
  not_received: () => 'the warehouse marked it X: not received',
};

const scanLineLabel = (l: ScannedGrnLine): string =>
  [l.itemCode, l.description].map((v) => (v ?? '').trim()).filter(Boolean).join(' ') || l.barcode || 'unreadable item';

const capped = (parts: string[], max: number): string =>
  `${parts.slice(0, max).join('; ')}${parts.length > max ? `; and ${parts.length - max} more` : ''}.`;

/**
 * Each unmatched scanned line with its qty and why, so the operator knows what
 * to add, or why nothing was created (a count alone told them nothing). Null
 * when every line matched. Capped so a long delivery order cannot flood the
 * note. `allPos` (every company PO, any status) says why a printed PO was refused.
 */
export function describeUnmatchedScanLines(unmatched: UnmatchedScanLine[], allPos: PoStatusRef[], scanSupplierId: string | null, max = 10): string | null {
  if (unmatched.length === 0) return null;
  return capped(unmatched.map(({ line: l, reason }) => `${scanLineLabel(l)} x${l.qty} (${UNMATCHED_WHY[reason](l, allPos, scanSupplierId)})`), max);
}

/** The scanned lines as read, for a draft built from the whole PO. */
export function listScanLines(lines: ScannedGrnLine[], max = 10): string {
  return capped(lines.map((l) => `${scanLineLabel(l)} x${l.qty}`), max);
}
