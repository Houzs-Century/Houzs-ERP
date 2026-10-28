// ---------------------------------------------------------------------------
// procurement-learning.ts — the Procurement Agent's LEARNER: how much earlier
// must we ask each supplier to deliver, so the goods are actually in the
// warehouse before the customer's date?
//
// Owner's standing rule, verbatim (2026-07-17):
//   "我的 Lead Time 都会提早。因为有些 Supplier 会迟送货 ... 如果不提早，一旦供应商
//    迟到，我们就完蛋了。因此，我们必须提早送货，并且要根据不同的供应商准时程度、
//    不同的季节以及不同的仓库，来制定提前的 Delivery Date。"
//
// The warehouse and category axes are his MANUAL table (scm.mrp_category_lead_
// times). This file learns the two axes he cannot maintain by hand — supplier
// punctuality and season — and proposes them as CONFIG PROPOSALS he approves.
// It never writes his table, and it never writes a PO. See scm/lib/lead-time.ts
// for how the layers add up.
//
// ── WHAT IS MEASURED ───────────────────────────────────────────────────────
//   sample  = a purchase order that reached status RECEIVED
//   asked   = purchase_orders.expected_at   (the date we asked for)
//   actual  = the receipt date of the GRN that completed it
//   slip    = actual - asked, in whole days. Positive = the supplier was late.
//
// `expected_at` is the ORIGINAL ask, deliberately — NOT effectiveDelivery().
// The supplier_delivery_date_2/3/4 push-backs are the supplier TELLING US they
// will be late; measuring against them would score a supplier on hitting their
// own revised promise and quietly forgive every push-back. The question this
// learner answers is "if I ask for date D, when do the goods actually turn up",
// so the original ask is the only honest denominator.
//
// ── WHY THIS DOES NOT RUN AWAY (read before changing anything) ─────────────
// The obvious fear with a self-tuning buffer is the feedback loop: add buffer ->
// ask earlier -> supplier has less time -> slips more -> add more buffer ->
// forever.
//
// It does not happen here, and the reason is structural. The SAME lead number
// drives BOTH sides: MRP's order-by hint (mrp.ts orderByOf) and the PO's asked
// delivery date (mfg-purchase-orders.ts) are both `customerDate - lead`. So a
// bigger lead moves WHEN WE ORDER and WHEN WE ASK earlier by the same amount.
// The supplier's own turnaround is untouched, so `slip` is invariant under the
// buffer and the loop settles instead of climbing.
//
// That invariance is a property of the current wiring, not a law. If anyone ever
// makes the order-by date and the asked date use different leads, this learner
// CAN run away and must be re-derived. Belt and braces meanwhile: the rule's
// `max` caps any single value, and every change is a proposal a human approves —
// a climbing series (+3, +6, +9) is visible in the console before it is real.
//
// ── WHY p75 AND NOT THE MEAN ──────────────────────────────────────────────
// The owner is protecting against a tail, not an average: "一旦供应商迟到，我们就
// 完蛋了". Buffering to the mean is late half the time by construction. But
// buffering to the worst case orders everything far too early, which lands stock
// in the warehouse to rot — the very turnover he is trying to optimise with the
// mattress merge rule. p75 is the deliberate middle: cover three receipts in
// four, and let him move it. Configurable, because it is a business judgement
// about how much stock he will hold to avoid how many late deliveries, and that
// is his call, not a constant.
// ---------------------------------------------------------------------------

import type { ConfigParamRule } from '../agent-console';
import { readAgentSetting } from '../agent-console';
import { paginateAll } from '../../scm/lib/paginate-all';
import type { LeadBuffers } from '../../scm/lib/lead-time';
/* One-directional: procurement-capacity.ts is pure and imports nothing from
   here, so loading its evidence from this module cannot cycle. */
import type { ReceiptUnit, LoadUnit } from './procurement-capacity';

/* The slice of the PostgREST client these loaders need. Structural rather than
   `any`, so a typo in a builder call is a compile error, and declared once so
   the loaders cannot drift into three different ideas of the same client.

   EXPORTED, because the callers have to name it. The real supabase-js client
   does NOT structurally satisfy this type — its `order` takes a specific
   options object, so a param typed `unknown` here is contravariantly
   incompatible, and inference across it trips TS2589 besides. The workaround
   was `sb as never` at each call site, which is the worst of both: `never` is
   assignable to ANYTHING, so a loader could be handed a number and tsc would
   nod. `as unknown as SbLike`, once, at the top of the caller, asserts the same
   thing but names what is being asserted and keeps the checking inside. */
export type SbLike = {
  from: (t: string) => {
    select: (cols: string) => {
      eq: (c: string, v: unknown) => any;
      in: (c: string, v: unknown[]) => any;
      gte: (c: string, v: unknown) => any;
      order: (c: string, o?: unknown) => any;
      range: (a: number, b: number) => any;
    };
  };
};

/* The app_settings row both the rules below and the engine read.
   It lives HERE, and procurement-agent.ts re-exports it, rather than the other
   way round — deliberately, to break an import cycle that typecheck does not
   catch and that only fails in production:
     procurement-agent -> procurement-learning -> procurement-agent
   The rules below reference this key at MODULE-EVAL time. If the engine were
   the owner and the engine were imported first (which is exactly what
   agents/index.ts does), this file's body would run while the engine's consts
   were still in the temporal dead zone -> ReferenceError at worker init. One
   direction only, so the cycle cannot exist. */
export const PROCUREMENT_AGENT_SETTING_KEY = 'agents.procurement';

/* The two tunables the learner may propose. Everything else is rejected at
   approve time — the whitelist is the fuse, not the learner's good manners.

   Bounds are deliberate, not decorative:
     min 0  — a NEGATIVE buffer would push the PO date LATER than the customer's
              own date. That is never a safety margin; it is shipping late on
              purpose. lead-time.ts refuses negatives at read time too, so a bad
              row that somehow lands is still inert.
     max 30 — a month. Past that the "buffer" is not punctuality any more, it is
              a wrong base lead in his manual table, and the answer is to fix the
              table rather than let an agent paper over it 60 days deep. It is
              also the runaway backstop described above. */
export const PROCUREMENT_SUPPLIER_BUFFER_RULE: ConfigParamRule = {
  // supplier_code as it exists in scm.suppliers — alnum, dash, underscore.
  pattern: /^procurement\.supplierBufferDays\.([A-Za-z0-9_-]{1,40})$/,
  min: 0,
  max: 30,
  settingKey: PROCUREMENT_AGENT_SETTING_KEY,
  path: (m) => ['supplierBufferDays', m[1]],
};

export const PROCUREMENT_SEASON_BUFFER_RULE: ConfigParamRule = {
  // Two-digit calendar month, 01..12. Anchored to the month of the customer's
  // delivery date — the month the goods are NEEDED, which is what is busy.
  pattern: /^procurement\.seasonBufferDays\.(0[1-9]|1[0-2])$/,
  min: 0,
  max: 30,
  settingKey: PROCUREMENT_AGENT_SETTING_KEY,
  path: (m) => ['seasonBufferDays', m[1]],
};

/** One completed purchase order — the unit of evidence. */
export interface ReceiptSample {
  poNumber: string;
  supplierCode: string;
  supplierName: string | null;
  /** purchase_orders.expected_at — the ORIGINAL asked date (YYYY-MM-DD). */
  askedDate: string;
  /** The receipt date of the GRN that completed the PO (YYYY-MM-DD). */
  actualDate: string;
}

export interface LearnerConfig {
  /** Fewer receipts than this and no proposal is made for that key. */
  minSamples: number;
  /** Which percentile of slip to buffer to. 0..100. */
  percentile: number;
  /** Do not propose a change smaller than this many days — a 1-day nudge is
      noise the owner has to read and approve for nothing. */
  minDelta: number;
}

export const DEFAULT_LEARNER_CONFIG: LearnerConfig = {
  minSamples: 5,
  percentile: 75,
  minDelta: 2,
};

export interface BufferFinding {
  /** The config_proposals param_key — must match the rule's pattern. */
  paramKey: string;
  /** Human label for the console. */
  subject: string;
  samples: number;
  medianSlipDays: number;
  percentileSlipDays: number;
  worstSlipDays: number;
  currentDays: number;
  proposedDays: number;
  reason: string;
}

/** Whole days between two ISO dates. Null if either is unusable — an
    unparseable date is dropped from the evidence rather than scored as 0 slip,
    which would silently flatter a supplier. */
export function slipDays(askedDate: string, actualDate: string): number | null {
  const a = Date.parse(`${(askedDate ?? '').slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${(actualDate ?? '').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Nearest-rank percentile over a sorted copy. Small samples here (5-50), so
    the simple definition is the right one — no interpolation to explain. */
export function percentileOf(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const p = Math.min(100, Math.max(0, pct));
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

function median(values: number[]): number {
  return percentileOf(values, 50);
}

/**
 * Learn a per-supplier buffer from completed receipts.
 *
 * Pure — takes evidence, returns findings. No I/O, no writes, no proposals: the
 * caller decides whether a finding becomes a config proposal. That split is the
 * house rule (engines are deterministic calculators; wiring happens in
 * agents/index.ts), and it is what makes this testable without a database.
 *
 * Returns ONLY keys where the proposal differs from the current value by at
 * least `minDelta`. A finding the owner has already answered must not come back
 * every morning.
 */
export function learnSupplierBuffers(
  samples: ReceiptSample[],
  currentBuffers: Record<string, number>,
  cfg: LearnerConfig = DEFAULT_LEARNER_CONFIG,
): BufferFinding[] {
  const bySupplier = new Map<string, { name: string | null; slips: number[] }>();

  for (const s of samples) {
    const code = (s.supplierCode ?? '').trim();
    if (!code) continue;
    const slip = slipDays(s.askedDate, s.actualDate);
    if (slip == null) continue;
    const bucket = bySupplier.get(code) ?? { name: s.supplierName, slips: [] };
    bucket.slips.push(slip);
    bySupplier.set(code, bucket);
  }

  const out: BufferFinding[] = [];
  for (const [code, { name, slips }] of bySupplier) {
    if (slips.length < cfg.minSamples) continue;
    // The key must round-trip the whitelist, or approval would reject a proposal
    // the agent was allowed to make. Drop rather than mangle the code.
    const paramKey = `procurement.supplierBufferDays.${code}`;
    if (!PROCUREMENT_SUPPLIER_BUFFER_RULE.pattern.test(paramKey)) continue;

    const p = percentileOf(slips, cfg.percentile);
    // A supplier who runs EARLY has a negative percentile slip. That is not a
    // reason to ask later — the base lead is the owner's call and the buffer's
    // floor is zero. Punctual suppliers simply carry no buffer.
    const proposed = Math.max(0, Math.min(PROCUREMENT_SUPPLIER_BUFFER_RULE.max, Math.round(p)));
    const current = Number.isFinite(currentBuffers[code]) ? Number(currentBuffers[code]) : 0;
    if (Math.abs(proposed - current) < cfg.minDelta) continue;

    const med = median(slips);
    const worst = Math.max(...slips);
    out.push({
      paramKey,
      subject: name ? `${name} (${code})` : code,
      samples: slips.length,
      medianSlipDays: med,
      percentileSlipDays: p,
      worstSlipDays: worst,
      currentDays: current,
      proposedDays: proposed,
      reason:
        `${name ?? code}: ${slips.length} completed POs. ` +
        `Median ${fmtDays(med)} vs the date we asked for, p${cfg.percentile} ${fmtDays(p)}, worst ${fmtDays(worst)}. ` +
        `Buffer ${current}d -> ${proposed}d so ${cfg.percentile}% of their receipts land before the customer's date.`,
    });
  }

  return out.sort((a, b) => b.proposedDays - a.proposedDays);
}

/**
 * Learn a per-month buffer — the season axis.
 *
 * Keyed on the month of the ASKED date, i.e. the month the goods were due, not
 * the month the PO was raised. A December crunch shows up as December deliveries
 * running late; when the order was placed is not the thing that is busy.
 *
 * Deliberately measures the SAME slip as the supplier learner, which means the
 * two layers double-count a supplier who is only ever late in December. That is
 * a known and accepted overlap for v1: both layers are capped, both are
 * proposals a human approves, and over-buffering is a turnover cost rather than
 * a missed delivery. Separating them properly needs a residual model (slip minus
 * the supplier's own baseline), which is not worth its complexity until there is
 * a season signal in the data at all.
 */
export function learnSeasonBuffers(
  samples: ReceiptSample[],
  currentBuffers: Record<string, number>,
  cfg: LearnerConfig = DEFAULT_LEARNER_CONFIG,
): BufferFinding[] {
  const byMonth = new Map<string, number[]>();

  for (const s of samples) {
    const month = (s.askedDate ?? '').slice(5, 7);
    if (!/^(0[1-9]|1[0-2])$/.test(month)) continue;
    const slip = slipDays(s.askedDate, s.actualDate);
    if (slip == null) continue;
    const arr = byMonth.get(month) ?? [];
    arr.push(slip);
    byMonth.set(month, arr);
  }

  const out: BufferFinding[] = [];
  for (const [month, slips] of byMonth) {
    if (slips.length < cfg.minSamples) continue;
    const p = percentileOf(slips, cfg.percentile);
    const proposed = Math.max(0, Math.min(PROCUREMENT_SEASON_BUFFER_RULE.max, Math.round(p)));
    const current = Number.isFinite(currentBuffers[month]) ? Number(currentBuffers[month]) : 0;
    if (Math.abs(proposed - current) < cfg.minDelta) continue;

    out.push({
      paramKey: `procurement.seasonBufferDays.${month}`,
      subject: MONTH_NAMES[month] ?? month,
      samples: slips.length,
      medianSlipDays: median(slips),
      percentileSlipDays: p,
      worstSlipDays: Math.max(...slips),
      currentDays: current,
      proposedDays: proposed,
      reason:
        `${MONTH_NAMES[month] ?? month} deliveries: ${slips.length} completed POs due that month. ` +
        `Median ${fmtDays(median(slips))} vs the date we asked for, p${cfg.percentile} ${fmtDays(p)}. ` +
        `Season buffer ${current}d -> ${proposed}d.`,
    });
  }

  return out.sort((a, b) => b.proposedDays - a.proposedDays);
}

function fmtDays(d: number): string {
  if (d === 0) return 'on time';
  return d > 0 ? `${d}d late` : `${Math.abs(d)}d early`;
}

// ── Buffer reader (the other direction: approved values -> the PO date) ─────

/**
 * Read the buffers the owner has APPROVED, for scm/lib/lead-time.ts to add on
 * top of his manual table.
 *
 * Fail-soft, and that is the right trade here rather than the usual fail-loud:
 * a missing/broken app_settings row means "no buffer learned yet", which is
 * also the true state on day one and after every reset. Degrading to the
 * owner's own base lead is the conservative answer — it is exactly today's
 * behaviour. Throwing would take the whole PO convert down over an optional
 * refinement.
 *
 * That is the OPPOSITE call from loadLeadTimeBase, deliberately: his base table
 * failing to load is unknowable ignorance being written to a supplier
 * commitment, so it must throw. A missing buffer is a known, safe zero.
 */
export async function loadLeadBuffers(db: D1Database): Promise<LeadBuffers> {
  try {
    const cfg = await readAgentSetting<Record<string, unknown>>(db, PROCUREMENT_AGENT_SETTING_KEY);
    return {
      supplierBufferDays: asNumberMap(cfg?.supplierBufferDays),
      seasonBufferDays: asNumberMap(cfg?.seasonBufferDays),
    };
  } catch (e) {
    console.warn('[procurement-learning] buffer read failed; falling back to base lead only:', e);
    return { supplierBufferDays: {}, seasonBufferDays: {} };
  }
}

/** A stored buffer map, defensively. Anything non-numeric is dropped rather
    than coerced — a NaN buffer would poison every date it touched. */
function asNumberMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

// ── Capacity evidence ───────────────────────────────────────────────────────

/**
 * Per-receipt-line evidence of throughput, for procurement-capacity.ts.
 *
 * Each row carries the slip of the PO it belonged to, because that is what says
 * whether its week witnessed the supplier's ceiling or merely their spare time
 * — see that module's header. The slip is per-PO, not per-line: a PO is one
 * promise, and every line on it shares that promise's outcome.
 */
export async function loadCapacityEvidence(
  sb: SbLike,
  opts: { sinceIso: string },
): Promise<ReceiptUnit[]> {
  type GrnRow = {
    id: string;
    supplier_id: string;
    received_at: string | null;
    purchase_order_id: string | null;
  };
  const { data: grns, error: gErr } = await paginateAll<GrnRow>((from, to) =>
    sb
      .from('grns')
      .select('id, supplier_id, received_at, purchase_order_id')
      .eq('status', 'POSTED')
      .gte('received_at', opts.sinceIso.slice(0, 10))
      .order('id')
      .range(from, to),
  );
  if (gErr) throw new Error(`procurement_capacity_grn_load_failed: ${gErr.message}`);
  const grnRows = (grns ?? []).filter((g) => g.received_at && g.supplier_id);
  if (grnRows.length === 0) return [];

  // The PO each GRN came from, for its asked date -> the slip.
  const poIds = [...new Set(grnRows.map((g) => g.purchase_order_id).filter((x): x is string => Boolean(x)))];
  const askedByPo = new Map<string, string>();
  for (let i = 0; i < poIds.length; i += 200) {
    type PoRow = { id: string; expected_at: string | null };
    const { data: pos, error: pErr } = await paginateAll<PoRow>((from, to) =>
      sb
        .from('purchase_orders')
        .select('id, expected_at')
        .in('id', poIds.slice(i, i + 200))
        .order('id')
        .range(from, to),
    );
    if (pErr) throw new Error(`procurement_capacity_po_load_failed: ${pErr.message}`);
    for (const p of pos ?? []) if (p.expected_at) askedByPo.set(p.id, p.expected_at.slice(0, 10));
  }

  const grnIds = grnRows.map((g) => g.id);
  type ItemRow = { grn_id: string; qty_accepted: number | null; item_group: string | null };
  const items: ItemRow[] = [];
  for (let i = 0; i < grnIds.length; i += 200) {
    const { data: rows, error: iErr } = await paginateAll<ItemRow>((from, to) =>
      sb
        .from('grn_items')
        .select('grn_id, qty_accepted, item_group')
        .in('grn_id', grnIds.slice(i, i + 200))
        .order('grn_id')
        .range(from, to),
    );
    if (iErr) throw new Error(`procurement_capacity_item_load_failed: ${iErr.message}`);
    items.push(...(rows ?? []));
  }

  const supCodeById = await loadSupplierCodes(sb);
  const grnById = new Map(grnRows.map((g) => [g.id, g]));

  const out: ReceiptUnit[] = [];
  for (const it of items) {
    const g = grnById.get(it.grn_id);
    if (!g) continue;
    const code = supCodeById.get(g.supplier_id);
    const category = (it.item_group ?? '').trim();
    const qty = Number(it.qty_accepted);
    if (!code || !category || !Number.isFinite(qty) || qty <= 0) continue;

    const asked = g.purchase_order_id ? askedByPo.get(g.purchase_order_id) : undefined;
    const received = g.received_at!.slice(0, 10);
    /* No asked date = no slip = we cannot tell whether this week witnessed the
       ceiling. Drop it rather than default the slip to 0, which would falsely
       claim the week was flat out and over-read the supplier's capacity. */
    if (!asked) continue;
    const slip = slipDays(asked, received);
    if (slip == null) continue;

    out.push({ supplierCode: code, category, receivedDate: received, qty, slipDays: slip });
  }
  return out;
}

/**
 * Qty already sitting on a DRAFT PO, per source SO line.
 *
 * THE BLIND SPOT THIS COVERS. A DRAFT PO is deliberately inert: PO_DEAD keeps
 * it out of MRP's supply, and recomputeSoPicked refuses to let it advance
 * po_qty_picked. Both are correct — a draft is a proposal, not a commitment.
 * But together they mean the agent cannot see its own approved work. Approve a
 * reorder, get a DRAFT PO, and the next run recomputes the SAME shortage (the
 * draft is invisible to supply), finds no PENDING proposal for that supplier
 * (the last one is APPROVED), and proposes it again. Approve twice and the
 * supplier is asked for double.
 *
 * So the agent subtracts drafts explicitly, HERE, rather than by weakening
 * either guard. It reads the live world instead of remembering what it did, so
 * it self-heals both ways: delete the draft and the shortage is proposable
 * again; confirm it and it leaves DRAFT, MRP counts it as real supply, and the
 * shortage closes on its own.
 *
 * THROWS on a read error, and that is the whole point. Returning an empty map
 * on failure would say "nothing is drafted" — the one answer that re-proposes
 * everything already awaiting confirm. A blip must stop the run, not double an
 * order.
 */
export async function loadDraftedQtyBySoItem(sb: SbLike): Promise<Map<string, number>> {
  type Row = { so_item_id: string | null; qty: number | null };
  const { data, error } = await paginateAll<Row>((from, to) =>
    sb
      .from('purchase_order_items')
      .select('so_item_id, qty, po:purchase_orders!inner ( status )')
      .eq('po.status', 'DRAFT')
      .order('id')
      .range(from, to),
  );
  if (error) throw new Error(`procurement_drafted_load_failed: ${error.message}`);

  const out = new Map<string, number>();
  for (const r of (data ?? []) as Row[]) {
    const id = (r.so_item_id ?? '').trim();
    const q = Number(r.qty ?? 0);
    // A manually-added PO line carries no so_item_id — it converts no SO line,
    // so it can't cover one either.
    if (!id || !Number.isFinite(q) || q <= 0) continue;
    out.set(id, (out.get(id) ?? 0) + q);
  }
  return out;
}

/**
 * What we have already asked of each supplier and not yet received.
 * A PO line's own delivery_date is the ask; the header's expected_at is the
 * fallback for a line that never carried one.
 */
export async function loadOpenLoad(
  sb: SbLike,
): Promise<LoadUnit[]> {
  type Row = {
    qty: number | null;
    received_qty: number | null;
    delivery_date: string | null;
    item_group: string | null;
    po: { status: string; expected_at: string | null; supplier_id: string | null } | null;
  };
  const { data, error } = await paginateAll<Row>((from, to) =>
    sb
      .from('purchase_order_items')
      .select('qty, received_qty, delivery_date, item_group, po:purchase_orders!inner ( status, expected_at, supplier_id )')
      .in('po.status', ['SUBMITTED', 'PARTIALLY_RECEIVED'])
      .order('id')
      .range(from, to),
  );
  if (error) throw new Error(`procurement_capacity_load_load_failed: ${error.message}`);

  const supCodeById = await loadSupplierCodes(sb);
  const out: LoadUnit[] = [];
  for (const r of (data ?? []) as Row[]) {
    if (!r.po?.supplier_id) continue;
    const code = supCodeById.get(r.po.supplier_id);
    const category = (r.item_group ?? '').trim();
    const dueDate = (r.delivery_date ?? r.po.expected_at ?? '').slice(0, 10);
    const left = Number(r.qty ?? 0) - Number(r.received_qty ?? 0);
    if (!code || !category || !dueDate || !Number.isFinite(left) || left <= 0) continue;
    out.push({ supplierCode: code, category, dueDate, qty: left });
  }
  return out;
}

/** supplier uuid -> business code. `code` is scm.suppliers' key, not
    `supplier_code` (which is a PO-line column on a different table). */
async function loadSupplierCodes(sb: SbLike): Promise<Map<string, string>> {
  type SupRow = { id: string; code: string | null };
  const { data, error } = await paginateAll<SupRow>((from, to) =>
    sb
      .from('suppliers')
      .select('id, code')
      .order('id')
      .range(from, to),
  );
  if (error) throw new Error(`procurement_supplier_codes_load_failed: ${error.message}`);
  const m = new Map<string, string>();
  for (const s of data ?? []) if (s.code) m.set(s.id, s.code.trim());
  return m;
}

// ── Evidence loader ─────────────────────────────────────────────────────────

/**
 * Pull the completed-receipt evidence the learners score.
 *
 * Sample definition — a PO with status RECEIVED. Deliberately narrow:
 *   - PARTIALLY_RECEIVED is excluded. A PO still trickling in has no honest
 *     completion date, and scoring it on its first GRN would credit a supplier
 *     for a partial drop. (It is also the lifecycle's known hole — an
 *     under-received PO can sit at PARTIALLY_RECEIVED forever with no
 *     short-close — so it would poison the evidence permanently, not briefly.)
 *   - CANCELLED and DRAFT GRNs are excluded, matching recomputePoReceived's own
 *     definition of a real receipt.
 *
 * `actual` is the LATEST receipt across the PO's GRNs — the PO is not complete
 * until its last line lands, so that is the date the goods were really there.
 *
 * Every read is paginated. PostgREST silently caps at 1000 rows and a `.limit()`
 * does NOT lift it; a truncated sample here would not error, it would just
 * quietly teach the agent from whichever thousand rows came back — the exact
 * shape already logged against the MRP demand read.
 *
 * Reads throw on error. A learner that trains on a partial read because a query
 * failed is worse than a learner that did not run.
 */
export async function loadReceiptSamples(
  sb: SbLike,
  opts: { sinceIso: string; companyId: number | null },
): Promise<ReceiptSample[]> {
  const scope = <Q>(q: Q): Q =>
    opts.companyId != null ? (q as unknown as { eq(c: string, v: unknown): Q }).eq('company_id', opts.companyId) : q;

  type PoRow = { id: string; po_number: string; supplier_id: string; expected_at: string | null };
  const { data: pos, error: poErr } = await paginateAll<PoRow>((from, to) =>
    scope(
      sb
        .from('purchase_orders')
        .select('id, po_number, supplier_id, expected_at')
        .eq('status', 'RECEIVED')
        .gte('po_date', opts.sinceIso.slice(0, 10)),
    )
      .order('id')
      .range(from, to),
  );
  if (poErr) throw new Error(`procurement_learning_po_load_failed: ${poErr.message}`);
  const poRows = (pos ?? []).filter((p) => p.expected_at && p.supplier_id);
  if (poRows.length === 0) return [];

  // GRN receipts for those POs. Chunked `.in()` — a 3000-PO list in one URL is
  // a 414, and PostgREST's row cap applies to the response either way.
  type GrnRow = { purchase_order_id: string; received_at: string | null };
  const receiptByPo = new Map<string, string>();
  const ids = poRows.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: grns, error: gErr } = await paginateAll<GrnRow>((from, to) =>
      sb
        .from('grns')
        .select('purchase_order_id, received_at')
        .in('purchase_order_id', chunk)
        // GRN statuses are DRAFT | POSTED | CANCELLED — there is no RECEIVED.
        // POSTED is the only one that means the goods are in, and it is what
        // both the create and the DRAFT->confirm transition write.
        // recomputePoReceived states the same rule from the other side
        // ("if CANCELLED or DRAFT -> excluded"); allow-listing POSTED rather
        // than deny-listing those two means a NEW status would make the learner
        // under-count (visible as too few samples -> no proposal) instead of
        // silently scoring something that is not a receipt.
        .eq('status', 'POSTED')
        .order('purchase_order_id')
        .range(from, to),
    );
    if (gErr) throw new Error(`procurement_learning_grn_load_failed: ${gErr.message}`);
    for (const g of grns ?? []) {
      const at = (g.received_at ?? '').slice(0, 10);
      if (!at) continue;
      const prev = receiptByPo.get(g.purchase_order_id);
      // Latest wins — the PO is complete when its LAST GRN lands.
      if (!prev || at > prev) receiptByPo.set(g.purchase_order_id, at);
    }
  }

  // scm.suppliers' business key is `code`, not `supplier_code` (the latter is a
  // PO-line column on a different table). The buffer is keyed on the CODE, not
  // the uuid, so a supplier row re-keyed or re-imported keeps its learned
  // history — and so the owner can read the proposal and know who it is about.
  type SupRow = { id: string; code: string | null; name: string | null };
  const { data: sups, error: sErr } = await paginateAll<SupRow>((from, to) =>
    scope(sb.from('suppliers').select('id, code, name')).order('id').range(from, to),
  );
  if (sErr) throw new Error(`procurement_learning_supplier_load_failed: ${sErr.message}`);
  const supById = new Map((sups ?? []).map((s) => [s.id, s]));

  const out: ReceiptSample[] = [];
  for (const p of poRows) {
    const actual = receiptByPo.get(p.id);
    // A PO marked RECEIVED with no GRN receipt date is a data problem, not a
    // punctual supplier — drop it rather than score it as on-time.
    if (!actual) continue;
    const sup = supById.get(p.supplier_id);
    const code = (sup?.code ?? '').trim();
    if (!code) continue;
    out.push({
      poNumber: p.po_number,
      supplierCode: code,
      supplierName: sup?.name ?? null,
      askedDate: p.expected_at!.slice(0, 10),
      actualDate: actual,
    });
  }
  return out;
}

const MONTH_NAMES: Record<string, string> = {
  '01': 'January', '02': 'February', '03': 'March', '04': 'April',
  '05': 'May', '06': 'June', '07': 'July', '08': 'August',
  '09': 'September', '10': 'October', '11': 'November', '12': 'December',
};
