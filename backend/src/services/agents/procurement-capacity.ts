// ---------------------------------------------------------------------------
// procurement-capacity.ts — what a supplier can actually produce, and what we
// have already asked of them.
//
// ── THE OWNER'S MODEL (2026-07-17), which corrects the obvious one ──────────
//   "其实供应商的产量一定都是稳定的。除非是他们一 overload，就代表他们的产量其实
//    已经 overload 了；他们一提早送货，就代表他们的产量其实很松散。"
//
// A supplier's OUTPUT IS STABLE. Lateness is therefore not a trait of the
// supplier — it is a symptom of LOAD. That distinction is the whole file.
//
// The naive model (and the first one built here, procurement-learning.ts)
// learns "SUP-A runs 3 days late" and buffers every PO by 3 days. Under the
// owner's model that number blends two different worlds: SUP-A overloaded last
// December and slack in June. A p75 across both is too little in December and
// too much in June — wrong in both, and wrong in a way that averages away the
// only thing worth knowing. It is also why the answer to lateness is not always
// "order earlier"; sometimes it is "this supplier is full — split the order".
//
// So a supplier has TWO stable constants and ONE variable:
//   base turnaround  constant  — PO -> delivery when NOT overloaded
//   unitsPerWeek     constant  — what they can push out
//   queue delay      VARIABLE  — load / capacity. THIS is the lateness.
//
// ── THE CENSORING PROBLEM, AND WHY THE OWNER'S SECOND SENTENCE SOLVES IT ────
// We never observe capacity. We observe RECEIPTS, and
//
//     receipts(week) = min(capacity, load(week))
//
// A slack supplier's receipts measure what WE GAVE THEM, not what they can do.
// So an average of weekly receipts systematically UNDER-estimates capacity, and
// the more slack the supplier, the worse the under-estimate — exactly backwards.
//
// The owner's second sentence is the discriminator. A week they delivered LATE
// is a week they ran flat out, so that week's receipts sit AT the ceiling. A
// week they delivered EARLY is a week with slack, so that week's receipts are
// strictly BELOW it. His complaint is the measurement:
//
//   late week   -> receipts ~= capacity   -> USE as evidence of the ceiling
//   early week  -> receipts <  capacity   -> a floor, nothing more
//
// The first learner threw the early signal away outright (Math.max(0, slip)) —
// discarding his clearest evidence of spare capacity.
//
// When a (supplier, category) has NEVER been observed late we have no upper
// witness at all, and the estimate is flagged `isLowerBound`. Not a hedge: an
// agent must not propose moving work away from a supplier whose ceiling it has
// never actually seen.
//
// Pure functions only. No I/O, no writes, no proposals.
// ---------------------------------------------------------------------------

/** One receipt line, as evidence of throughput. */
export interface ReceiptUnit {
  supplierCode: string;
  /** item_group. Capacity is per (supplier, category) — owner's ruling: a sofa
      and a cushion are both "1 unit" but are not the same work, and category is
      the grain he already thinks and configures in. */
  category: string;
  /** Receipt date (YYYY-MM-DD) — buckets the week. */
  receivedDate: string;
  qty: number;
  /** Slip of the PO this receipt belonged to, in days. Positive = late. This is
      what says whether the week witnessed the ceiling or sat below it. */
  slipDays: number;
}

/** Open demand on a supplier — a PO line not yet fully received. */
export interface LoadUnit {
  supplierCode: string;
  category: string;
  /** The date the supplier is asked to deliver (YYYY-MM-DD). */
  dueDate: string;
  /** Units still outstanding (qty - received_qty). */
  qty: number;
}

export interface CapacityEstimate {
  supplierCode: string;
  category: string;
  /** Demonstrated units per week. */
  unitsPerWeek: number;
  weeksObserved: number;
  /** Weeks the supplier ran late — the ones that witness the ceiling. */
  weeksAtCeiling: number;
  /** TRUE when no late week was ever seen, so unitsPerWeek is only a FLOOR:
      we have seen them do at least this, never what they cannot do. */
  isLowerBound: boolean;
}

export interface OverloadFinding {
  supplierCode: string;
  category: string;
  /** Monday of the overloaded week (YYYY-MM-DD). */
  weekStart: string;
  loadUnits: number;
  capacityUnitsPerWeek: number;
  overloadUnits: number;
  /** Whole weeks the excess slips, at this capacity. */
  expectedSlipWeeks: number;
  capacityIsLowerBound: boolean;
  reason: string;
}

export interface SlackFinding {
  supplierCode: string;
  category: string;
  capacityUnitsPerWeek: number;
  loadUnits: number;
  spareUnits: number;
}

export interface CapacityConfig {
  /** Weeks of receipts needed before an estimate is offered at all. */
  minWeeks: number;
  /** Percentile of the ceiling weeks' receipts to call capacity. NOT the max:
      one catch-up week after a shutdown is not a sustainable rate.

      Kept at 75 rather than a higher-sounding 90 for a small-sample reason that
      is easy to get wrong: with nearest-rank, p90 IS the max for any n <= 9
      (ceil(0.9 * 9) = 9), and minWeeks is 6. A p90 default would therefore have
      claimed to exclude the freak week while quietly selecting it — the comment
      would have been false for every supplier with under ten weeks of history,
      which is all of them at first. p75 excludes the top quarter at n = 6. */
  percentile: number;
  /** A week witnesses the ceiling when its receipts slipped by at least this
      many days. 0 would read a comfortably on-time week as flat out. */
  ceilingSlipDays: number;
  /** Ignore an overload smaller than this — rounding, not a problem. */
  minOverloadUnits: number;
}

export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  minWeeks: 6,
  percentile: 75,
  ceilingSlipDays: 1,
  minOverloadUnits: 1,
};

const DAY_MS = 86_400_000;
/** 1970-01-05 was a Monday. Same anchor as po-grouping's merge window, so a
    capacity week and a mattress merge window are the same seven days. */
const MONDAY_EPOCH_MS = Date.parse('1970-01-05T00:00:00Z');

/* Composite map keys are NUL-joined, written as the ESCAPE. A supplier code is
   free text and may contain a space or a dash, so joining on either and
   splitting it back would silently mis-attribute one supplier's capacity to
   another — the worst failure available here, because it would still look like
   a working model. NUL cannot appear in a code. */
const SEP = '\u0000';
const pairKey = (supplier: string, category: string) => `${supplier}${SEP}${category}`;

/** The Monday of the ISO week a date falls in. Null if unparseable — the caller
    drops the row rather than bucketing it somewhere arbitrary. */
export function weekStartOf(dateStr: string | null | undefined): string | null {
  const s = (dateStr ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const weeks = Math.floor((ms - MONDAY_EPOCH_MS) / (7 * DAY_MS));
  return new Date(MONDAY_EPOCH_MS + weeks * 7 * DAY_MS).toISOString().slice(0, 10);
}

function percentileOf(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, pct)) / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

/**
 * Estimate each (supplier, category)'s sustained weekly throughput.
 *
 * Weeks with NO receipts are excluded. A supplier we sent nothing to is not a
 * supplier with zero capacity; folding those weeks in would drag every estimate
 * toward zero in proportion to how little we happened to order, punishing a
 * supplier for our own quiet quarter.
 */
export function estimateCapacity(
  receipts: ReceiptUnit[],
  cfg: CapacityConfig = DEFAULT_CAPACITY_CONFIG,
): CapacityEstimate[] {
  const byPair = new Map<string, Map<string, { qty: number; maxSlip: number }>>();

  for (const r of receipts) {
    const supplier = (r.supplierCode ?? '').trim();
    const category = (r.category ?? '').trim().toLowerCase();
    const week = weekStartOf(r.receivedDate);
    const qty = Number(r.qty);
    if (!supplier || !category || !week || !Number.isFinite(qty) || qty <= 0) continue;

    const k = pairKey(supplier, category);
    const weeks = byPair.get(k) ?? new Map<string, { qty: number; maxSlip: number }>();
    const cell = weeks.get(week) ?? { qty: 0, maxSlip: Number.NEGATIVE_INFINITY };
    cell.qty += qty;
    const slip = Number(r.slipDays);
    if (Number.isFinite(slip) && slip > cell.maxSlip) cell.maxSlip = slip;
    weeks.set(week, cell);
    byPair.set(k, weeks);
  }

  const out: CapacityEstimate[] = [];
  for (const [k, weeks] of byPair) {
    if (weeks.size < cfg.minWeeks) continue;
    const [supplierCode, category] = k.split(SEP);

    const cells = [...weeks.values()];
    /* The weeks that WITNESS the ceiling: they ran late, so their receipts sit
       at what the supplier could actually push out. Everything else is a floor.
       See the header — this is the owner's second sentence, operationalised. */
    const ceilingWeeks = cells.filter((c) => c.maxSlip >= cfg.ceilingSlipDays);
    const basis = ceilingWeeks.length > 0 ? ceilingWeeks : cells;

    const unitsPerWeek = percentileOf(basis.map((c) => c.qty), cfg.percentile);
    if (unitsPerWeek <= 0) continue;

    out.push({
      supplierCode,
      category,
      unitsPerWeek,
      weeksObserved: weeks.size,
      weeksAtCeiling: ceilingWeeks.length,
      isLowerBound: ceilingWeeks.length === 0,
    });
  }

  return out.sort((a, b) => b.unitsPerWeek - a.unitsPerWeek);
}

/**
 * Where the book we have already committed exceeds what a supplier can make.
 *
 * Deliberately NOT a rolling queue simulation: this reports each week's own
 * excess, and does not carry unmet load into the next week. A queue would be
 * more accurate and much harder to argue with — every downstream week would
 * inherit the upstream week's error, and one bad capacity estimate would smear
 * across the quarter. Per-week overload is a number the owner can check against
 * the supplier by phone, which is the point: the agent's job is to hand him a
 * decision, not to be believed.
 */
export function detectOverload(
  capacity: CapacityEstimate[],
  load: LoadUnit[],
  cfg: CapacityConfig = DEFAULT_CAPACITY_CONFIG,
): OverloadFinding[] {
  const capByPair = new Map(capacity.map((c) => [pairKey(c.supplierCode, c.category), c]));

  const loadByCell = new Map<string, number>();
  for (const l of load) {
    const supplier = (l.supplierCode ?? '').trim();
    const category = (l.category ?? '').trim().toLowerCase();
    const week = weekStartOf(l.dueDate);
    const qty = Number(l.qty);
    if (!supplier || !category || !week || !Number.isFinite(qty) || qty <= 0) continue;
    const k = `${pairKey(supplier, category)}${SEP}${week}`;
    loadByCell.set(k, (loadByCell.get(k) ?? 0) + qty);
  }

  const out: OverloadFinding[] = [];
  for (const [k, loadUnits] of loadByCell) {
    const [supplierCode, category, weekStart] = k.split(SEP);
    const cap = capByPair.get(pairKey(supplierCode, category));
    /* No estimate, no claim. An agent must not tell the owner a supplier is
       overloaded when it has never measured what that supplier can do. */
    if (!cap) continue;

    const overloadUnits = loadUnits - cap.unitsPerWeek;
    if (overloadUnits < cfg.minOverloadUnits) continue;

    const expectedSlipWeeks = Math.ceil(overloadUnits / cap.unitsPerWeek);
    out.push({
      supplierCode,
      category,
      weekStart,
      loadUnits,
      capacityUnitsPerWeek: cap.unitsPerWeek,
      overloadUnits,
      expectedSlipWeeks,
      capacityIsLowerBound: cap.isLowerBound,
      reason:
        `${supplierCode} / ${category}, week of ${weekStart}: ${loadUnits} units due against a ` +
        `demonstrated ${cap.unitsPerWeek}/week` +
        (cap.isLowerBound
          ? ' (never observed late, so this is a FLOOR on their capacity — weak signal)'
          : ` (witnessed over ${cap.weeksAtCeiling} week(s) running flat out)`) +
        `. ${overloadUnits} units over; expect roughly ${expectedSlipWeeks} week(s) late. ` +
        `Pull the order forward, split it to another supplier, or move the customer date.`,
    });
  }

  return out.sort((a, b) => b.overloadUnits - a.overloadUnits);
}

/**
 * The other half of the owner's sentence: who has room.
 *
 * "他们一提早送货，就代表他们的产量其实很松散" — a supplier delivering early has
 * spare capacity. That is not noise to floor at zero (which is what the first
 * learner did to it); it is the answer to "who do I split the overload to".
 *
 * A (supplier, category) with NO load in the week still has its full capacity
 * spare — absence of load is the most slack there is, so it is included.
 */
export function detectSlack(
  capacity: CapacityEstimate[],
  load: LoadUnit[],
  weekStart: string,
): SlackFinding[] {
  const loadByPair = new Map<string, number>();
  for (const l of load) {
    if (weekStartOf(l.dueDate) !== weekStart) continue;
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const k = pairKey((l.supplierCode ?? '').trim(), (l.category ?? '').trim().toLowerCase());
    loadByPair.set(k, (loadByPair.get(k) ?? 0) + qty);
  }

  const out: SlackFinding[] = [];
  for (const c of capacity) {
    const loadUnits = loadByPair.get(pairKey(c.supplierCode, c.category)) ?? 0;
    const spareUnits = c.unitsPerWeek - loadUnits;
    if (spareUnits <= 0) continue;
    out.push({
      supplierCode: c.supplierCode,
      category: c.category,
      capacityUnitsPerWeek: c.unitsPerWeek,
      loadUnits,
      spareUnits,
    });
  }
  return out.sort((a, b) => b.spareUnits - a.spareUnits);
}
