
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
import { resolveAgentCompany, scopeFor } from './agent-company';

const LEARNING_WINDOW_DAYS = 365;

const CAPACITY_WINDOW_DAYS = 365;

const TOP_OVERLOADS = 20;


export { PROCUREMENT_AGENT_SETTING_KEY };

/** Minimum supplier-binding coverage (% of shortage SKUs with a main supplier)
 *  before the agent will emit any reorder proposal. Owner-editable; 0..100. */
export const DEFAULT_MIN_COVERAGE_PCT = 90;

const TOP_SHORTAGES = 20;
const TOP_UNSUPPLIED = 20;
const TOP_GATED_MISSING = 20;


function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

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

async function minCoveragePct(db: D1Database): Promise<number> {
  const cfg = await readAgentSetting<Record<string, unknown>>(
    db,
    PROCUREMENT_AGENT_SETTING_KEY,
  );
  const n = Number(cfg?.minCoveragePct);
  if (!Number.isFinite(n)) return DEFAULT_MIN_COVERAGE_PCT;
  return Math.max(0, Math.min(100, Math.round(n)));
}


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
  companyId: number | null;
  companyCode: string | null;
  supplierCode: string;
  supplierName: string;
  skuCount: number;
  totalShortageUnits: number;
  draftedUnits: number;
  pickUnits: number;
  earliestOrderByDate: string | null;
  lines: ReorderLine[];
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
  learning: BufferFinding[];
}> {
  const db = env.DB;
  const nowIso = new Date().toISOString();

  const sb = getSupabaseService(env);
  const sbl = sb as unknown as SbLike;
  const company = scopeFor(await resolveAgentCompany(db, PROCUREMENT_AGENT_SETTING_KEY));
  if (company.refuse) {
    throw new Error(`procurement_company_unresolved: ${company.refuse}`);
  }
  const mrp = await computeMrp(sb, {
    catFilter: null,
    whFilter: null,
    includeUndated: false,
    companyId: company.companyId ?? null,
    leadBuffers: await loadLeadBuffers(db),
  });

  const capacity = await runCapacityPass(sbl);

  const shortageSkus = mrp.skus.filter((k) => k.shortage > 0);
  const shortageUnits = shortageSkus.reduce((sum, k) => sum + num(k.shortage), 0);
  const sofaSetShortage = num(mrp.totals?.sofaSetShortageCount);

  const withSupplier = shortageSkus.filter((k) => s(k.mainSupplierCode).trim() !== '');
  const coverage = shortageSkus.length === 0 ? 1 : withSupplier.length / shortageSkus.length;
  const coveragePct = Math.round(coverage * 100);
  const minPct = await minCoveragePct(db);
  const gated = coveragePct < minPct;

  const earliestOf = new Map<MrpSkuLike, string | null>();
  for (const k of shortageSkus) earliestOf.set(k, earliestOrderByDate(k.lines ?? []));

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

      const key = `REORDER:${company.code ?? '-'}:${supplierCode}`;
      if (openKeys.has(`REORDER\0${key}`)) continue;

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
        (draftedUnits > 0 ? ` (${draftedUnits} more already on an unconfirmed draft PO)` : '') +
        `, order by ${earliest ?? 'n/a'}.`;

      await db
        .prepare(
          `INSERT INTO procurement_agent_proposals (id, kind, key, status, payload, summary, created_at)
           VALUES (?, 'REORDER', ?, 'PENDING', ?::text::jsonb, ?, ?)`,
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
        'INSERT INTO procurement_agent_briefs (id, brief, ai_focus, created_at) VALUES (?, ?::text::jsonb, NULL, ?)',
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

function capacitySuffix(c: ProcurementBriefData['capacity']): string {
  if (c.overloads.length === 0) return '';
  const worst = c.overloads[0];
  return (
    ` ${c.overloads.length} supplier-week(s) over capacity — worst ${worst.supplierCode}/${worst.category} ` +
    `wk ${worst.weekStart}: ${worst.loadUnits} due vs ${worst.capacityUnitsPerWeek}/wk.`
  );
}

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

async function runProcurementLearning(
  env: Env,
  db: D1Database,
  sb: SbLike,
): Promise<BufferFinding[]> {
  const sinceIso = new Date(Date.now() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString();

  const samples = await loadReceiptSamples(sb, {
    sinceIso,
    companyId: null,
  });
  if (samples.length === 0) return [];

  const current = await loadLeadBuffers(db);
  return [
    ...learnSupplierBuffers(samples, current.supplierBufferDays),
    ...learnSeasonBuffers(samples, current.seasonBufferDays),
  ];
}


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
  }
  return { openProposals, lastBriefAt, shortageSkuCount };
}

interface MrpSkuLike {
  itemCode: string;
  description: string | null;
  category: string | null;
  warehouseCode: string | null;
  variantLabel: string | null;
  shortage: number;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  lines: Array<{ orderByDate: string | null; shortageQty: number; soItemId: string }>;
}
