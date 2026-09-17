// MRP model pipeline — the funnel + grouping that turns a /mrp response into the
// grouped ModelGroup rows the page renders. Extracted from Mrp.tsx (2026-09-16)
// so the SCREEN and the EXPORT run the ONE implementation: the workbook export
// builds every category sheet by calling `computeTabModels` with the same
// filters the page passes, so "看到怎么样的 就出来怎么样的" holds by construction
// rather than by two copies of the funnel kept in step by hand.

import type { MrpSku, MrpLine, MrpResponse, SofaSet } from '../../vendor/scm/lib/mrp-queries';
import { allocSourceOf } from '../../vendor/shared/mrp-alloc-source';
import { rowBelongsToView, type MrpView } from './mrp-views';
import { sofaAccessoryRowsPerSo } from './mrp-sofa-accessory';

export type ModelGroup = {
  /* Commander 2026-05-31 — a Model is now scoped to ONE warehouse. The same
     SKU in two warehouses is two groups (per-WH MRP, no cross-WH pooling). */
  groupKey: string;          // `${warehouseId ?? 'NOWH'}|${itemCode}` — identity
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  description: string | null;
  category: string | null;
  variants: MrpSku[];
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  /* NO `suppliers` HERE, DELIBERATELY. All three groupers built this field the
     same way — from whichever child happened to be first — and a Model or a
     Sales Order does not have suppliers: each VARIANT does, and on the Sofa tab
     each variant is a different module SKU with its own bindings. Supplier lives
     on MrpSku and is read there (LineSupplierCell, SofaSoTable, OrderLines). */
};

export const WH_NONE = 'NOWH';
export const skuGroupKey = (s: MrpSku) => `${s.warehouseId ?? WH_NONE}|${s.itemCode}`;
export const rowKey = (s: MrpSku) => `${s.warehouseId ?? WH_NONE}|${s.itemCode}${s.variantKey}`;

export function groupByModel(skus: MrpSku[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const s of skus) {
    const gk = skuGroupKey(s);
    let g = map.get(gk);
    if (!g) {
      g = {
        groupKey: gk,
        warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
        itemCode: s.itemCode, description: s.description, category: s.category,
        variants: [], qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
      };
      map.set(gk, g);
    }
    g.variants.push(s);
    g.qtyNeeded += s.qtyNeeded;
    g.stock += s.stock;
    g.poOutstanding += s.poOutstanding;
    g.shortage += s.shortage;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.variants.sort((a, b) => (a.variantLabel ?? '') < (b.variantLabel ?? '') ? -1 : 1);
  }
  // Shortage models float to the top (the orange ones to act on), then by
  // warehouse, then by code — so each warehouse's rows cluster together.
  groups.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const wa = a.warehouseCode ?? a.warehouseName ?? '';
    const wb = b.warehouseCode ?? b.warehouseName ?? '';
    if (wa !== wb) return wa < wb ? -1 : 1;
    return a.itemCode < b.itemCode ? -1 : 1;
  });
  return groups;
}

/* Adapter (F5, Wei Siang 2026-06-15) — fold sofa SETS into PER-SO module SKUs so
   the Sofa tab groups by SO (groupBySo below): one parent row per SO, its sofa
   modules as the variant sub-rows. NOT pooled across SOs (each module SKU belongs
   to one SO), and the variantKey is prefixed with the SO doc no so the render's
   per-variant expand key (rowKey) stays unique across SO rows. Ordering is
   unchanged — selection + Proceed PO still key off each line's soItemId. */
export function sofaSetsToSkus(sets: SofaSet[]): MrpSku[] {
  const map = new Map<string, MrpSku>();
  for (const s of sets) {
    const realVariant = s.variantLabel ?? s.colour ?? '';
    // One row per (warehouse, SO, module, variant).
    const key = `${s.warehouseId ?? WH_NONE}|${s.soDocNo}|${s.itemCode}|${realVariant}`;
    let sku = map.get(key);
    if (!sku) {
      const main = s.suppliers.find((x) => x.isMain) ?? null;
      sku = {
        warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
        itemCode: s.itemCode,
        // soDocNo-prefixed so the same module+variant in two SOs gets distinct
        // rowKeys; the visible label shows the module (+ its fabric/colour).
        variantKey: `${s.soDocNo}::${realVariant}`,
        variantLabel: realVariant ? `${s.itemCode} · ${realVariant}` : s.itemCode,
        description: s.description, category: 'SOFA',
        qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
        mainSupplierCode: main?.code ?? null, mainSupplierName: main?.name ?? null,
        suppliers: s.suppliers, lines: [],
      };
      map.set(key, sku);
    }
    sku.qtyNeeded += s.qty;
    sku.poOutstanding += s.orderedQty;
    sku.shortage += s.shortageQty;
    sku.lines.push({
      soItemId: s.soItemId, soDocNo: s.soDocNo,
      // Carry the SO line's canonical stored sequence so groupBySo can order
      // an SO's module rows LHF → NA → RHF (same order as the SO PDF/detail).
      lineNo: s.lineNo, createdAt: s.createdAt,
      debtorName: s.debtorName,
      customerState: s.customerState,
      soDate: s.soDate, deliveryDate: s.deliveryDate, processingDate: s.processingDate,
      orderByDate: s.orderByDate, qty: s.qty,
      /* THE SHARED RULE, not a second copy of it — allocSourceOf is the one
         three-way source function (stock | po | shortage), mirrored byte-for-byte
         with the backend. */
      source: allocSourceOf(s.shortageQty, s.poNumber), poNumber: s.poNumber, poEta: s.poEta,
      shortageQty: s.shortageQty,
      poSupplierId: s.poSupplierId, poSupplierName: s.poSupplierName,
    });
  }
  return [...map.values()];
}

/* "BOOQIT-1B(LHF)", "BOOQIT-CNR" → "BOOQIT: 1B(LHF) + CNR" when every module
   shares one base model; otherwise the full codes joined. */
function sofaComposition(codes: string[]): string {
  const parts = codes.map((c) => {
    const i = c.indexOf('-');
    return i > 0 ? { base: c.slice(0, i), mod: c.slice(i + 1) } : { base: '', mod: c };
  });
  const bases = new Set(parts.map((p) => p.base).filter(Boolean));
  if (bases.size === 1) return `${[...bases][0]}: ${parts.map((p) => p.mod).join(' + ')}`;
  return codes.join(' + ');
}

/* Canonical stored-sequence comparator for two SO lines (migration 0165): order
   by line_no (NULLS LAST), then created_at, then leave equal. Mirrors the
   backend read order `(line_no NULLS LAST, created_at)` that the SO detail + SO
   PDF derive their LHF → NA → RHF order from, so the Sofa tab matches them. */
const soLineSeqCmp = (a: MrpLine | undefined, b: MrpLine | undefined): number => {
  const an = a?.lineNo, bn = b?.lineNo;
  const aHas = typeof an === 'number', bHas = typeof bn === 'number';
  if (aHas && bHas && an !== bn) return an! - bn!;
  if (aHas !== bHas) return aHas ? -1 : 1;          // numbered lines first (NULLS LAST)
  const ac = a?.createdAt ?? '', bc = b?.createdAt ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return 0;
};

/* F5 — group the per-SO sofa module SKUs into ONE parent row per SO (the SO doc
   no is the "serial"); the modules become the variant sub-rows. Mirrors
   groupByModel's totals + shortage-first sort. */
export function groupBySo(skus: MrpSku[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const s of skus) {
    const soDocNo = s.lines[0]?.soDocNo ?? '—';
    const gk = `${s.warehouseId ?? WH_NONE}|${soDocNo}`;
    let g = map.get(gk);
    if (!g) {
      g = {
        groupKey: gk,
        warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
        itemCode: soDocNo, description: null, category: 'SOFA',
        variants: [], qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
      };
      map.set(gk, g);
    }
    g.variants.push(s);
    g.qtyNeeded += s.qtyNeeded;
    g.stock += s.stock;
    g.poOutstanding += s.poOutstanding;
    g.shortage += s.shortage;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    /* Order each SO's module rows by the CANONICAL stored sequence (line_no,
       migration 0165) so they read LHF → NA → RHF exactly as the SO detail +
       SO PDF do — NOT an alphabetical item_code sort. */
    g.variants.sort((a, b) => soLineSeqCmp(a.lines[0], b.lines[0]) || (a.itemCode < b.itemCode ? -1 : a.itemCode > b.itemCode ? 1 : 0));
    // Composition only — no customer name on the parent row (Wei Siang
    // 2026-06-16); the customer still shows in the expanded child order lines.
    g.description = sofaComposition(g.variants.map((v) => v.itemCode));
  }
  groups.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const wa = a.warehouseCode ?? a.warehouseName ?? '';
    const wb = b.warehouseCode ?? b.warehouseName ?? '';
    if (wa !== wb) return wa < wb ? -1 : 1;
    return a.itemCode < b.itemCode ? -1 : 1;
  });
  return groups;
}

/* BF-FLAT (Commander 2026-06-16) — bedframe is flattened like the Sofa tab:
   each colour VARIANT becomes its own top row (its Description 2 read straight
   at L1), and expanding jumps straight to the SO orders. */
export function groupByVariant(skus: MrpSku[]): ModelGroup[] {
  const groups: ModelGroup[] = skus.map((s) => ({
    groupKey: rowKey(s),               // warehouse|itemCode|variantKey — unique per variant
    warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
    itemCode: s.itemCode, description: s.description, category: s.category,
    variants: [s],                     // single → ModelDrilldown jumps straight to orders
    qtyNeeded: s.qtyNeeded, stock: s.stock, poOutstanding: s.poOutstanding, shortage: s.shortage,
  }));
  // Same ordering as the other groupers: shortage (orange) first, then warehouse,
  // then code, then the variant label so a model's colours cluster together.
  groups.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const wa = a.warehouseCode ?? a.warehouseName ?? '';
    const wb = b.warehouseCode ?? b.warehouseName ?? '';
    if (wa !== wb) return wa < wb ? -1 : 1;
    if (a.itemCode !== b.itemCode) return a.itemCode < b.itemCode ? -1 : 1;
    return (a.variants[0]!.variantLabel ?? '') < (b.variants[0]!.variantLabel ?? '') ? -1 : 1;
  });
  return groups;
}

/* One sofa-cover rider: an ACCESSORY shortage line on a sofa SO, carried with
   its owning SKU so it can be shown under the sofa's modules. */
export type AccessoryRider = { sku: MrpSku; line: MrpLine };
export type AccessoryBySoDoc = Map<string, AccessoryRider[]>;

/* The date-window filter the page's From–To control applies. `dateBasis`
   chooses which of the SO line's four dates the window tests. */
export type DateBasis = 'delivery' | 'orderBy' | 'processing' | 'soDate';
export type MrpFilters = {
  dateFrom: string;
  dateTo: string;
  dateBasis: DateBasis;
  onlyShort: boolean;
  search: string;
};

export const lineDateOf = (l: MrpLine, dateBasis: DateBasis): string | null =>
  dateBasis === 'processing' ? l.processingDate
  : dateBasis === 'soDate' ? l.soDate
  : dateBasis === 'orderBy' ? l.orderByDate
  : l.deliveryDate;

/** The EARLIEST of a Model row's SO-line dates on the chosen basis. A Model can
 *  span several SO lines (a pooled item serves more than one order); the leading
 *  date is the edge the plan sorts by and the one the From–To window tests a row
 *  against, so it is the date to surface at the group level. `null` when no line
 *  carries that date (renders "—"). Display-only — the allocation never reads it. */
export const groupEarliestDate = (g: ModelGroup, dateBasis: DateBasis): string | null => {
  let earliest: string | null = null;
  for (const v of g.variants) {
    for (const l of v.lines) {
      const d = lineDateOf(l, dateBasis);
      if (d && (earliest === null || d < earliest)) earliest = d;
    }
  }
  return earliest;
};

/** Is this SO line inside the active From–To window? A window with no bounds
 *  passes everything; a line with no date on the chosen basis is excluded. */
export const lineInWindow = (l: MrpLine, filters: MrpFilters): boolean => {
  const d = lineDateOf(l, filters.dateBasis);
  if (!d) return false;
  const x = d.slice(0, 10);
  if (filters.dateFrom && x < filters.dateFrom) return false;
  if (filters.dateTo && x > filters.dateTo) return false;
  return true;
};

/**
 * The one funnel + grouping the MRP page renders and the workbook export writes.
 *
 * Given a /mrp response for THIS tab (fetched with the tab's own `?category=`, so
 * its allocation is the tab's — never post-filtered from the full plan) and the
 * page's live filters, produce the grouped rows exactly as the screen shows them:
 *   tab category funnel → date window → grouper (SO / variant / model) →
 *   only-shortages → search.
 * `accessoryBySoDoc` carries the sofa-cover riders that ride under each sofa SO.
 */
export function computeTabModels(
  data: MrpResponse | undefined,
  view: MrpView,
  filters: MrpFilters,
): {
  viewSkus: MrpSku[];
  models: ModelGroup[];
  displayModels: ModelGroup[];
  accessoryBySoDoc: AccessoryBySoDoc;
  forceOpen: boolean;
} {
  const isSofa = view.value === 'sofa';
  const tabSkus = isSofa
    ? [...sofaSetsToSkus(data?.sofaSets ?? []), ...sofaAccessoryRowsPerSo(data?.skus ?? [])]
    : (data?.skus ?? []).filter((s) => rowBelongsToView(view, s.category));

  const hasWindow = Boolean(filters.dateFrom || filters.dateTo);
  const viewSkus: MrpSku[] = tabSkus
    .map((s) => {
      if (!hasWindow) return s;
      const lines = s.lines.filter((l) => lineInWindow(l, filters));
      const qtyNeeded = lines.reduce((a, l) => a + l.qty, 0);
      const shortage = lines.reduce((a, l) => a + (l.source === 'shortage' ? l.shortageQty : 0), 0);
      return { ...s, lines, qtyNeeded, shortage };
    })
    .filter((s) => !hasWindow || s.lines.length > 0);

  const models = isSofa
    ? groupBySo(viewSkus)
    : view.value === 'bedframe'
      ? groupByVariant(viewSkus)
      : groupByModel(viewSkus);

  // Sofa-cover riders — the sofa order's ACCESSORY shortage lines, keyed by SO
  // doc no (= groupBySo's itemCode). Only shortage (orderable) lines, honouring
  // the active date window — exactly the set gatherSofa orders.
  const sofaDocsInView = isSofa
    ? new Set(viewSkus.flatMap((s) => s.lines.map((l) => l.soDocNo)))
    : null;
  const accessoryBySoDoc: AccessoryBySoDoc = new Map();
  if (isSofa && sofaDocsInView) {
    for (const s of data?.skus ?? []) {
      if ((s.category ?? '').toUpperCase() !== 'ACCESSORY') continue;
      for (const l of s.lines) {
        if (l.source !== 'shortage' || l.shortageQty <= 0 || !l.soItemId) continue;
        if (!sofaDocsInView.has(l.soDocNo)) continue;
        if (hasWindow && !lineInWindow(l, filters)) continue;
        const arr = accessoryBySoDoc.get(l.soDocNo) ?? [];
        arr.push({ sku: s, line: l });
        accessoryBySoDoc.set(l.soDocNo, arr);
      }
    }
  }

  // Only-shortages focus filter — affects which ROWS render.
  const shortModels = filters.onlyShort ? models.filter((m) => m.shortage > 0) : models;

  // Search — narrow the rows in view to a query over code, description, variant/
  // module label, and each SO line's doc no + customer; a sofa row also matches
  // its cover riders. Empty query = everything.
  const searchQ = filters.search.trim().toLowerCase();
  const matchModel = (g: ModelGroup): boolean => {
    if (!searchQ) return true;
    const hay: string[] = [g.itemCode, g.description ?? ''];
    for (const v of g.variants) {
      hay.push(v.variantLabel ?? '', v.itemCode);
      for (const l of v.lines) hay.push(l.soDocNo, l.debtorName ?? '');
    }
    for (const { sku, line } of accessoryBySoDoc.get(g.itemCode) ?? []) {
      hay.push(sku.itemCode, sku.description ?? '', line.debtorName ?? '');
    }
    return hay.some((h) => h.toLowerCase().includes(searchQ));
  };
  const displayModels = searchQ ? shortModels.filter(matchModel) : shortModels;

  return { viewSkus, models, displayModels, accessoryBySoDoc, forceOpen: Boolean(searchQ) };
}
