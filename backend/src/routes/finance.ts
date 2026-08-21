import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { activeCompanyId } from "../scm/lib/companyScope";
import { financeHiddenForUser } from "../services/pmsAccess";

/**
 * Server-side finance gate (Sales-department visibility, rules 2/3/7). These
 * cross-module P&L endpoints aggregate company revenue / cost / gross profit
 * (incl. project_finance_lines cost). requirePermission("projects.read") alone
 * would expose them to any positioned Sales user who can read projects, so we
 * layer the same stable-org gate the project finance/ledger endpoints use
 * (pmsAccess.financeHiddenForUser — DIRECTOR-level only; un-migrated users
 * without a position keep legacy access). Keeps the wire consistent with the
 * denyFinance() checks in routes/projects.ts.
 */
function denyFinance(c: any): Response | null {
  if (financeHiddenForUser(c.get("user"))) {
    return c.json({ error: "You don't have permission to view financial information." }, 403);
  }
  return null;
}

/**
 * Cross-module P&L aggregation.
 *
 * Cash-basis Gross Profit. Source ownership:
 *   • Revenue — sales_orders.local_total by doc_date
 *   • Cost    — project_finance_lines.amount (kind='cost') by occurred_at
 *             + assr_cases.po_amount by completion_date
 *             + purchase_order_docs.local_ex_tax by doc_date
 *
 * Exhibition sales are booked through AutoCount, so project sales
 * reports are deliberately NOT summed here — they'd double-count the
 * same revenue. Cancelled POs are excluded.
 *
 * Supports three granularities:
 *   • yearly   — 5-year bar (current year + 4 prior)
 *   • monthly  — 12 months of the selected year (default)
 *   • weekly   — ~52 weeks of the selected year
 *
 * Bucketing happens in JS so the SQL stays simple (no SQLite week
 * arithmetic) and granularities don't fork the query path.
 */

const app = new Hono<{ Bindings: Env }>();

type Scope = "all" | "sales" | "projects" | "service" | "po";
type Granularity = "yearly" | "monthly" | "weekly";

interface Bucket {
  key: string;            // "2024" | "2024-03" | "2024-W12"
  label: string;          // "2024" | "Jan" | "W12"
  start: string;          // ISO YYYY-MM-DD
  endExclusive: string;   // ISO YYYY-MM-DD
  revenue: number;
  cost: number;
  gross: number;
  by_source: {
    sales_revenue: number;
    project_cost: number;
    service_cost: number;
    po_cost: number;
  };
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function newBucket(key: string, label: string, start: string, endExclusive: string): Bucket {
  return {
    key,
    label,
    start,
    endExclusive,
    revenue: 0,
    cost: 0,
    gross: 0,
    by_source: { sales_revenue: 0, project_cost: 0, service_cost: 0, po_cost: 0 },
  };
}

function emptyBuckets(granularity: Granularity, anchorYear: number): Bucket[] {
  if (granularity === "yearly") {
    const N = 5;
    const out: Bucket[] = [];
    for (let y = anchorYear - N + 1; y <= anchorYear; y++) {
      out.push(newBucket(String(y), String(y), `${y}-01-01`, `${y + 1}-01-01`));
    }
    return out;
  }
  if (granularity === "monthly") {
    const out: Bucket[] = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      const nm = m === 12 ? 1 : m + 1;
      const ny = m === 12 ? anchorYear + 1 : anchorYear;
      out.push(
        newBucket(
          `${anchorYear}-${mm}`,
          MONTH_LABELS[m - 1],
          `${anchorYear}-${mm}-01`,
          `${ny}-${String(nm).padStart(2, "0")}-01`
        )
      );
    }
    return out;
  }
  // weekly — 7-day chunks starting from Jan 1, last bucket may be partial.
  const out: Bucket[] = [];
  const yearStart = new Date(Date.UTC(anchorYear, 0, 1));
  const yearEnd = new Date(Date.UTC(anchorYear + 1, 0, 1));
  let cur = new Date(yearStart);
  let idx = 1;
  while (cur < yearEnd) {
    const nxt = new Date(cur);
    nxt.setUTCDate(cur.getUTCDate() + 7);
    const end = nxt < yearEnd ? nxt : yearEnd;
    out.push(
      newBucket(
        `${anchorYear}-W${String(idx).padStart(2, "0")}`,
        `W${idx}`,
        cur.toISOString().slice(0, 10),
        end.toISOString().slice(0, 10)
      )
    );
    cur = nxt;
    idx++;
  }
  return out;
}

function placeRow(
  buckets: Bucket[],
  date: string | null | undefined,
  amount: number | null | undefined,
  key: keyof Bucket["by_source"]
): void {
  if (!date || amount == null) return;
  // Date strings are YYYY-MM-DD or longer; lexicographic compare works.
  // Bucket array is in ascending order so a linear scan is fine for
  // 5-53 buckets.
  for (const b of buckets) {
    if (date >= b.start && date < b.endExclusive) {
      b.by_source[key] += amount;
      return;
    }
  }
}

// ── Source pulls (raw date+amount tuples within an overall range) ──

// Multi-company (Phase 0b): the P&L is a per-company financial view (design:
// financial/order data is scoped to the active company). sales_orders +
// purchase_order_docs carry company_id (mig 0061), so the revenue + PO-cost
// pulls filter by the active company. assr_cases (service cost) is a
// CROSS-company module and project_finance_lines has no company_id, so both stay
// unscoped. `companyId` is undefined pre-migration / cold-start → predicate is
// omitted → single-company Houzs is unchanged.
async function rawSales(env: Env, start: string, end: string, companyId?: number) {
  const rows = await env.DB.prepare(
    `SELECT doc_date AS d, COALESCE(local_total, 0) AS a
       FROM sales_orders
      WHERE doc_date IS NOT NULL AND doc_date >= ? AND doc_date < ?
        ${companyId != null ? "AND company_id = ?" : ""}`
  )
    .bind(start, end, ...(companyId != null ? [companyId] : []))
    .all<{ d: string; a: number }>();
  return rows.results ?? [];
}

// Owner audit 2026-07-22: costs were UNSCOPED while sales was scoped, so
// caller in A saw A revenue minus (A+B) costs — distorted P&L. Migration
// 0170 added project_finance_lines.company_id + backfill; assr_cases already
// carried company_id from mig 0083 (route just wasn't filtering). Both cost
// pulls now scope on the active company, matching rawSales' predicate shape:
// `companyId === undefined` (pre-migration / cold-start) omits the filter so
// single-company Houzs stays unchanged.
// Archiving a project does NOT archive its finance lines, so summing the ledger
// without joining projects counts cost from projects that were deliberately
// removed. Measured 2026-07-29: RM 6,290,856 of the RM 69,251,852 this reported
// belonged to archived projects — the six duplicate FAIR PNL seeds among them.
/* ── ONE predicate per source, shared by the total and by its drill-down ──────
 *
 * A P&L bucket and the row list you get by clicking it are two different
 * queries over the same source. When the predicate is re-typed in each, they
 * drift, and the drift is INVISIBLE: the total is right, the list is longer,
 * and nothing in the response says which one to believe. That is exactly what
 * happened here — `bucketDrilldown`'s project-cost and service-cost queries
 * carried NEITHER the company filter nor the archived-project join that their
 * own totals apply, so clicking a Houzs cost bucket listed 2990's cost lines
 * and the archived FAIR PNL seeds alongside them (the RM 6,290,856 named in the
 * comment below).
 *
 * So the predicate now exists ONCE per source and both callers interpolate the
 * same string with the same binds. A future filter added here cannot reach the
 * total and miss the list. Text fragments rather than a query builder because
 * `env.DB.prepare` takes SQL text, and the two callers differ only in their
 * SELECT list and ORDER BY.
 *
 * `companyId === undefined` (pre-migration / cold-start) omits the filter, which
 * is the same three-state degrade `rawSales` has always used so single-company
 * Houzs is unchanged. */
/* THE COMPANY OF A COST LINE IS ITS PROJECT'S, not the line's copy of it.
 * (report-money audit, 2026-08-21.)
 *
 * `project_finance_lines.company_id` is a DENORMALISED copy added by mig 0170.
 * Two writers never fill it: `services/projectCostRates.ts` stamps it on INSERT
 * only, so an auto row created before 0170 keeps NULL through every later
 * UPDATE; and the historical FAIR PNL ledger seeds were written without it.
 * `l.company_id = ?` therefore DROPS those rows from a company-scoped P&L —
 * silently, because a missing row cannot announce itself.
 *
 * Measured against production 2026-08-21 (run 32465233085,
 * `backend/scripts/check-report-money.mjs`): 85 live cost lines on unarchived
 * projects carry NULL — 79 manual (RM 1,327,267.94) + 6 auto (RM 126,069.00) =
 * RM 1,453,336.94 — while `/api/projects/analytics/profitability` and
 * `/api/projects/finance/by-project`, which both scope on `p.company_id`,
 * counted every one of them. The same money, two reports, RM 1.45M apart.
 *
 * Reading the project is not a widening: the same run found ZERO lines whose
 * own company_id disagrees with their project's, so the row set changes by
 * exactly the NULLs it was losing. The `projects` join is already here for
 * `archived_at`. The column stays — it is provenance, and other callers may
 * use it — it just stops being a second home for this answer. */
const projectCostFrom = (companyId?: number) =>
  `FROM project_finance_lines l
       JOIN projects p ON p.id = l.project_id AND p.archived_at IS NULL
      WHERE l.kind = 'cost' AND l.archived_at IS NULL
        AND COALESCE(l.occurred_at, l.created_at) >= ?
        AND COALESCE(l.occurred_at, l.created_at) < ?
        ${companyId != null ? "AND p.company_id = ?" : ""}`;

const serviceCostFrom = (companyId?: number, alias = "", join = "") => {
  const p = alias ? `${alias}.` : "";
  return `FROM assr_cases${alias ? ` ${alias}` : ""}
         ${join}
        WHERE ${p}po_amount IS NOT NULL AND ${p}archived_at IS NULL
          AND COALESCE(${p}completion_date, ${p}updated_at) >= ?
          AND COALESCE(${p}completion_date, ${p}updated_at) < ?
          ${companyId != null ? `AND ${p}company_id = ?` : ""}`;
};

/** The binds every fragment above expects, in order. */
const costBinds = (start: string, end: string, companyId?: number) =>
  [start, end, ...(companyId != null ? [companyId] : [])] as const;

/* Exported for backend/tests/reviewHighFindings.test.ts: the invariant under test
   is that a bucket TOTAL and its drill-down apply the same predicate, and that is
   only checkable by driving both. */
export async function rawProjectCost(env: Env, start: string, end: string, companyId?: number) {
  const rows = await env.DB.prepare(
    `SELECT COALESCE(l.occurred_at, l.created_at) AS d, COALESCE(l.amount, 0) AS a
       ${projectCostFrom(companyId)}`
  )
    .bind(...costBinds(start, end, companyId))
    .all<{ d: string; a: number }>();
  return rows.results ?? [];
}

export async function rawServiceCost(env: Env, start: string, end: string, companyId?: number) {
  const rows = await env.DB.prepare(
    `SELECT COALESCE(completion_date, updated_at) AS d, COALESCE(po_amount, 0) AS a
       ${serviceCostFrom(companyId)}`
  )
    .bind(...costBinds(start, end, companyId))
    .all<{ d: string; a: number }>();
  return rows.results ?? [];
}

async function rawPoCost(env: Env, start: string, end: string, companyId?: number) {
  const rows = await env.DB.prepare(
    `SELECT doc_date AS d, COALESCE(local_ex_tax, 0) AS a
       FROM purchase_order_docs
      WHERE local_ex_tax IS NOT NULL AND COALESCE(cancelled, 0) = 0
        AND doc_date IS NOT NULL AND doc_date >= ? AND doc_date < ?
        ${companyId != null ? "AND company_id = ?" : ""}`
  )
    .bind(start, end, ...(companyId != null ? [companyId] : []))
    .all<{ d: string; a: number }>();
  return rows.results ?? [];
}

// ── GET /api/finance/pnl ──
//
// Query params:
//   • year=YYYY                — anchor year (default: current UTC year)
//   • scope=all|sales|projects|service|po (default: all)
//   • granularity=yearly|monthly|weekly (default: monthly)

app.get("/pnl", requirePermission("projects.read"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const scope = (c.req.query("scope") || "all") as Scope;
  if (!["all", "sales", "projects", "service", "po"].includes(scope)) {
    return c.json({ error: "invalid scope" }, 400);
  }
  const granularity = (c.req.query("granularity") || "monthly") as Granularity;
  if (!["yearly", "monthly", "weekly"].includes(granularity)) {
    return c.json({ error: "invalid granularity" }, 400);
  }
  const yearParam = c.req.query("year");
  const anchorYear = yearParam ? parseInt(yearParam, 10) : new Date().getUTCFullYear();
  if (!Number.isInteger(anchorYear) || anchorYear < 2000 || anchorYear > 2100) {
    return c.json({ error: "invalid year" }, 400);
  }

  const companyId = activeCompanyId(c);
  const buckets = emptyBuckets(granularity, anchorYear);
  const overallStart = buckets[0].start;
  const overallEnd = buckets[buckets.length - 1].endExclusive;

  const [salesRows, projectRows, serviceRows, poRows] = await Promise.all([
    scope === "all" || scope === "sales"
      ? rawSales(c.env, overallStart, overallEnd, companyId)
      : Promise.resolve([]),
    scope === "all" || scope === "projects"
      ? rawProjectCost(c.env, overallStart, overallEnd, companyId)
      : Promise.resolve([]),
    scope === "all" || scope === "service"
      ? rawServiceCost(c.env, overallStart, overallEnd, companyId)
      : Promise.resolve([]),
    scope === "all" || scope === "po"
      ? rawPoCost(c.env, overallStart, overallEnd, companyId)
      : Promise.resolve([]),
  ]);

  for (const r of salesRows) placeRow(buckets, r.d, r.a, "sales_revenue");
  for (const r of projectRows) placeRow(buckets, r.d, r.a, "project_cost");
  for (const r of serviceRows) placeRow(buckets, r.d, r.a, "service_cost");
  for (const r of poRows) placeRow(buckets, r.d, r.a, "po_cost");

  for (const b of buckets) {
    b.revenue = b.by_source.sales_revenue;
    b.cost = b.by_source.project_cost + b.by_source.service_cost + b.by_source.po_cost;
    b.gross = b.revenue - b.cost;
  }

  const totals = buckets.reduce(
    (acc, b) => {
      acc.revenue += b.revenue;
      acc.cost += b.cost;
      acc.gross += b.gross;
      acc.by_source.sales_revenue += b.by_source.sales_revenue;
      acc.by_source.project_cost += b.by_source.project_cost;
      acc.by_source.service_cost += b.by_source.service_cost;
      acc.by_source.po_cost += b.by_source.po_cost;
      return acc;
    },
    {
      revenue: 0,
      cost: 0,
      gross: 0,
      by_source: { sales_revenue: 0, project_cost: 0, service_cost: 0, po_cost: 0 },
    }
  );
  const margin_pct = totals.revenue > 0 ? (totals.gross / totals.revenue) * 100 : null;

  let poMissingPriceCount = 0;
  if (scope === "all" || scope === "po") {
    const r = await c.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM purchase_order_docs
        WHERE local_ex_tax IS NULL
          AND COALESCE(cancelled, 0) = 0
          AND doc_date IS NOT NULL
          AND doc_date >= ? AND doc_date < ?
          ${companyId != null ? "AND company_id = ?" : ""}`
    )
      .bind(overallStart, overallEnd, ...(companyId != null ? [companyId] : []))
      .first<{ c: number }>();
    poMissingPriceCount = r?.c ?? 0;
  }

  return c.json({
    year: anchorYear,
    granularity,
    scope,
    buckets,
    // Backwards-compat alias for older clients that read `months`.
    months: buckets.map((b) => ({ ...b, month: b.key })),
    totals: { ...totals, margin_pct },
    notes: {
      excludes: ["operating_expenses"],
      basis: "cash",
      po_missing_price_count: poMissingPriceCount,
    },
  });
});

// ── GET /api/finance/pnl/bucket?start=YYYY-MM-DD&end=YYYY-MM-DD ──
// Drill-down: returns the contributing rows for a single bucket
// (whatever granularity).

export async function bucketDrilldown(env: Env, start: string, end: string, companyId?: number) {
  const [sales, projectLines, cases, poLines] = await Promise.all([
    env.DB.prepare(
      `SELECT doc_no, debtor_name, doc_date, local_total, sales_agent, region
         FROM sales_orders
        WHERE doc_date IS NOT NULL
          AND doc_date >= ? AND doc_date < ?
          ${companyId != null ? "AND company_id = ?" : ""}
        ORDER BY doc_date DESC, id DESC
        LIMIT 500`
    )
      .bind(start, end, ...(companyId != null ? [companyId] : []))
      .all(),
    env.DB.prepare(
      `SELECT l.id, l.project_id, l.category, l.description, l.amount,
              COALESCE(l.occurred_at, l.created_at) AS anchor_date,
              p.code AS project_code, p.name AS project_name
         ${projectCostFrom(companyId)}
        ORDER BY anchor_date DESC, l.id DESC
        LIMIT 500`
    )
      .bind(...costBinds(start, end, companyId))
      .all(),
    env.DB.prepare(
      `SELECT c.id, c.assr_no, c.customer_name, c.po_amount,
              COALESCE(c.completion_date, c.updated_at) AS anchor_date,
              cr.company_name AS supplier_name
         ${serviceCostFrom(companyId, "c", "LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code")}
        ORDER BY anchor_date DESC, c.id DESC
        LIMIT 500`
    )
      .bind(...costBinds(start, end, companyId))
      .all(),
    env.DB.prepare(
      `SELECT doc_no, '' AS item_code, ref AS item_description, creditor_name,
              doc_date AS anchor_date, NULL AS remaining_qty, NULL AS unit_price,
              local_ex_tax AS amount, amount_source,
              CASE WHEN COALESCE(doc_status,'') != 'C' THEN 1 ELSE 0 END AS is_outstanding
         FROM purchase_order_docs
        WHERE local_ex_tax IS NOT NULL
          AND COALESCE(cancelled, 0) = 0
          AND doc_date IS NOT NULL
          AND doc_date >= ? AND doc_date < ?
          ${companyId != null ? "AND company_id = ?" : ""}
        ORDER BY doc_date DESC, doc_no DESC
        LIMIT 500`
    )
      .bind(start, end, ...(companyId != null ? [companyId] : []))
      .all(),
  ]);

  return {
    sales: sales.results ?? [],
    project_cost_lines: projectLines.results ?? [],
    service_cases: cases.results ?? [],
    po_lines: poLines.results ?? [],
  };
}

app.get("/pnl/bucket", requirePermission("projects.read"), async (c) => {
  const denied = denyFinance(c); if (denied) return denied;
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!start || !end) return c.json({ error: "start and end required" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return c.json({ error: "dates must be YYYY-MM-DD" }, 400);
  }
  const data = await bucketDrilldown(c.env, start, end, activeCompanyId(c));
  return c.json({ start, end, ...data });
});

export default app;
