// ---------------------------------------------------------------------------
// procurement-agent.ts — the Houzs Procurement Agent's deterministic ENGINE: an
// MRP-driven reorder sweep. The owner asked for the HOOKKA flow — "run MRP,
// then propose POs to suppliers." This engine runs the SAME allocation the SCM
// MRP page uses (computeMrp), and when supplier-binding coverage across the
// shortage SKUs is high enough, emits one per-supplier REORDER proposal.
//
// The engine only:
//   1. runProcurementAgent — runs MRP, applies the readiness gate, and (when
//      not gated) writes PENDING REORDER rows into procurement_agent_proposals
//      (migration 0096), one per supplier that owns shortage SKUs. It also
//      writes ONE deterministic snapshot into procurement_agent_briefs.
//   2. procurementAgentStatus — cheap counters for the console card (must not
//      throw before the migration has been applied).
//
// RED LINES (enforced structurally):
//   - PROPOSAL-ONLY, never a PO. This module NEVER creates or edits an
//     scm.purchase_orders row. Its proposals live in procurement_agent_proposals
//     (public schema), which is EXACTLY why MRP never double-counts them: MRP's
//     supply calc only reads real, non-DEAD scm POs, so a pending reorder can't
//     leak back into next run's poOutstanding. On approval the office raises the
//     real PO through the existing SO->PO converter.
//   - Auto-send (email / WhatsApp to the supplier) is OUT OF SCOPE for this
//     file — a documented later step. Nothing here contacts a supplier.
//   - Deterministic — no LLM calls, no invented numbers. MrpSku carries no cost,
//     so proposals are QUANTITIES + DATES only; cost/value estimation is a later
//     enhancement (brief.estimatedValueSen is left null to mark the seam).
//   - Money would be integer sen if it existed here — but it does not yet.
//
// READINESS GATE (ships first, on purpose): supplier bindings/costs are not
// fully seeded on the SCM catalogue yet, so a low-coverage run would propose
// reorders for only the handful of SKUs that happen to have a main supplier and
// silently drop the rest. Instead the engine computes coverage = (shortage SKUs
// with a main supplier) / (all shortage SKUs) and, when it falls below
// minCoveragePct (app_settings['agents.procurement'], default 90), creates NO
// proposals and records why. Reorder proposals unlock once coverage is high.
//
// DB access, following house patterns:
//   - scm data (MRP allocation) → getSupabaseService(env) (PostgREST), read via
//     computeMrp so the agent and the MRP page can never disagree.
//   - public tables (procurement_agent_*, app_settings) → env.DB (d1-compat
//     shim over postgres.js). Rows read off env.DB are read snake_case as-is,
//     matching the sibling agent engines.
// ---------------------------------------------------------------------------

import type { Env } from '../../types';
import { getSupabaseService } from '../../db/supabase';
import { readAgentSetting } from '../agent-console';
import { computeMrp } from '../../scm/routes/mrp';
import {
  PROCUREMENT_AGENT_SETTING_KEY,
  loadReceiptSamples,
  loadLeadBuffers,
  loadCapacityEvidence,
  loadOpenLoad,
  loadDraftedQtyBySoItem,
  type SbLike,
  learnSupplierBuffers,
  learnSeasonBuffers,
  type BufferFinding,
} from './procurement-learning';
import { estimateCapacity, detectOverload } from './procurement-capacity';
/* Shared with cs-agent: the three-state answer to "which book?", in one place,
   because both headless agents had the same hole and a second copy of the
   switch is how one of them silently keeps it. */
import { resolveAgentCompany, scopeFor } from './agent-company';

/* How far back the learner reads receipts. A year covers every season once, and
   is short enough that a supplier who has since improved is not held to two-year
   -old misses. */
const LEARNING_WINDOW_DAYS = 365;

/* Capacity reads the same year. A supplier's ceiling is a stable constant per
   the owner's model, so a longer window buys nothing; a shorter one would miss
   the busy season, which is the only season that witnesses the ceiling. */
const CAPACITY_WINDOW_DAYS = 365;

/** Bound the brief's overload list — a deep first run stays readable. */
const TOP_OVERLOADS = 20;

// ── Config (app_settings['agents.procurement']) ──────────────────────────────

/* Defined in procurement-learning.ts (imported above) and re-exported here so
   this module stays the public face of the family — existing importers are
   unchanged. The ownership is that way round to keep the import graph
   one-directional; see the note on the definition. */
export { PROCUREMENT_AGENT_SETTING_KEY };

/** Minimum supplier-binding coverage (% of shortage SKUs with a main supplier)
 *  before the agent will emit any reorder proposal. Owner-editable; 0..100. */
export const DEFAULT_MIN_COVERAGE_PCT = 90;

/** Bound the top-lists so a deep first-run backlog stays a readable brief. */
const TOP_SHORTAGES = 20;
const TOP_UNSUPPLIED = 20;
const TOP_GATED_MISSING = 20;

// ── Small helpers ────────────────────────────────────────────────────────────

function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Earliest non-null orderByDate across a set of MRP lines (YMD compares). */
function earliestOrderByDate(
  lines: Array<{ orderByDate: string | null }>,
): string | null {
  let best: string | null = null;
  for (const l of lines) {
    const d = l.orderByDate;
    if (!d) continue;
    if (best == null || d < best) best = d;
  }
  return best;
}

/** Whole-day tunable pct from app_settings['agents.procurement'], clamped 0..100. */
async function minCoveragePct(db: D1Database): Promise<number> {
  const cfg = await readAgentSetting<Record<string, unknown>>(
    db,
    PROCUREMENT_AGENT_SETTING_KEY,
  );
  const n = Number(cfg?.minCoveragePct);
  if (!Number.isFinite(n)) return DEFAULT_MIN_COVERAGE_PCT;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ── Brief shape ──────────────────────────────────────────────────────────────

export interface ProcurementBriefData {
  generatedAt: string;
  gated: boolean;
  coveragePct: number;
  minCoveragePct: number;
  shortage: { skuCount: number; shortageUnits: number; sofaSetShortage: number };
  reorderBySupplier: Array<{
    supplierCode: string;
    supplierName: string;
    skuCount: number;
    shortageUnits: number;
    earliestOrderByDate: string | null;
  }>;
  unsuppliedSkus: Array<{ itemCode: string; description: string | null; shortage: number }>;
  topShortages: Array<{
    itemCode: string;
    description: string | null;
    shortage: number;
    mainSupplierName: string | null;
    earliestOrderByDate: string | null;
  }>;
  openProposals: { total: number };
  /* Owner 2026-07-17: "供应商的产量一定都是稳定的 ... 一 overload 就代表他们的产量
     其实已经 overload 了". Lateness is a symptom of load, so the brief reports the
     CAUSE — which weeks we have over-committed a supplier — rather than a
     punctuality score. See procurement-capacity.ts.

     `pairsMeasured` and `pairsLowerBoundOnly` are in the brief on purpose: an
     overload count means nothing without knowing how much of the book we can
     actually see. A day-one agent measures nothing and must say so. */
  capacity: {
    pairsMeasured: number;
    pairsLowerBoundOnly: number;
    overloads: Array<{
      supplierCode: string;
      category: string;
      weekStart: string;
      loadUnits: number;
      capacityUnitsPerWeek: number;
      overloadUnits: number;
      expectedSlipWeeks: number;
      capacityIsLowerBound: boolean;
    }>;
  };
}

// ── Proposal persistence (procurement_agent_proposals, public schema) ────────

type ReorderLine = {
  itemCode: string;
  description: string | null;
  category: string | null;
  warehouseCode: string | null;
  variantLabel: string | null;
  shortageQty: number;
  orderByDate: string | null;
};

interface ReorderPayload {
  /* WHOSE BOOK. The executor stamps the PO with THIS, never with the approving
     user's active company — those are different questions, and answering the
     second when you meant the first files a PO of one company's SO lines under
     another. null = the companies master was unresolved at plan time, which is
     the single-company case where stamping no-ops anyway. */
  companyId: number | null;
  companyCode: string | null;
  supplierCode: string;
  supplierName: string;
  skuCount: number;
  /** What MRP says is short, before drafts. The unadjusted MRP truth. */
  totalShortageUnits: number;
  /** Of that shortage, how much is already on a DRAFT PO awaiting confirm and
   *  therefore NOT asked for again here. Carried so the gap between
   *  totalShortageUnits and pickUnits is stated rather than left to be
   *  rediscovered by whoever notices the numbers disagree. */
  draftedUnits: number;
  /** What this proposal actually orders: sum of picks. */
  pickUnits: number;
  earliestOrderByDate: string | null;
  lines: ReorderLine[];
  /* THE TRANSLATION LAYER, and the reason approving this used to do nothing.
     The agent thinks in SKUs ("MAT-QUEEN is 40 short"); the SO->PO converter
     takes SO LINE ids. Nothing mapped between them, so an approved proposal was
     a worklist tick and a human retyped it into the picker by hand.

     MRP already carries the bridge — every MrpLine has `soItemId` ("lets the UI
     one-click PO this line"). These are exactly the shape POST /from-sos wants,
     so approval can hand them straight to the SAME converter a human uses:
     identical supplier resolution, combo redistribution, per-category split and
     lead-time derivation. A separate agent-only PO writer would have been a
     second implementation of all of that, and the two would have drifted.

     `supplierId` is deliberately NOT sent. The agent grouped these by the SKU's
     main supplier, and the converter resolves the main supplier itself — from
     the bindings as they are AT EXECUTION TIME, not as they were when the
     proposal was written. Fresher, and it avoids the converter's documented
     fall-through (naming a supplier with no binding for that SKU silently lands
     the line on the main supplier anyway). The proposal's supplierCode is the
     agent's reasoning, not an instruction. */
  picks: Array<{ soItemId: string; qty: number }>;
}

async function openProposalKeys(db: D1Database): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const res = await db
      .prepare("SELECT kind, key FROM procurement_agent_proposals WHERE status = 'PENDING'")
      .all<{ kind: string; key: string }>();
    for (const r of res.results ?? []) keys.add(`${s(r.kind)}\0${s(r.key)}`);
  } catch (e) {
    console.warn('[procurement-agent] open-proposal key read failed:', e);
  }
  return keys;
}

async function openProposalTotal(db: D1Database): Promise<number> {
  try {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM procurement_agent_proposals WHERE status = 'PENDING'")
      .first<{ n: number | string }>();
    return num(r?.n);
  } catch {
    return 0;
  }
}

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * MRP-driven reorder sweep. Runs the SCM MRP allocation, applies the
 * supplier-coverage readiness gate, and — only when coverage is high enough —
 * writes one PENDING REORDER proposal per supplier owning shortage SKUs.
 * Always writes exactly one deterministic brief snapshot (ai_focus NULL).
 * PROPOSAL-ONLY: never touches scm.purchase_orders.
 */
export async function runProcurementAgent(
  env: Env,
): Promise<{
  summary: string;
  brief: ProcurementBriefData;
  proposalsCreated: number;
  /** Lead-time buffer findings. Findings, not writes — agents/index.ts turns
      them into config proposals the owner approves. */
  learning: BufferFinding[];
}> {
  const db = env.DB;
  const nowIso = new Date().toISOString();

  const sb = getSupabaseService(env);
  /* ONE assertion, here, instead of an `as never` at each loader call. See
     SbLike: supabase-js's generics don't unify with a structural type, but
     `as never` disabled the checking entirely rather than narrowing it. */
  const sbl = sb as unknown as SbLike;
  /* ONE company's books — see agent-company.ts. Passing nothing here is what
     made this sweep pool two companies' demand into one PO. */
  const company = scopeFor(await resolveAgentCompany(db, PROCUREMENT_AGENT_SETTING_KEY));
  if (company.refuse) {
    /* Refuse rather than plan the wrong book. A reorder proposal names
       quantities against a company's stock; getting the company wrong makes
       every number on it a fiction. */
    throw new Error(`procurement_company_unresolved: ${company.refuse}`);
  }
  const mrp = await computeMrp(sb, {
    catFilter: null,
    whFilter: null,
    includeUndated: false,
    companyId: company.companyId ?? null,
    leadBuffers: await loadLeadBuffers(db),
  });

  /* Measured once and used by BOTH the summary line and the brief below. The
     pass is several paginated reads; running it twice to serve two consumers
     would double the agent's cost for one number. */
  const capacity = await runCapacityPass(sbl);

  const shortageSkus = mrp.skus.filter((k) => k.shortage > 0);
  const shortageUnits = shortageSkus.reduce((sum, k) => sum + num(k.shortage), 0);
  const sofaSetShortage = num(mrp.totals?.sofaSetShortageCount);

  // Readiness gate: fraction of shortage SKUs that carry a main supplier binding.
  const withSupplier = shortageSkus.filter((k) => s(k.mainSupplierCode).trim() !== '');
  const coverage = shortageSkus.length === 0 ? 1 : withSupplier.length / shortageSkus.length;
  const coveragePct = Math.round(coverage * 100);
  const minPct = await minCoveragePct(db);
  const gated = coveragePct < minPct;

  // Precompute each shortage SKU's earliest order-by date once.
  const earliestOf = new Map<MrpSkuLike, string | null>();
  for (const k of shortageSkus) earliestOf.set(k, earliestOrderByDate(k.lines ?? []));

  // topShortages: biggest shortages first — always informative, gated or not.
  const topShortages = shortageSkus
    .slice()
    .sort((a, b) => num(b.shortage) - num(a.shortage))
    .slice(0, TOP_SHORTAGES)
    .map((k) => ({
      itemCode: s(k.itemCode),
      description: k.description ?? null,
      shortage: num(k.shortage),
      mainSupplierName: k.mainSupplierName ?? null,
      earliestOrderByDate: earliestOf.get(k) ?? null,
    }));

  let proposalsCreated = 0;
  let reorderBySupplier: ProcurementBriefData['reorderBySupplier'] = [];
  let unsuppliedSkus: ProcurementBriefData['unsuppliedSkus'] = [];
  let summary: string;

  if (gated) {
    // No proposals. Report coverage + the SKUs holding it back (missing a supplier).
    const missing = shortageSkus
      .filter((k) => s(k.mainSupplierCode).trim() === '')
      .sort((a, b) => num(b.shortage) - num(a.shortage));
    unsuppliedSkus = missing.slice(0, TOP_GATED_MISSING).map((k) => ({
      itemCode: s(k.itemCode),
      description: k.description ?? null,
      shortage: num(k.shortage),
    }));
    summary =
      `Procurement gated: supplier coverage ${coveragePct}% below the ${minPct}% threshold ` +
      `(${withSupplier.length}/${shortageSkus.length} shortage SKU(s) have a main supplier). ` +
      `No reorder proposals created; ${missing.length} shortage SKU(s) still need a supplier binding.` + capacitySuffix(capacity);
  } else {
    // Group shortage SKUs by main supplier; SKUs with none go to unsuppliedSkus.
    const bySupplier = new Map<string, { name: string; skus: MrpSkuLike[] }>();
    const noSupplier: MrpSkuLike[] = [];
    for (const k of shortageSkus) {
      const code = s(k.mainSupplierCode).trim();
      if (code === '') {
        noSupplier.push(k);
        continue;
      }
      const bucket = bySupplier.get(code) ?? { name: s(k.mainSupplierName) || code, skus: [] };
      bucket.skus.push(k);
      bySupplier.set(code, bucket);
    }
    unsuppliedSkus = noSupplier
      .sort((a, b) => num(b.shortage) - num(a.shortage))
      .slice(0, TOP_UNSUPPLIED)
      .map((k) => ({
        itemCode: s(k.itemCode),
        description: k.description ?? null,
        shortage: num(k.shortage),
      }));

    const openKeys = await openProposalKeys(db);
    /* Qty already on a DRAFT PO awaiting confirm — invisible to MRP's supply by
       design, so it must be subtracted here or an approved proposal gets
       proposed a second time. See loadDraftedQtyBySoItem. Deliberately NOT
       wrapped in a try: a failed read must abort the run, not silently report
       nothing drafted. */
    const draftedBySoItem = await loadDraftedQtyBySoItem(sbl);

    for (const [supplierCode, bucket] of bySupplier) {
      const lines: ReorderLine[] = bucket.skus.map((k) => ({
        itemCode: s(k.itemCode),
        description: k.description ?? null,
        category: k.category ?? null,
        warehouseCode: k.warehouseCode ?? null,
        variantLabel: k.variantLabel ?? null,
        shortageQty: num(k.shortage),
        orderByDate: earliestOf.get(k) ?? null,
      }));
      const totalShortageUnits = lines.reduce((sum, l) => sum + l.shortageQty, 0);
      const earliest = earliestOrderByDate(lines);
      const supplierName = bucket.name;

      /* SKU shortages -> the SO lines that are actually short, in the shape the
         converter takes. Only lines with a real uncovered qty: an MrpLine
         already covered by stock or an open PO carries shortageQty 0 and must
         not be ordered again.

         Then subtract what an earlier approval already put on a DRAFT PO. The
         `?? 0` is honest here and not the usual lie: the map is COMPLETE (the
         load throws rather than returning a partial one), so a missing key
         really does mean no draft line covers this SO line. */
      let draftedUnits = 0;
      const picks = bucket.skus.flatMap((k) =>
        (k.lines ?? [])
          .filter((l) => num(l.shortageQty) > 0 && s(l.soItemId) !== '')
          .map((l) => {
            const soItemId = s(l.soItemId);
            const drafted = Math.min(draftedBySoItem.get(soItemId) ?? 0, num(l.shortageQty));
            draftedUnits += drafted;
            return { soItemId, qty: num(l.shortageQty) - drafted };
          })
          .filter((p) => p.qty > 0),
      );
      const pickUnits = picks.reduce((sum, p) => sum + p.qty, 0);

      reorderBySupplier.push({
        supplierCode,
        supplierName,
        skuCount: lines.length,
        shortageUnits: totalShortageUnits,
        earliestOrderByDate: earliest,
      });

      /* Company in the key: the dedupe is per supplier PER BOOK. Without it a
         second company's reorder from the same supplier would read as a
         duplicate of the first and never be raised. */
      const key = `REORDER:${company.code ?? '-'}:${supplierCode}`;
      if (openKeys.has(`REORDER\0${key}`)) continue;

      /* Every short line is already on a draft awaiting confirm — there is
         nothing left to ask this supplier for. Proposing it again would be the
         double-order described on loadDraftedQtyBySoItem. */
      if (picks.length === 0) continue;

      const payload: ReorderPayload = {
        companyId: company.companyId ?? null,
        companyCode: company.code,
        supplierCode,
        supplierName,
        skuCount: lines.length,
        totalShortageUnits,
        draftedUnits,
        pickUnits,
        earliestOrderByDate: earliest,
        lines,
        picks,
      };
      const proposalSummary =
        `Reorder from ${supplierName} (${supplierCode}): ${lines.length} SKU(s), ` +
        `${pickUnits} unit(s) to order across ${picks.length} SO line(s)` +
        /* Named, never netted silently: MRP says short N, this asks for less,
           and the reader is owed the reason. */
        (draftedUnits > 0 ? ` (${draftedUnits} more already on an unconfirmed draft PO)` : '') +
        `, order by ${earliest ?? 'n/a'}.`;

      await db
        .prepare(
          `INSERT INTO procurement_agent_proposals (id, kind, key, status, payload, summary, created_at)
           VALUES (?, 'REORDER', ?, 'PENDING', ?::jsonb, ?, ?)`,
        )
        .bind(crypto.randomUUID(), key, JSON.stringify(payload), proposalSummary, nowIso)
        .run();
      openKeys.add(`REORDER\0${key}`);
      proposalsCreated++;
    }

    reorderBySupplier.sort((a, b) => b.shortageUnits - a.shortageUnits);
    summary =
      `Procurement: ${shortageSkus.length} shortage SKU(s), ${shortageUnits} unit(s) short ` +
      `across ${reorderBySupplier.length} supplier(s) (coverage ${coveragePct}%); ` +
      `created ${proposalsCreated} reorder proposal(s)` +
      (noSupplier.length > 0 ? `, ${noSupplier.length} SKU(s) still unsupplied` : '') +
      `. Proposal only — raise POs via the SO->PO converter.` + capacitySuffix(capacity);
  }

  const brief: ProcurementBriefData = {
    generatedAt: nowIso,
    gated,
    coveragePct,
    minCoveragePct: minPct,
    shortage: {
      skuCount: shortageSkus.length,
      shortageUnits,
      sofaSetShortage,
    },
    reorderBySupplier,
    unsuppliedSkus,
    topShortages,
    openProposals: { total: await openProposalTotal(db) },
    capacity,
  };

  try {
    await db
      .prepare(
        'INSERT INTO procurement_agent_briefs (id, brief, ai_focus, created_at) VALUES (?, ?::jsonb, NULL, ?)',
      )
      .bind(crypto.randomUUID(), JSON.stringify(brief), nowIso)
      .run();
  } catch (e) {
    console.warn('[procurement-agent] brief snapshot insert failed:', e);
  }

  /* LEARNING — the lead-time buffers (owner: "根据不同的供应商准时程度、不同的季节
     ... 来制定提前的 Delivery Date"). Findings only; agents/index.ts turns them
     into config proposals he approves. Nothing here writes a buffer.

     Best-effort by contract, like the brief snapshot above: a learner failure
     must not sink the reorder sweep, which is the run's actual job. It also
     fails SILENT-BUT-LOUD-IN-LOGS rather than fabricating an empty finding set,
     so "no proposals" never masquerades as "everyone is punctual". */
  let learning: BufferFinding[] = [];
  try {
    learning = await runProcurementLearning(env, db, sbl);
  } catch (e) {
    console.warn('[procurement-agent] learning pass failed (reorder sweep unaffected):', e);
  }

  return { summary, brief, proposalsCreated, learning };
}

/* The capacity headline for the console card. Silent when nothing is
   over-committed — an agent that says "0 overloads" every morning trains the
   owner to stop reading it. */
function capacitySuffix(c: ProcurementBriefData['capacity']): string {
  if (c.overloads.length === 0) return '';
  const worst = c.overloads[0];
  return (
    ` ${c.overloads.length} supplier-week(s) over capacity — worst ${worst.supplierCode}/${worst.category} ` +
    `wk ${worst.weekStart}: ${worst.loadUnits} due vs ${worst.capacityUnitsPerWeek}/wk.`
  );
}

/**
 * Measure each (supplier, category)'s ceiling and find the weeks we have
 * over-committed it.
 *
 * Best-effort, like every other pass here: a capacity failure must not sink the
 * reorder sweep. It degrades to "measured nothing" — which is also the honest
 * day-one state — rather than to a fabricated empty overload list that would
 * read as "nothing is overloaded".
 */
async function runCapacityPass(sb: SbLike): Promise<ProcurementBriefData['capacity']> {
  const empty = { pairsMeasured: 0, pairsLowerBoundOnly: 0, overloads: [] };
  try {
    const sinceIso = new Date(Date.now() - CAPACITY_WINDOW_DAYS * 86_400_000).toISOString();
    const [receipts, load] = await Promise.all([
      loadCapacityEvidence(sb, { sinceIso }),
      loadOpenLoad(sb),
    ]);
    const estimates = estimateCapacity(receipts);
    if (estimates.length === 0) return empty;

    return {
      pairsMeasured: estimates.length,
      pairsLowerBoundOnly: estimates.filter((e) => e.isLowerBound).length,
      overloads: detectOverload(estimates, load).slice(0, TOP_OVERLOADS).map((o) => ({
        supplierCode: o.supplierCode,
        category: o.category,
        weekStart: o.weekStart,
        loadUnits: o.loadUnits,
        capacityUnitsPerWeek: o.capacityUnitsPerWeek,
        overloadUnits: o.overloadUnits,
        expectedSlipWeeks: o.expectedSlipWeeks,
        capacityIsLowerBound: o.capacityIsLowerBound,
      })),
    };
  } catch (e) {
    console.warn('[procurement-agent] capacity pass failed (reorder sweep unaffected):', e);
    return empty;
  }
}

/* Load the receipt evidence and score both buffer axes. Split out so the engine
   above stays one job per function and the learner can be exercised alone. */
async function runProcurementLearning(
  env: Env,
  db: D1Database,
  sb: SbLike,
): Promise<BufferFinding[]> {
  const sinceIso = new Date(Date.now() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString();

  const samples = await loadReceiptSamples(sb, {
    sinceIso,
    // Single-company today; the learner must not blend 2990's supplier
    // punctuality into Houzs's buffers once company #2 carries real POs. The
    // sibling engine's un-scoped computeMrp call is a known gap — do not repeat
    // it here.
    companyId: null,
  });
  if (samples.length === 0) return [];

  /* The CURRENT buffers, read through the same loader the PO convert uses — so
     the learner always compares against the value that is actually in force,
     and cannot propose a change away from a number nobody is applying. */
  const current = await loadLeadBuffers(db);
  return [
    ...learnSupplierBuffers(samples, current.supplierBufferDays),
    ...learnSeasonBuffers(samples, current.seasonBufferDays),
  ];
}

// ── Console card counters ────────────────────────────────────────────────────

export async function procurementAgentStatus(
  env: Env,
): Promise<{ openProposals: number; lastBriefAt: string | null; shortageSkuCount: number }> {
  const db = env.DB;
  const openProposals = await openProposalTotal(db);
  let lastBriefAt: string | null = null;
  let shortageSkuCount = 0;
  try {
    const r = await db
      .prepare('SELECT brief, created_at FROM procurement_agent_briefs ORDER BY created_at DESC LIMIT 1')
      .first<{ brief?: string | Record<string, unknown> | null; created_at?: string | null }>();
    lastBriefAt = r?.created_at ?? null;
    if (r?.brief != null) {
      const parsed =
        typeof r.brief === 'string' ? (JSON.parse(r.brief) as Record<string, unknown>) : r.brief;
      const shortage = (parsed as { shortage?: { skuCount?: unknown } }).shortage;
      shortageSkuCount = num(shortage?.skuCount);
    }
  } catch {
    /* pre-migration / unparseable — zeros */
  }
  return { openProposals, lastBriefAt, shortageSkuCount };
}

// ── Local structural view of the MrpSku fields this engine reads ─────────────
// (mrp.ts does not export MrpSku; we only touch these verified fields.)
interface MrpSkuLike {
  itemCode: string;
  description: string | null;
  category: string | null;
  warehouseCode: string | null;
  variantLabel: string | null;
  shortage: number;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  /* soItemId verified against mrp.ts's MrpLine (:140 — "mfg_sales_order_items.id
     — lets the UI one-click PO this line"). It is the bridge from the agent's
     SKU view to the converter's SO-line view; without it an approved proposal
     cannot become a PO. */
  lines: Array<{ orderByDate: string | null; shortageQty: number; soItemId: string }>;
}
