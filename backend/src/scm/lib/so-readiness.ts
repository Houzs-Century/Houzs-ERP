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
// Remark output — states WHAT IS STILL MISSING (owner, 2026-08-16). It used to
// state what was READY, and that phrasing let the label contradict the ship gate
// computed three lines above it:
//
//   · An accessory-only SO with one short accessory line has mainCount === 0, so
//     isMainReady was VACUOUSLY true, so the remark read "READY (PARTIAL)" while
//     isShipReady was false. The owner hit this on a real order and called it
//     骗人 — a lie. 「只有配件,有一行没齐 → READY (PARTIAL) ← 骗人 / 明说还缺什么」
//   · A service-only SO had every line `continue`d, so it looked identical to an
//     SO with no lines at all and could never be ready. The owner's ruling:
//     「如果那张单只有 accessories 的话，accessories ready 应该直接呈现 ready。
//       如果它是 service 的单，也应该直接 ready」
//
// So the vocabulary is now:
//   ""                            — the SO has NO live lines at all. Nothing to
//                                   say, and (see isShipReady) nothing to ship.
//   "READY"                       — everything that must be allocated IS. Covers
//                                   an accessory-only SO with all accessories in,
//                                   and a service-only SO (services carry no
//                                   inventory, so there is nothing to wait for).
//   "SHORT: ACCESSORY"            — the named categories are NOT all allocated.
//   "SHORT: BEDFRAME, ACCESSORY"    Main cats first (sorted), ACCESSORY last.
//
// The string NEVER contains the substring "READY" while anything is short — that
// is the whole point of the rewrite, and soReadinessRemark.test.ts pins it.
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
  /** mfg_products.category, when the caller already has the catalog joined.
   *  isServiceLine calls this the STRONGEST service signal — but until
   *  2026-08-16 this type had no field for it, so no caller could ever pass it
   *  and the "strongest signal" was dead code from here. Optional: callers that
   *  have not resolved the catalog omit it and fall back to item_group /
   *  the SVC- code prefix. */
  category?: string | null;
  stock_status: 'PENDING' | 'READY' | string;
  cancelled?: boolean | null;
};

export type ReadinessSummary = {
  mainCount:    number;
  mainReady:    number;
  accCount:     number;
  accReady:     number;
  /** Live SERVICE lines. COUNTED, not dropped: a service-only SO ("had lines,
   *  every one of them a service") must be distinguishable from an SO with no
   *  lines at all, because the first is ready and the second is never ship-able.
   *  Services carry no inventory, so they have no ready/short tally. */
  svcCount:     number;
  /** True when every MAIN line is READY (regardless of accessories).
   *  VACUOUSLY TRUE when there is no MAIN line — that is the right reading for
   *  an accessory-only order and a trap everywhere else. Never label off this
   *  flag (that is exactly the bug fixed on 2026-08-16); the ship gate is
   *  isShipReady and the label is stockRemark. */
  isMainReady:  boolean;
  /** True when the SO has at least one live line and every stock-bearing one —
   *  MAIN and accessory — is READY. Service-only SOs qualify: they have a live
   *  line and nothing to allocate. A line-less SO never does. */
  isFullyReady: boolean;
  /** THE ship gate — use this, never bare isMainReady (see below). False for a
   *  line-less SO. */
  isShipReady:  boolean;
  /** UI label per the contract above (empty string when SO has no lines). */
  stockRemark:  string;
  /** Category labels still short of READY, dedup'd, MAIN cats sorted with the
   *  single collapsed "ACCESSORY" entry last. This IS what stockRemark names. */
  pendingCategories: string[];
};

/**
 * Roll up per-line stock_status into the SO-header readiness story.
 * Cancelled lines are filtered. Empty input → no-flag default.
 */
export function summariseReadiness(lines: ReadinessLine[]): ReadinessSummary {
  const live = lines.filter((l) => !l.cancelled);
  let mainCount = 0, mainReady = 0, accCount = 0, accReady = 0, svcCount = 0;
  /* MAIN categories carrying at least one unallocated line — the remark names
     THESE. (The old per-category total/ready tally that fed the "what IS ready"
     string is gone with that string.) */
  const pendingMainCats = new Set<string>();
  let anyAccPending = false;

  for (const l of live) {
    /* SERVICE lines (delivery fee / dispose / lift) have NO inventory — they
       must never gate stock readiness nor show in the Stock Status pill.
       Previously SERVICE fell into the accessory (`else`) bucket and a delivery
       fee kept the SO showing "ACC".
       They are still excluded from every ready/short tally, but they are now
       COUNTED: `continue` alone made a service-only SO byte-identical to an SO
       with zero lines, which is why such an SO could never become ready.
       `category` is passed when the caller has the catalog joined — it is the
       strongest of the three signals. */
    if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code, category: l.category })) {
      svcCount += 1;
      continue;
    }
    const cat = normCategory(l.item_group);
    const isMain = MAIN_CATEGORIES.has(cat);
    /* stock_status 'READY' = fully allocated. 'PARTIAL' (Commander 2026-05-30
       #4) = some but not all of the line's qty allocated → counts as NOT
       ready for the category-level "all ready" gate. 'PENDING' = nothing. */
    const isReady = l.stock_status === 'READY';
    if (isMain) {
      mainCount += 1;
      if (isReady) mainReady += 1;
      else pendingMainCats.add(cat);
    } else {
      accCount += 1;
      if (isReady) accReady += 1;
      else anyAccPending = true;
    }
  }

  /* Every live line, service included — the ONLY thing that separates "this SO
     has nothing left to wait for" from "this SO has nothing on it". */
  const liveCount = mainCount + accCount + svcCount;

  const isMainReady  = mainCount > 0 ? mainReady === mainCount : true;  // no-main SO = main-ready by convention
  /* >= 1 live line AND every stock-bearing line allocated. Service lines make
     liveCount non-zero without adding anything to allocate, which is precisely
     the owner's ruling that a service-only SO is ready on sight. The empty SO
     still fails here, so PR #2186's husk gate is untouched. */
  const isFullyReady = liveCount > 0 && mainReady === mainCount && accReady === accCount;
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
     one live line AND all of them READY — so a line-less SO is never ship-able.

     UNCHANGED for any SO carrying a main line. The only behaviour that moved on
     2026-08-16 is that a service-only SO now satisfies isFullyReady and so may
     ship, per the owner's ruling. */
  const isShipReady  = mainCount > 0 ? isMainReady : isFullyReady;

  /* What is SHORT — MAIN cats with any unallocated line (sorted), then the one
     collapsed ACCESSORY entry. Services never appear: they have no stock. */
  const pc = [...pendingMainCats].sort();
  if (anyAccPending) pc.push('ACCESSORY');

  /* Stock remark — names WHAT IS MISSING. Deliberately NOT branched on
     isMainReady: that flag is vacuously true for an SO with no main line, which
     is how an accessory-only SO with a short line came to be labelled
     "READY (PARTIAL)" while its own ship gate said false. */
  let stockRemark: string;
  if (liveCount === 0) {
    stockRemark = '';                       // no lines — say nothing, ship nothing
  } else if (isFullyReady) {
    stockRemark = 'READY';                  // incl. service-only and acc-only-all-in
  } else {
    /* pc is non-empty here by construction: liveCount > 0 and !isFullyReady can
       only mean a main or an accessory line is short. The fallback exists so a
       future bucket added above can never emit a bare "SHORT: ". */
    stockRemark = pc.length > 0 ? `SHORT: ${pc.join(', ')}` : '';
  }

  return { mainCount, mainReady, accCount, accReady, svcCount, isMainReady, isFullyReady, isShipReady, stockRemark, pendingCategories: pc };
}
