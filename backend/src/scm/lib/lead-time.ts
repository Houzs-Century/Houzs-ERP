// ----------------------------------------------------------------------------
// lead-time.ts — the ONE resolver for "how many days before the customer's
// delivery date must the supplier deliver".
//
// WHY THIS FILE EXISTS. The rule lived in two hand-rolled copies that had
// already drifted on the thing that matters most — error handling:
//
//   scm/routes/mrp.ts            — the MRP order-by HINT (display only).
//                                  Checked the query error. Its comment records
//                                  the scar: a swallowed error "silently zeroed
//                                  EVERY lead time -> order-by date = delivery
//                                  date for the whole plan".
//   scm/routes/mfg-purchase-orders.ts — the PO-from-SO convert, i.e. the code
//                                  that WRITES the date onto a real purchase
//                                  order. DISCARDED the query error.
//
// So the fix landed on the half that only draws a hint and was never applied to
// the half that commits a supplier's delivery date. A transient PostgREST blip
// during a convert (cold start / pooler wobble — both routine here) zeroed every
// lead day, and the PO went out asking the supplier to deliver ON the day the
// customer expects the goods. Silent: the PO looks perfectly normal.
//
// Both callers now come through here, so there is no second copy to drift.
//
// THE MODEL — three additive layers, each with a different owner:
//
//   base     scm.mrp_category_lead_times[(warehouse, category)]
//            The OWNER's manual setting. Authoritative. Nothing in this file,
//            and no agent, may change it.
//   supplier a LEARNED safety buffer per supplier, from how late that supplier
//            actually delivers (agents.procurement.supplierBufferDays).
//   season   a LEARNED safety buffer per calendar month
//            (agents.procurement.seasonBufferDays).
//
//   total = base + supplier + season
//
// Owner's rule, in his words: "我的 Lead Time 都会提早 ... 要根据不同的供应商准时
// 程度、不同的季节以及不同的仓库，来制定提前的 Delivery Date." The warehouse and
// category axes are his manual table; supplier and season are what the agent
// learns. Keeping them as separate ADDITIVE layers (rather than letting an agent
// rewrite his table) means his number always survives, every buffer is
// separately attributable, and any layer can be zeroed without touching another.
//
// The layers are reported broken out (LeadTimeBreakdown) precisely so a proposal
// can say WHY a date moved: "base 7 + supplier 3 (SUP-012 ran 3.2 days late over
// its last 9 receipts) + season 2 (December)". A single collapsed number would
// make the agent unexplainable.
// ----------------------------------------------------------------------------

/** The five fixed lead-time categories. Mirrors scm.mrp_category_lead_times'
    CHECK constraint and the frontend's LEAD_CATEGORIES. A line's category is
    its item_group, matched lowercase. */
export const LEAD_CATEGORIES = ['sofa', 'bedframe', 'mattress', 'accessory', 'service'] as const;
export type LeadCategory = (typeof LEAD_CATEGORIES)[number];

/** The owner's manual base table, loaded once per request.
    byWhCat is keyed `${warehouseId}|${category}`; byCat holds the
    warehouse_id IS NULL rows (the GLOBAL DEFAULT bucket). */
export interface LeadTimeBase {
  byWhCat: Map<string, number>;
  byCat: Map<string, number>;
}

/** The agent's learned buffers. Both default to empty = a pure no-op, which is
    what ships first: with no buffers this resolver returns exactly the base,
    i.e. byte-for-byte the behaviour of the two copies it replaces. */
export interface LeadBuffers {
  /** by supplier CODE (not id) — the code is what survives a supplier re-key. */
  supplierBufferDays: Record<string, number>;
  /** by 2-digit calendar month of the customer delivery date: '01'..'12'. */
  seasonBufferDays: Record<string, number>;
}

export const NO_BUFFERS: LeadBuffers = { supplierBufferDays: {}, seasonBufferDays: {} };

export interface LeadTimeInput {
  warehouseId: string | null;
  /** The SO/PO line's item_group. Matched lowercase; anything outside the five
      categories simply misses and contributes 0 — same as the code replaced. */
  category: string | null;
  /** Optional. Omit (or pass null) to skip the supplier layer entirely. */
  supplierCode?: string | null;
  /** The customer delivery date (ISO YYYY-MM-DD). Drives the season lookup.
      Omit to skip the season layer. */
  deliveryDate?: string | null;
}

/** Every layer, broken out. `total` is what the caller subtracts. */
export interface LeadTimeBreakdown {
  base: number;
  supplier: number;
  season: number;
  total: number;
}

type LeadRow = { warehouse_id: string | null; category: string; lead_days: number };

/**
 * Load the owner's base table.
 *
 * THROWS on a query error, deliberately and non-negotiably. A swallowed error
 * here yields `data: null` -> empty maps -> every lookup returns 0 -> every PO
 * asks the supplier to deliver on the customer's own date. That failure is
 * invisible downstream: a zero lead day and a missing table are the same number.
 * The error is the ONLY thing that can tell them apart, so it must not be
 * dropped. The caller is expected to fail the whole convert rather than write a
 * wrong-but-plausible date.
 *
 * `query` is the already-company-scoped PostgREST builder — scoping differs
 * between callers (scopeToCompany(c) vs scoped()), so it stays outside.
 */
export async function loadLeadTimeBase(
  query: PromiseLike<{ data: unknown; error: { message?: string } | null }>,
): Promise<LeadTimeBase> {
  const { data, error } = await query;
  if (error) throw new Error(`mrp_lead_times_load_failed: ${error.message ?? 'unknown'}`);

  const byWhCat = new Map<string, number>();
  const byCat = new Map<string, number>();
  for (const r of (data ?? []) as LeadRow[]) {
    const cat = (r.category ?? '').toLowerCase();
    const days = Number(r.lead_days);
    if (!Number.isFinite(days)) continue;
    if (r.warehouse_id) byWhCat.set(`${r.warehouse_id}|${cat}`, days);
    else byCat.set(cat, days);
  }
  return { byWhCat, byCat };
}

/** The PostgREST column list every caller selects. One constant so the two
    callers cannot select different shapes. */
export const LEAD_TIME_SELECT = 'warehouse_id, category, lead_days';

/**
 * base only — the owner's manual number.
 * Cascade, unchanged from both originals: (warehouse, category) -> (NULL,
 * category) -> 0. A missing warehouse skips straight to the global bucket.
 */
function baseLeadDays(base: LeadTimeBase, warehouseId: string | null, category: string | null): number {
  const cat = (category ?? '').toLowerCase();
  return (
    (warehouseId ? base.byWhCat.get(`${warehouseId}|${cat}`) : undefined) ??
    base.byCat.get(cat) ??
    0
  );
}

/** A non-negative whole number, or 0. Buffers are safety margin: a negative
    would pull the PO date LATER than the customer's date, which is never the
    intent and would silently ship the order late. Reject rather than trust. */
function safeBuffer(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/**
 * Resolve every layer. Pure — no I/O, so it is directly testable.
 *
 * With NO_BUFFERS this returns { base, 0, 0, total: base }, which is exactly
 * what the two hand-rolled copies computed. That equivalence is the point: the
 * convergence ships as a provable no-op plus the error fix, and the learned
 * layers land separately.
 */
export function resolveLeadDays(
  base: LeadTimeBase,
  buffers: LeadBuffers,
  input: LeadTimeInput,
): LeadTimeBreakdown {
  const b = baseLeadDays(base, input.warehouseId, input.category);

  const supplier = input.supplierCode
    ? safeBuffer(buffers.supplierBufferDays[input.supplierCode])
    : 0;

  const month = monthOf(input.deliveryDate);
  const season = month ? safeBuffer(buffers.seasonBufferDays[month]) : 0;

  return { base: b, supplier, season, total: b + supplier + season };
}

/** '2026-12-04' -> '12'. Null for anything unparseable — the season layer then
    contributes 0 rather than guessing a month. */
function monthOf(dateStr: string | null | undefined): string | null {
  const s = (dateStr ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s.slice(5, 7);
}

/**
 * Pull an ISO date back by whole CALENDAR days.
 *
 * Calendar, not working, days — matching the behaviour this replaces. Weekends
 * and public holidays are NOT modelled anywhere in this system; a lead time of 7
 * means seven calendar days. Any future working-day rule belongs here, in the
 * one place both callers now share.
 *
 * Returns the input unchanged for days <= 0 or an unparseable date, and null for
 * no date — never throws, because a line legitimately may carry no delivery date.
 */
export function subtractCalendarDays(dateStr: string | null | undefined, days: number): string | null {
  if (!dateStr) return null;
  if (!Number.isFinite(days) || days <= 0) return dateStr;
  const ms = Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return dateStr;
  return new Date(ms - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Push an ISO date FORWARD by whole calendar days — the exact inverse of
 * subtractCalendarDays. subtract answers "order by when, to hit a delivery date"
 * (deliveryDate - lead); add answers "if I order now, ready when" (orderDate +
 * lead), which is the Procurement Agent's estimateReadyDate A2A fact. Same
 * calendar-day model (weekends/holidays not modelled anywhere in this system).
 * Returns the input unchanged for days <= 0, and null for no date; never throws.
 */
export function addCalendarDays(dateStr: string | null | undefined, days: number): string | null {
  if (!dateStr) return null;
  if (!Number.isFinite(days) || days <= 0) return dateStr;
  const ms = Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return dateStr;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
