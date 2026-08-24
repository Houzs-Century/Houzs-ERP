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

/* Emission order for the ready list, and the source of MAIN_CATEGORIES so the
   two cannot drift apart. docs/stock-reconciliation.md §2.4 records why the
   order is fixed here: AutoCount holds "BEDFRAME/ACC" 31 times and
   "ACC/BEDFRAME" twice for the same meaning, so the ERP is the canonical side
   and the parity checker compares order-insensitively. */
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
   *  an accessory-only order and a trap everywhere else. Never read it BARE:
   *  the ship gate is isShipReady, and the one place the label reads it
   *  ("PARTIAL") pairs it with `mainCount > 0` for exactly this reason. */
  isMainReady:  boolean;
  /** True when the SO has at least one live line and every stock-bearing one —
   *  MAIN and accessory — is READY. Service-only SOs qualify: they have a live
   *  line and nothing to allocate. A line-less SO never does. */
  isFullyReady: boolean;
  /** THE ship gate — use this, never bare isMainReady (see below). False for a
   *  line-less SO. */
  isShipReady:  boolean;
  /** UI label per the contract above (empty string when nothing is ready). */
  stockRemark:  string;
  /** Groups that ARE fully allocated, in emission order (MAIN_CATEGORY_ORDER,
   *  then the single collapsed "ACC" entry). This IS what stockRemark names,
   *  except in the two states that have their own word — "READY" and
   *  "PARTIAL". Empty when nothing is ready yet. */
  readyCategories: string[];
  /** Groups still short of READY — the complement, kept for internal callers
   *  that need to ask "what are we waiting on". MAIN cats sorted, the single
   *  collapsed "ACC" entry last. NOT what the label names. */
  pendingCategories: string[];
};

/**
 * Roll up per-line stock_status into the SO-header readiness story.
 * Cancelled lines are filtered. Empty input → no-flag default.
 */
export function summariseReadiness(lines: ReadinessLine[]): ReadinessSummary {
  const live = lines.filter((l) => !l.cancelled);
  let mainCount = 0, mainReady = 0, accCount = 0, accReady = 0, svcCount = 0;
  /* Per-MAIN-category totals, so the label can name the categories that are
     FULLY in ("BEDFRAME" when every bedframe line is READY while a mattress
     line on the same SO is not). A category is ready only when total === ready;
     one short line among ten disqualifies it. */
  const mainByCat = new Map<string, { total: number; ready: number }>();
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

  /* What IS ready — MAIN cats with every line allocated, in emission order,
     then the one collapsed ACC entry. Services never appear in either list:
     they carry no stock, so there is nothing for them to be ready FOR. */
  const readyCats: string[] = [];
  for (const cat of MAIN_CATEGORY_ORDER) {
    const cell = mainByCat.get(cat);
    if (cell && cell.total > 0 && cell.ready === cell.total) readyCats.push(cat);
  }
  if (accCount > 0 && accReady === accCount) readyCats.push('ACC');

  /* The complement — what is still short. Not the label; kept for callers that
     ask "what are we waiting on" (the probe scripts do). */
  const pc = [...pendingMainCats].sort();
  if (anyAccPending) pc.push('ACC');

  /* Stock remark — names WHAT IS READY.

     Deliberately NOT branched on bare isMainReady. That flag is VACUOUSLY TRUE
     when mainCount === 0, and reading it alone is exactly how an accessory-only
     SO with one short accessory came to print "READY (PARTIAL)" beside its own
     isShipReady of false. `mainCount > 0 &&` is that fix, and it is the
     difference between this and the pre-2026-08-16 code: PARTIAL asserts "the
     MAIN products are in", so an SO with no main line can never earn it and
     falls through to the ready list — which is empty while its accessories are
     short, so the cell says nothing. */
  let stockRemark: string;
  if (liveCount === 0) {
    stockRemark = '';                       // no lines — say nothing, ship nothing
  } else if (isFullyReady) {
    stockRemark = 'READY';                  // incl. service-only and acc-only-all-in
  } else if (mainCount > 0 && isMainReady) {
    stockRemark = 'PARTIAL';                // every MAIN in, an accessory is not
  } else {
    stockRemark = readyCats.join('/');      // '' when nothing is ready yet
  }

  return { mainCount, mainReady, accCount, accReady, svcCount, isMainReady, isFullyReady, isShipReady, stockRemark, readyCategories: readyCats, pendingCategories: pc };
}
