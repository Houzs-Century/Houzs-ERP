// ----------------------------------------------------------------------------
// so-readiness — SO header status + "stock remark" derivation, Commander
// 2026-05-30. B2C semantics: an SO ships once every MAIN product (SOFA /
// BEDFRAME / MATTRESS) is in stock — accessories pending DO NOT block ship.
//
// Used by:
//   - recomputeSoStockAllocation (auto-advance / regress header on stock change)
//   - PATCH /:docNo/items/:itemId/stock-status (manual READY toggle)
//   - GET /mfg-sales-orders (list aggregate — emits stock_remark per row)
//
// Remark output — shows WHAT IS READY (the operator's existing "Remark 2"
// convention; the warehouse staff scan this column to know what they can
// pull NOW without asking the salesperson):
//   ""               — nothing ready / no items
//   "READY"          — every line (MAIN + ACC) is READY
//   "READY (PARTIAL)" — every MAIN line READY, some ACC line still PENDING
//                       (still ship-able — accessories don't block delivery)
//   "BEDFRAME"       — every BEDFRAME line READY, MAIN of other cats still
//                       pending (i.e. "bedframe ready, waiting on rest")
//   "MATTRESS/ACC"   — mattress READY + accessories READY, sofa/bedframe still
//                       pending → "/"-joined list of categories that ARE ready
// ----------------------------------------------------------------------------

import { isServiceLine } from '../shared';

export const MAIN_CATEGORIES = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);

/** Normalise a free-text item_group to one of the known buckets. */
export function normCategory(raw: string | null | undefined): string {
  const g = (raw ?? '').trim().toUpperCase();
  if (g.includes('BEDFRAME')) return 'BEDFRAME';
  if (g.includes('SOFA'))     return 'SOFA';
  if (g.includes('MATTRESS')) return 'MATTRESS';
  if (g.includes('ACCESSOR')) return 'ACCESSORY';
  if (g.includes('SERVICE'))  return 'SERVICE';
  return 'OTHERS';
}

export type ReadinessLine = {
  item_group: string | null;
  /** Used to detect SERVICE lines (SVC- code) when item_group is ambiguous. */
  item_code?: string | null;
  stock_status: 'PENDING' | 'READY' | string;
  cancelled?: boolean | null;
};

export type ReadinessSummary = {
  mainCount:    number;
  mainReady:    number;
  accCount:     number;
  accReady:     number;
  /** True when every MAIN line is READY (regardless of accessories). */
  isMainReady:  boolean;
  /** True when EVERY non-cancelled line — incl. accessories — is READY. */
  isFullyReady: boolean;
  /** THE ship gate — use this, never bare isMainReady (see below). False for a
   *  line-less SO. */
  isShipReady:  boolean;
  /** UI label per the contract above (empty string when SO has no lines). */
  stockRemark:  string;
  /** Category labels still PENDING, dedup'd + sorted. ACC collapses to one
   *  "ACC" entry to match operator-existing convention. */
  pendingCategories: string[];
};

/**
 * Roll up per-line stock_status into the SO-header readiness story.
 * Cancelled lines are filtered. Empty input → no-flag default.
 */
export function summariseReadiness(lines: ReadinessLine[]): ReadinessSummary {
  const live = lines.filter((l) => !l.cancelled);
  let mainCount = 0, mainReady = 0, accCount = 0, accReady = 0;
  /* Per-MAIN-category totals so the "what's ready" string can list cats that
     are fully READY (e.g. "BEDFRAME" when every bedframe line is READY but
     sofa/mattress lines on the same SO are still PENDING). */
  const mainByCat = new Map<string, { total: number; ready: number }>();
  const pendingMainCats = new Set<string>();
  let anyAccPending = false;

  for (const l of live) {
    /* SERVICE lines (delivery fee / dispose / lift) have NO inventory — they
       must never gate stock readiness nor show in the Stock Status pill.
       Previously SERVICE fell into the accessory (`else`) bucket and a delivery
       fee kept the SO showing "ACC". Skip them entirely. */
    if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code })) continue;
    const cat = normCategory(l.item_group);
    const isMain = MAIN_CATEGORIES.has(cat);
    /* stock_status 'READY' = fully allocated. 'PARTIAL' (Commander 2026-05-30
       #4) = some but not all of the line's qty allocated → counts as NOT
       ready for the category-level "all ready" gate. 'PENDING' = nothing. */
    const isReady = l.stock_status === 'READY';
    if (isMain) {
      mainCount += 1;
      const cell = mainByCat.get(cat) ?? { total: 0, ready: 0 };
      cell.total += 1;
      if (isReady) { mainReady += 1; cell.ready += 1; }
      else pendingMainCats.add(cat);
      mainByCat.set(cat, cell);
    } else {
      accCount += 1;
      if (isReady) accReady += 1;
      else anyAccPending = true;
    }
  }

  const isMainReady  = mainCount > 0 ? mainReady === mainCount : true;  // no-main SO = main-ready by convention
  const isFullyReady = (mainCount + accCount) > 0 && mainReady === mainCount && accReady === accCount;
  /* THE ship gate. isMainReady is VACUOUSLY true when mainCount === 0, which is
     the right convention for an accessory-only SO but a trap everywhere else:
     an SO with NO stock-bearing lines at all also reports main-ready, so any
     caller gating on bare isMainReady ships an empty document.

     That is not hypothetical. On 2026-08-13/14 the 2990 POS minted 16 test SOs;
     staff "undid" them by deleting every line, and the auto-allocation sweep
     then advanced all 16 empty husks to READY_TO_SHIP — "every main product
     line is READY" is trivially satisfied by zero lines. Delivery Planning had
     already worked around this locally; the gate now lives here so that every
     caller inherits it.

     Rule: when the SO HAS a main line, main-ready is enough (accessories don't
     block ship). Otherwise fall back to isFullyReady, which requires at least
     one live line AND all of them READY — so a line-less SO is never ship-able. */
  const isShipReady  = mainCount > 0 ? isMainReady : isFullyReady;

  /* Stock remark — shows WHAT IS READY (so warehouse staff know what they
     can pull NOW without asking the salesperson). */
  let stockRemark = '';
  if (mainCount + accCount === 0) {
    stockRemark = '';
  } else if (isFullyReady) {
    stockRemark = 'READY';
  } else if (isMainReady) {
    /* All MAIN done, only ACC still outstanding — operator can still ship. */
    stockRemark = 'READY (PARTIAL)';
  } else {
    /* Mix of ready / not-ready. List the cats that ARE fully ready — that's
       what tells warehouse what to pull. ACC bucket counts as "ready" only
       when every accessory line is READY. */
    const readyCats: string[] = [];
    for (const cat of ['BEDFRAME', 'SOFA', 'MATTRESS']) {
      const cell = mainByCat.get(cat);
      if (cell && cell.total > 0 && cell.ready === cell.total) readyCats.push(cat);
    }
    if (accCount > 0 && accReady === accCount) readyCats.push('ACC');
    stockRemark = readyCats.join('/');  // "" when nothing yet ready
  }

  /* pendingCategories stays = what's NOT ready (handy for internal callers
     even though the UI now shows the ready list). */
  const pc = [...pendingMainCats].sort();
  if (anyAccPending) pc.push('ACC');

  return { mainCount, mainReady, accCount, accReady, isMainReady, isFullyReady, isShipReady, stockRemark, pendingCategories: pc };
}
