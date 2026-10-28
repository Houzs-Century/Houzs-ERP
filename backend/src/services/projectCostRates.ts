/**
 * Per-brand auto cost-line engine (mig 063).
 *
 * One row per project gets up to three derived cost lines —
 * transport, merchandise, commission — recomputed every time a
 * non-auto sales / cogs line changes. The lines are tagged
 * `auto_source` ('auto:transport' | 'auto:merchandise' |
 * 'auto:commission') so the UI can lock them and this service can
 * idempotently replace them.
 *
 * Wiring:
 *   - createLedgerLine / patchLedgerLine / archiveLedgerLine all call
 *     `recomputeAutoCostLines` after their non-auto writes complete.
 *     Auto-source writes do NOT trigger recursion.
 *   - The category breakdown SQL (/finance/by-project) groups by
 *     `category`, so auto rows naturally sum into the existing
 *     transport / commission / merchandise columns. No SQL changes.
 *
 * Boost rule (per brand, in `project_cost_rates`):
 *   commission_normal_pct applies unless BOTH gates pass:
 *     gp_pct ≥ boost_min_gp_pct  (skipped when NULL)
 *     sales  ≥ boost_min_sales   (skipped when NULL)
 *   When both pass, commission_boost_pct replaces normal.
 *
 * Skipping the engine: a project with no rate row for its brand gets
 * no auto lines (and any stale ones are archived). Same for projects
 * whose total sales is zero.
 */
import type { Env } from "../types";

interface RateRow {
  transport_pct: number;
  merchandise_pct: number;
  commission_normal_pct: number;
  commission_boost_pct: number | null;
  boost_min_gp_pct: number | null;
  boost_min_sales: number | null;
}

interface AutoSpec {
  // 2026-05-08 — transport now lands in `transport_fee` (rate-driven %
  // of sales), leaving the new `transport_setup_dismantle` slug for
  // the actual logistics cost humans enter manually. The auto_source
  // tag keeps using `auto:transport` for stable identity across the
  // existing backfill SQL — only the `category` slug changed.
  category: "transport_fee" | "merchandise" | "commission";
  source: "auto:transport" | "auto:merchandise" | "auto:commission";
  amount: number;
  description: string;
}

export async function recomputeAutoCostLines(
  env: Env,
  projectId: number,
  userId: number = 0,
): Promise<void> {
  const project = await env.DB.prepare(
    `SELECT brand, archived_at FROM projects WHERE id = ?`,
  )
    .bind(projectId)
    .first<{ brand: string | null; archived_at: string | null }>();

  // Archived projects keep their auto lines as historical record;
  // deleting them on archive would break audit. New rates only kick
  // in for live projects.
  if (!project || project.archived_at) {
    return;
  }
  const brand = project.brand?.trim();
  if (!brand) {
    await purgeAuto(env, projectId);
    return;
  }

  const rate = await env.DB.prepare(
    `SELECT transport_pct, merchandise_pct, commission_normal_pct,
            commission_boost_pct, boost_min_gp_pct, boost_min_sales
       FROM project_cost_rates WHERE brand = ?`,
  )
    .bind(brand)
    .first<RateRow>();

  if (!rate) {
    await purgeAuto(env, projectId);
    return;
  }

  // Sum non-auto lines only. Auto rows are excluded from the base
  // because they're outputs of this function — counting them would
  // create a feedback loop on commission (commission of commission).
  //
  // COGS is summed across the whole family — the legacy `cogs` slug plus the
  // three product sub-categories (matt/sofa, bedframe, accessories) — so the GP
  // used for the commission boost gate matches the "COGS Total" shown in the
  // Financial Snapshot, which folds the same four categories together. Reading
  // only `cogs` here would see 0 when COGS is entered split, inflate GP to
  // ~100%, and wrongly trip the boost rate.
  const sums = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN kind='income' AND category='sales' THEN amount END), 0) AS sales,
       COALESCE(SUM(CASE WHEN kind='cost'   AND category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories') THEN amount END), 0) AS cogs
       FROM project_finance_lines
      WHERE project_id = ?
        AND archived_at IS NULL
        AND auto_source IS NULL`,
  )
    .bind(projectId)
    .first<{ sales: number; cogs: number }>();

  const sales = Number(sums?.sales ?? 0);
  const cogs = Number(sums?.cogs ?? 0);

  if (sales <= 0) {
    await purgeAuto(env, projectId);
    return;
  }

  const gpPct = sales > 0 ? ((sales - cogs) / sales) * 100 : 0;
  const gpGate =
    rate.boost_min_gp_pct == null || gpPct >= Number(rate.boost_min_gp_pct);
  const salesGate =
    rate.boost_min_sales == null || sales >= Number(rate.boost_min_sales);
  const useBoost =
    rate.commission_boost_pct != null && gpGate && salesGate;
  const commissionPct = useBoost
    ? Number(rate.commission_boost_pct)
    : Number(rate.commission_normal_pct);

  const transport = round2((sales * Number(rate.transport_pct)) / 100);
  const merchandise = round2((sales * Number(rate.merchandise_pct)) / 100);
  const commission = round2((sales * commissionPct) / 100);

  const desc = (label: string, pct: number) =>
    `${label} (auto · ${formatPct(pct)} of sales)`;

  const specs: AutoSpec[] = [
    {
      category: "transport_fee",
      source: "auto:transport",
      amount: transport,
      description: desc("Transport Fee", Number(rate.transport_pct)),
    },
    {
      category: "merchandise",
      source: "auto:merchandise",
      amount: merchandise,
      description: desc("Merchandise", Number(rate.merchandise_pct)),
    },
    {
      category: "commission",
      source: "auto:commission",
      amount: commission,
      description: `Commission (auto · ${formatPct(commissionPct)} of sales${useBoost ? " — boost tier" : ""})`,
    },
  ];

  await upsertAutoLines(env, projectId, specs, userId);
}

async function purgeAuto(env: Env, projectId: number): Promise<void> {
  // Hard delete: auto rows are derived state, never user data, so we
  // don't need an archived_at trail. Re-inserts on next recompute.
  await env.DB.prepare(
    `DELETE FROM project_finance_lines
       WHERE project_id = ? AND auto_source IS NOT NULL`,
  )
    .bind(projectId)
    .run();
}

async function upsertAutoLines(
  env: Env,
  projectId: number,
  specs: AutoSpec[],
  userId: number,
): Promise<void> {
  // Read existing auto rows in one shot, then update each in place if
  // present and INSERT the rest. This keeps the line `id` stable
  // across recomputes — useful for the activity log and any future
  // attachment ties.
  const existing = await env.DB.prepare(
    `SELECT id, auto_source FROM project_finance_lines
      WHERE project_id = ? AND auto_source IS NOT NULL`,
  )
    .bind(projectId)
    .all<{ id: number; auto_source: string }>();

  const bySource = new Map<string, number>();
  for (const r of existing.results ?? []) bySource.set(r.auto_source, r.id);

  for (const spec of specs) {
    const existingId = bySource.get(spec.source);
    if (existingId != null) {
      await env.DB.prepare(
        `UPDATE project_finance_lines
            SET amount = ?, description = ?, archived_at = NULL,
                created_by = COALESCE(created_by, ?)
          WHERE id = ?`,
      )
        .bind(spec.amount, spec.description, userId || null, existingId)
        .run();
      bySource.delete(spec.source);
    } else {
      // Stamp company_id from the parent project (mig 0170) so the
      // /finance/pnl cost pull can filter by the active company —
      // auto-recomputed cost lines went unscoped alongside manual ones
      // until this fix.
      await env.DB.prepare(
        `INSERT INTO project_finance_lines
           (project_id, kind, category, description, amount,
            auto_source, created_by, company_id)
         VALUES (?, 'cost', ?, ?, ?, ?, ?,
                 (SELECT company_id FROM projects WHERE id = ?))`,
      )
        .bind(
          projectId,
          spec.category,
          spec.description,
          spec.amount,
          spec.source,
          userId || null,
          projectId,
        )
        .run();
    }
  }

  // Anything left in bySource is an auto row whose rule disappeared
  // (e.g. brand changed and the new brand has no rate card with that
  // category). Hard-delete the remnants.
  if (bySource.size > 0) {
    const ids = [...bySource.values()];
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(
      `DELETE FROM project_finance_lines WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .run();
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatPct(n: number): string {
  // Trim trailing zeros so 14.0 → "14%", 13.5 → "13.5%".
  return `${Number.isInteger(n) ? n.toFixed(0) : String(n)}%`;
}
