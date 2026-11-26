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
  const entries = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS sales FROM sales_entries
      WHERE project_id = ? AND archived_at IS NULL AND status != 'void'`,
  )
    .bind(projectId)
    .first<{ sales: number }>();

  const sales = Number(sums?.sales ?? 0) + Number(entries?.sales ?? 0);
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
  return `${Number.isInteger(n) ? n.toFixed(0) : String(n)}%`;
}
