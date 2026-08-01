// Sofa "whole-set, all-or-nothing → must ship from ONE covering batch" guard.
//
// Wei Siang 2026-06-03 (corrected rule, replaces the earlier "no PO ⇒ block"):
// A sofa set ships like any other goods (by SKU + variant) EXCEPT it must be
// drawn as a COMPLETE set from ONE production batch (one dye lot). So the real
// thing to block is NOT "this line has no PO" — it's "there is no single live
// batch that holds the whole set". A sofa line may legitimately ship even with
// no PO of its own, as long as a complete matching batch is on hand; and a line
// WITH a PO still can't ship until that batch is physically received in full.
//
// THE HOLE THIS CLOSES: shipping a sofa line whose set has no single covering
// batch would either (a) split a dye lot across two batches (colour mismatch) or
// (b) partially consume a batch and strand an orphan half-set. So we BLOCK the
// ship at every DO-create entry point unless the SO line carries a bound batch
// (allocated_batch_no, set by so-stock-allocation only when ONE batch covers the
// whole set) AND that batch still has enough live stock for the line.
//
// Coverage uses the SAME helper as the allocator (sofa-set-coverage) so the
// "is there a covering batch?" answer can never drift between the two.

import { computeVariantKey, type VariantAttrs } from '../shared';
import { loadSofaBatchStock, sofaStockKey } from './sofa-set-coverage';

export type SofaGuardLine = {
  itemCode: string;
  itemGroup: string | null;
  soItemId: string | null;
};

export type SofaGuardOffender = { itemCode: string; soItemId: string | null };

/** Return the sofa/batched lines among `lines` that CANNOT ship — i.e. their set
 *  has no single production batch on hand that covers the whole line. Non-sofa
 *  lines (bedframe / mattress / accessories — plain FIFO) are never returned. A
 *  sofa line with no SO line, or no bound batch, or a bound batch that no longer
 *  has enough live stock, is an offender. */
export async function findSofaLinesWithoutCompleteBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  lines: SofaGuardLine[],
  companyId?: number | null,
): Promise<SofaGuardOffender[]> {
  if (lines.length === 0) return [];

  // 1. Identify sofa lines: product category SOFA, or item_group contains SOFA.
  const codes = [...new Set(lines.map((l) => l.itemCode).filter(Boolean))];
  const batchedCodes = new Set<string>();
  if (codes.length > 0) {
    let catQ = sb.from('mfg_products').select('code, category').in('code', codes);
    if (companyId != null) catQ = catQ.eq('company_id', companyId);
    const { data: catRows } = await catQ;
    for (const p of (catRows ?? []) as Array<{ code: string; category: string | null }>) {
      if ((p.category ?? '').toUpperCase() === 'SOFA') batchedCodes.add(p.code);
    }
  }
  const isSofa = (l: SofaGuardLine) =>
    batchedCodes.has(l.itemCode) || (l.itemGroup ?? '').toUpperCase().includes('SOFA');
  const sofaLines = lines.filter(isSofa);
  if (sofaLines.length === 0) return [];

  // 2. Pull each sofa line's SO row — warehouse, variant, qty, and the batch the
  //    allocator bound (allocated_batch_no, non-null only when ONE batch covers
  //    the whole set).
  type SoInfo = { whId: string | null; itemCode: string; variantKey: string; qty: number; batch: string | null };
  const soInfo = new Map<string, SoInfo>();
  const soItemIds = [...new Set(sofaLines.map((l) => l.soItemId).filter((x): x is string => !!x))];
  if (soItemIds.length > 0) {
    const { data: rows } = await sb
      .from('mfg_sales_order_items')
      .select('id, item_code, item_group, variants, qty, warehouse_id, allocated_batch_no')
      .in('id', soItemIds);
    for (const r of (rows ?? []) as Array<{
      id: string; item_code: string; item_group: string | null;
      variants: VariantAttrs | null; qty: number | null; warehouse_id: string | null; allocated_batch_no: string | null;
    }>) {
      soInfo.set(r.id, {
        whId: r.warehouse_id ?? null,
        itemCode: r.item_code,
        variantKey: computeVariantKey(r.item_group ?? null, r.variants ?? null),
        qty: Number(r.qty ?? 0),
        batch: r.allocated_batch_no ?? null,
      });
    }
  }

  // 3. Live batch stock to re-validate the bound batch still covers each line
  //    (it may have been consumed by another DO since the last allocation run).
  const sofaStock = await loadSofaBatchStock(sb, [...new Set([...soInfo.values()].map((s) => s.itemCode))]);

  // 4. Offenders. A line with no SO line / no bound batch / no warehouse can't
  //    ship — flag per line. The rest are grouped by (warehouse, batch, code,
  //    variant) and checked with their qty SUMMED against live batch stock, so
  //    two lines of the same module can't each pass against a batch that only
  //    covers one. (Audit fix 2026-06-03)
  const offenders: SofaGuardOffender[] = [];
  const coverable: Array<{ line: SofaGuardLine; info: SoInfo }> = [];
  for (const l of sofaLines) {
    const info = l.soItemId ? soInfo.get(l.soItemId) : undefined;
    if (!info || !info.batch || !info.whId) {
      offenders.push({ itemCode: l.itemCode, soItemId: l.soItemId ?? null });
    } else {
      coverable.push({ line: l, info });
    }
  }
  const groups = new Map<string, { have: number; need: number; lines: SofaGuardLine[] }>();
  for (const { line, info } of coverable) {
    const key = sofaStockKey(info.whId as string, info.batch as string, info.itemCode, info.variantKey);
    const g = groups.get(key) ?? { have: sofaStock.remaining.get(key) ?? 0, need: 0, lines: [] };
    g.need += info.qty;
    g.lines.push(line);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.have < g.need) for (const l of g.lines) offenders.push({ itemCode: l.itemCode, soItemId: l.soItemId ?? null });
  }
  return offenders;
}

/** Return the subset of (itemCode, soItemId) rows that are SOFA lines (category
 *  SOFA or item_group contains SOFA). Used by the drop-ship cost paths to decide
 *  which lines should carry the expected batch — a STATE-INDEPENDENT detector
 *  (unlike findSofaLinesWithoutCompleteBatch, which also depends on whether a
 *  covering batch is currently on hand). */
export async function detectSofaSoItemIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  rows: Array<{ itemCode: string; itemGroup: string | null; soItemId: string | null }>,
  companyId?: number | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (rows.length === 0) return out;
  const codes = [...new Set(rows.map((r) => r.itemCode).filter(Boolean))];
  const sofaCodes = new Set<string>();
  if (codes.length > 0) {
    let catQ = sb.from('mfg_products').select('code, category').in('code', codes);
    if (companyId != null) catQ = catQ.eq('company_id', companyId);
    const { data: cats } = await catQ;
    for (const p of (cats ?? []) as Array<{ code: string; category: string | null }>) {
      if ((p.category ?? '').toUpperCase() === 'SOFA') sofaCodes.add(p.code);
    }
  }
  for (const r of rows) {
    if (!r.soItemId) continue;
    if (sofaCodes.has(r.itemCode) || (r.itemGroup ?? '').toUpperCase().includes('SOFA')) out.add(r.soItemId);
  }
  return out;
}

/** Identify sofa lines (category SOFA or item_group contains SOFA) among rows,
 *  using a product-category lookup over the rows' codes plus the item_group text. */
async function detectSofa(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  rows: Array<{ item_code: string; item_group: string | null }>,
  companyId?: number | null,
): Promise<(r: { item_code: string; item_group: string | null }) => boolean> {
  const codes = [...new Set(rows.map((r) => r.item_code).filter(Boolean))];
  const sofaCodes = new Set<string>();
  if (codes.length > 0) {
    let catQ = sb.from('mfg_products').select('code, category').in('code', codes);
    if (companyId != null) catQ = catQ.eq('company_id', companyId);
    const { data: cats } = await catQ;
    for (const p of (cats ?? []) as Array<{ code: string; category: string | null }>) {
      if ((p.category ?? '').toUpperCase() === 'SOFA') sofaCodes.add(p.code);
    }
  }
  return (r) => sofaCodes.has(r.item_code) || (r.item_group ?? '').toUpperCase().includes('SOFA');
}

export type IncompleteSofaSet = { docNo: string; missingItemCodes: string[] };

/** Type B — a sofa SET must ship WHOLE from one batch. Given the SO-line ids that
 *  a DO will ship, return any SO whose sofa set is only PARTIALLY included (some
 *  module lines in the DO, others left behind). Shipping a partial set would
 *  strand the rest of the dye lot as an orphan, so it must be blocked. The
 *  "complete set" for an SO = all its READY sofa lines (allocation binds an SO's
 *  whole set to one batch all-or-nothing, so a ready set's lines are all READY). */
export async function findIncompleteSofaSets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soItemIds: Array<string | null | undefined>,
  companyId?: number | null,
): Promise<IncompleteSofaSet[]> {
  const ids = [...new Set(soItemIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return [];

  // 1. The sofa lines actually being shipped, and which SOs they belong to.
  const { data: provRows } = await sb
    .from('mfg_sales_order_items')
    .select('id, doc_no, item_code, item_group')
    .in('id', ids);
  const provided = (provRows ?? []) as Array<{ id: string; doc_no: string; item_code: string; item_group: string | null }>;
  if (provided.length === 0) return [];
  const isSofaProv = await detectSofa(sb, provided, companyId);
  const providedSofa = provided.filter(isSofaProv);
  if (providedSofa.length === 0) return [];
  const docs = [...new Set(providedSofa.map((r) => r.doc_no))];
  const providedByDoc = new Map<string, Set<string>>();
  for (const r of providedSofa) {
    const s = providedByDoc.get(r.doc_no) ?? new Set<string>();
    s.add(r.id); providedByDoc.set(r.doc_no, s);
  }

  // 2. Every READY sofa line of those SOs = the complete set that must ship together.
  const { data: setRows } = await sb
    .from('mfg_sales_order_items')
    .select('id, doc_no, item_code, item_group, stock_status')
    .in('doc_no', docs)
    .eq('stock_status', 'READY');
  const setLines = (setRows ?? []) as Array<{ id: string; doc_no: string; item_code: string; item_group: string | null }>;
  const isSofaSet = await detectSofa(sb, setLines, companyId);
  const fullByDoc = new Map<string, Array<{ id: string; item_code: string }>>();
  for (const r of setLines) {
    if (!isSofaSet(r)) continue;
    const arr = fullByDoc.get(r.doc_no) ?? [];
    arr.push({ id: r.id, item_code: r.item_code }); fullByDoc.set(r.doc_no, arr);
  }

  // 3. Any READY sofa line of an involved SO that the DO does NOT include = partial set.
  const out: IncompleteSofaSet[] = [];
  for (const doc of docs) {
    const full = fullByDoc.get(doc) ?? [];
    const inDo = providedByDoc.get(doc) ?? new Set<string>();
    const missing = full.filter((l) => !inDo.has(l.id));
    if (missing.length > 0) out.push({ docNo: doc, missingItemCodes: [...new Set(missing.map((m) => m.item_code))] });
  }
  return out;
}

/** Standard 409 body for a blocked partial-set sofa ship. English-only. */
export function sofaIncompleteSetResponse(sets: IncompleteSofaSet[]) {
  const detail = sets.map((s) => `${s.docNo} (missing ${s.missingItemCodes.join(', ')})`).join('; ');
  return {
    error: 'sofa_partial_set',
    message:
      `A sofa set must ship whole from one batch — this delivery leaves part of the set behind: ${detail}. ` +
      `Include the rest of the set, or ship none of it.`,
    sets,
  };
}

/** Per-offender drop-ship eligibility — the bound PO (= the incoming dye-lot
 *  batch) and its ETA. `poNumber` null = NO bound PO, so this line CANNOT
 *  drop-ship (the incoming batch is unknown). The frontend renders this in the
 *  "Ship as drop-ship?" confirm dialog. */
export type SofaDropshipOffender = {
  itemCode: string;
  soItemId: string | null;
  /** = the bound PO's number (= batch_no the GRN will stamp). null = no LIVE
   *  PO, or the batch is ambiguous (see multiPo). */
  poNumber: string | null;
  /** Effective ETA of the bound PO, or null. */
  eta: string | null;
  /** Audit H3 — the line is bound to MORE THAN ONE live PO, so the expected
   *  batch is ambiguous and drop-ship is blocked (the GRN could arrive under
   *  the other PO and strand the drop-ship COGS at 0). */
  multiPo?: boolean;
};

/** Standard 409 body for a blocked sofa ship. English-only (operator UI). Keeps
 *  error code `sofa_no_batch` stable so the frontend chokepoint keeps matching.
 *
 *  `dropship` (optional) enriches each offender with its bound PO + ETA so the
 *  frontend can offer the "Ship as drop-ship?" confirm dialog. `canDropship` is
 *  true only when EVERY affected sofa line has a bound PO (so the incoming
 *  batch is known for each) — if any line has no PO, drop-ship is not offered
 *  (the guardrail can't resolve an expected batch for it). */
export function sofaNoCompleteBatchResponse(
  offenders: SofaGuardOffender[],
  dropship?: SofaDropshipOffender[],
) {
  const codes = [...new Set(offenders.map((o) => o.itemCode))].join(', ');
  const canDropship = Array.isArray(dropship)
    && dropship.length > 0
    && dropship.every((o) => !!o.poNumber);
  /* Audit H3 — call out ambiguous lines separately: they DO have supplier POs,
     but more than one live one, so the expected batch is non-deterministic and
     drop-ship stays blocked until exactly one PO remains. */
  const multiPoCodes = [...new Set((dropship ?? []).filter((o) => o.multiPo).map((o) => o.itemCode))];
  const multiPoNote = multiPoCodes.length > 0
    ? ` Note: ${multiPoCodes.join(', ')} ${multiPoCodes.length === 1 ? 'is' : 'are'} bound to more than one open supplier PO, ` +
      `so drop-ship cannot pick the incoming batch — cancel the extra PO first (drop-ship needs exactly one).`
    : '';
  /* Owner 2026-07-31: when drop-ship is not offered the operator was told only
     to "wait until one complete batch is received", which is a dead end if the
     goods ARE on order and simply not linked. Since PR #1434 a PO line can be
     pointed at its Sales Order line from the PO screen, so name the lines that
     have no live PO and say what to do about it. */
  const noPoCodes = [...new Set(
    (dropship ?? []).filter((o) => !o.poNumber && !o.multiPo).map((o) => o.itemCode),
  )];
  const noPoNote = noPoCodes.length > 0
    ? ` ${noPoCodes.join(', ')} ${noPoCodes.length === 1 ? 'has' : 'have'} no live supplier PO linked, so there is no incoming ` +
      `batch to ship against. Link the purchase order line to its Sales Order line (Purchase Order -> the line -> Source Sales Order line), ` +
      `or raise the PO first.`
    : '';
  return {
    error: 'sofa_no_batch',
    message:
      `No single production batch on hand can fulfil this whole sofa set, ` +
      `so it can't ship without splitting a dye lot or leaving an orphan. ` +
      `Wait until one complete batch is received. Affected: ${codes}.` + multiPoNote + noPoNote,
    offenders,
    ...(dropship ? { dropship, canDropship } : {}),
  };
}
