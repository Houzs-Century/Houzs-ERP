// ----------------------------------------------------------------------------
// po-grouping.ts — the owner's per-CATEGORY rule for how SO lines become POs.
//
// Owner, 2026-09-11, verbatim re-spec of the COMBINED / PER-SO toggle. Each
// category responds differently to the ONE global toggle:
//
//   PER-SO   — everything stays with its own sales order, SPLIT BY CATEGORY:
//              each (SO, category) is its own PO.
//   COMBINE  — consolidate:
//     · Sofa      the whole SO's sofa + its accessories (pillow / 皮套) all on
//                 ONE PO. The cover is packed inside the sofa, so it must ride
//                 with it. (Per-SO instead splits the accessories off.)
//     · Bedframe  same as Per-SO — the toggle has NO effect. Same supplier +
//                 one SO -> one PO (even two or three bedframe lines). Different
//                 supplier splits.
//     · Mattress  merge same-supplier WITHIN the delivery WEEK (the window is
//                 KEPT — owner 2026-09-11 — so a mattress due in three months is
//                 not pulled into this week's PO; that would wreck turnover, the
//                 thing the window exists to protect).
//     · Accessory merge same-supplier ACROSS SOs — UNLESS the accessory belongs
//                 to a sofa order, in which case the sofa rule wins and it rides
//                 with the sofa (see `sofaSoDocNos`).
//
// This SUPERSEDES the owner's 2026-07-17 rules (sofa/bedframe hardcoded per-SO,
// mattress always per-window, accessory following the toggle). The per-line
// `splitRuleFor` abstraction that encoded those could not express the sofa's
// cross-category accessory pull — that depends on whether the line's SO carries
// a sofa, which is BATCH context, not a property of the line. So the rule now
// lives entirely in `groupKeyFor`, which takes that context.
//
// Every key still starts (warehouse, supplier). Folding the warehouse in is
// load-bearing: it guarantees each emitted PO is single-warehouse, which the
// downstream GRN relies on to land stock where the SO line asked for it. And a
// key can only ever merge lines of the SAME supplier, so the physical "one PO =
// one supplier" constraint is automatic — a sofa's accessory with a DIFFERENT
// supplier gets a different base and splits off, correctly.
//
// THE MATTRESS WINDOW is anchored to a real Monday (1970-01-05) rather than to
// "today", so the same line always falls in the same bucket no matter when the
// convert runs. At the default 7 days a bucket IS the ISO week ("this week's
// mattresses").
// ----------------------------------------------------------------------------

/** The caller's existing global toggle. Unchanged in meaning. */
export type PoMode = 'combined' | 'per-so';

/** Default merge window for mattress under Combine. 7 = the ISO week. */
export const DEFAULT_MATTRESS_WINDOW_DAYS = 7;

/** 1970-01-05 was a Monday. Anchoring to it makes a 7-day bucket == the ISO
    week, and makes every bucket independent of when the convert runs. */
const MONDAY_EPOCH_MS = Date.parse('1970-01-05T00:00:00Z');
const DAY_MS = 86_400_000;

/** A window of at least 1 whole day. A zero/negative/NaN window would collapse
    every mattress into one bucket (or throw), silently undoing the rule —
    reject the input rather than normalise it into a wrong answer. */
function normaliseWindow(days: number): number {
  if (!Number.isFinite(days) || days < 1) return DEFAULT_MATTRESS_WINDOW_DAYS;
  return Math.floor(days);
}

/**
 * The Monday (or window start) an ISO date falls into.
 * Returns null for a missing/unparseable date — the caller must decide what to
 * do with an undated line rather than have it silently share a bucket with
 * every other undated line.
 */
export function windowStartOf(dateStr: string | null | undefined, windowDays: number): string | null {
  const s = (dateStr ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const w = normaliseWindow(windowDays);
  const daysSinceAnchor = Math.floor((ms - MONDAY_EPOCH_MS) / DAY_MS);
  // floorDiv, so dates before the anchor (there are none in practice, but the
  // maths must not flip sign) still bucket downward.
  const bucket = Math.floor(daysSinceAnchor / w);
  return new Date(MONDAY_EPOCH_MS + bucket * w * DAY_MS).toISOString().slice(0, 10);
}

export interface GroupKeyInput {
  warehouseId: string | null;
  supplierId: string;
  soDocNo: string;
  itemGroup: string | null;
  /** The PO line's delivery date — i.e. AFTER the lead time has been subtracted.
      The window buckets what the SUPPLIER is asked to deliver, not what the
      customer asked for, because that is what actually lands in the warehouse. */
  deliveryDate: string | null;
}

export interface GroupKeyContext {
  /** SO doc numbers in THIS convert batch that carry a SOFA line. Under
      'combined', an accessory (or other non-core) line whose SO is in this set
      joins the sofa's PO instead of merging across SOs — the owner's "皮套 packed
      in the sofa rides with it" rule (2026-09-11). Empty set = no sofa orders in
      the batch, so accessories merge by supplier as normal. REQUIRED so a caller
      cannot forget it and silently lose the sofa-cover co-location. */
  sofaSoDocNos: ReadonlySet<string>;
  /** Mattress merge window in days; defaults to the ISO week. */
  mattressWindowDays?: number;
}

/**
 * The bucket key for one line. Same key = same PO (within one convert batch).
 *
 * Owner's per-category rules, 2026-09-11 (see the file header). The `toggle`
 * decides everything except bedframe, which is per-SO either way.
 */
export function groupKeyFor(input: GroupKeyInput, toggle: PoMode, ctx: GroupKeyContext): string {
  const base = `${input.warehouseId ?? 'null'}::${input.supplierId}`;
  const cat = (input.itemGroup ?? '').trim().toLowerCase();

  // PER-SO — everything with its own SO, split by category. The category tag is
  // what SPLITS a sofa order's sofa from its accessories (the owner's "分开").
  if (toggle === 'per-so') {
    return `${base}::so:${input.soDocNo}::cat:${cat || 'none'}`;
  }

  // COMBINE.
  switch (cat) {
    case 'sofa':
      // Per-SO (dye lot), and NO category tag — so this SO's accessories, keyed
      // the same below, MERGE onto the sofa's PO.
      return `${base}::so:${input.soDocNo}`;
    case 'bedframe':
      // Toggle has no effect: same supplier + one SO -> one PO. The category tag
      // keeps it off the sofa's untagged key even when an SO has both.
      return `${base}::so:${input.soDocNo}::cat:bedframe`;
    case 'mattress': {
      // Merge within the delivery WEEK (window kept, owner 2026-09-11). An
      // undated mattress cannot be windowed, so it falls back to its own SO
      // rather than merging into an arbitrary bucket.
      const start = windowStartOf(input.deliveryDate, normaliseWindow(ctx.mattressWindowDays ?? DEFAULT_MATTRESS_WINDOW_DAYS));
      return start ? `${base}::w:${start}::cat:mattress` : `${base}::so:${input.soDocNo}::cat:mattress`;
    }
    default:
      // Accessory / others. If this SO has a sofa, ride with it (the untagged
      // per-SO key, identical to the sofa's above). Otherwise merge same-supplier
      // across SOs into one accessory PO.
      return ctx.sofaSoDocNos.has(input.soDocNo)
        ? `${base}::so:${input.soDocNo}`
        : `${base}::acc`;
  }
}
