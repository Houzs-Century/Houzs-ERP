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
// Remark output — names WHAT IS READY. It is the warehouse's "Remark 2"
// vocabulary, reproduced from AutoCount (docs/stock-reconciliation.md §2), and
// staff scan the column to know what they can PULL now without asking the
// salesperson. Confirmed by the owner on 2026-08-16 against real orders.
//
//   ""              — nothing is ready yet, or the SO has no live lines at all.
//   "READY"         — every live line is in: MAIN + accessories + service.
//   "PARTIAL"       — every MAIN line is in, an accessory is still pending. The
//                     order can still ship; accessories never block delivery.
//   "BEDFRAME"      — that category is fully in, another MAIN category is not.
//   "MATTRESS/ACC"  — "/"-joined list of the groups that ARE in. Fixed order:
//                     BEDFRAME, SOFA, MATTRESS, then ACC (§2.4 — AutoCount's
//                     hand-typed Remark2 is order-insensitive, the ERP is the
//                     canonical side).
//
// TWO RULES THIS VOCABULARY MUST KEEP, both bought on 2026-08-16.
//
//  1. "PARTIAL" REQUIRES A MAIN LINE. It means "the main products are ready" —
//     an SO with no main line has none, so nothing is ready and the cell says
//     NOTHING. Never branch the label on bare isMainReady: that flag is
//     VACUOUSLY TRUE at mainCount === 0, which is how an accessory-only SO with
//     one short accessory came to read "READY (PARTIAL)" three lines above an
//     isShipReady of false. The owner called it 骗人 — a lie.
//     「只有配件,有一行没齐 → READY (PARTIAL) ← 骗人 / 明说还缺什么」
//  2. A SERVICE-ONLY SO IS READY ON SIGHT. Service lines are COUNTED, never
//     dropped: `continue` alone made such an SO byte-identical to one with no
//     lines, so it could never be ready. Owner: 「如果那张单只有 accessories
//     的话，accessories ready 应该直接呈现 ready。如果它是 service 的单，也应该
//     直接 ready」
//
// The string never contains the substring "READY" while anything is short —
// "PARTIAL" is the label, NOT "READY (PARTIAL)" (owner, 2026-08-16). That
// invariant survives the ready-side vocabulary and soReadinessRemark.test.ts
// pins it over every shape.
//
// HISTORY. Between 2026-08-16 morning (PR #2295) and this change the remark
// named what was MISSING — "SHORT: BEDFRAME, ACCESSORY". That half was a
// correct fix to a real lie applied to the wrong half of the function: the bug
// was branching on isMainReady, not the direction of the vocabulary. Rule 1
// above is that fix, kept. A stored remark or an AutoCount export from that
// window can still read "SHORT: ...".
// ----------------------------------------------------------------------------

import { isServiceLine } from '../shared';

export const MAIN_CATEGORY_ORDER = ['BEDFRAME', 'SOFA', 'MATTRESS'] as const;

export const MAIN_CATEGORIES = new Set<string>(MAIN_CATEGORY_ORDER);

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
  item_code?: string | null;
  category?: string | null;
  stock_status: 'PENDING' | 'READY' | string;
  cancelled?: boolean | null;
  fulfilled?: boolean | null;
};

export type ReadinessSummary = {
  mainCount:    number;
  mainReady:    number;
  accCount:     number;
  accReady:     number;
  svcCount:     number;
  isMainReady:  boolean;
  isFullyReady: boolean;
  isShipReady:  boolean;
  stockRemark:  string;
  readyCategories: string[];
  pendingCategories: string[];
};

/**
 * Roll up per-line stock_status into the SO-header readiness story.
 * Cancelled lines are filtered. Empty input → no-flag default.
 */
export function summariseReadiness(lines: ReadinessLine[]): ReadinessSummary {
  const live = lines.filter((l) => !l.cancelled);
  let mainCount = 0, mainReady = 0, accCount = 0, accReady = 0, svcCount = 0, fulCount = 0;
  const mainByCat = new Map<string, { total: number; ready: number }>();
  const pendingMainCats = new Set<string>();
  let anyAccPending = false;

  for (const l of live) {
    if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code, category: l.category })) {
      svcCount += 1;
      continue;
    }
    if (l.fulfilled === true) {
      fulCount += 1;
      continue;
    }
    const cat = normCategory(l.item_group);
    const isMain = MAIN_CATEGORIES.has(cat);
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

  const liveCount = mainCount + accCount + svcCount + fulCount;

  const isMainReady  = mainCount > 0 ? mainReady === mainCount : true;
  /* >= 1 live line AND every stock-bearing line allocated. Service lines make
     liveCount non-zero without adding anything to allocate, which is precisely
     the owner's ruling that a service-only SO is ready on sight. The empty SO
     still fails here, so PR #2186's husk gate is untouched. */
  const isFullyReady = liveCount > 0 && mainReady === mainCount && accReady === accCount;
  const isShipReady  = mainCount > 0 ? isMainReady : isFullyReady;

  const readyCats: string[] = [];
  for (const cat of MAIN_CATEGORY_ORDER) {
    const cell = mainByCat.get(cat);
    if (cell && cell.total > 0 && cell.ready === cell.total) readyCats.push(cat);
  }
  if (accCount > 0 && accReady === accCount) readyCats.push('ACC');

  const pc = [...pendingMainCats].sort();
  if (anyAccPending) pc.push('ACC');

  let stockRemark: string;
  if (liveCount === 0) {
    stockRemark = '';
  } else if (isFullyReady) {
    stockRemark = 'READY';
  } else if (mainCount > 0 && isMainReady) {
    stockRemark = 'PARTIAL';
  } else {
    stockRemark = readyCats.join('/');
  }

  return { mainCount, mainReady, accCount, accReady, svcCount, isMainReady, isFullyReady, isShipReady, stockRemark, readyCategories: readyCats, pendingCategories: pc };
}
