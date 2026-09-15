// ── Profitability / analytics ────────────────────────────────
// Aggregate view across every project. Four cuts (brand / state /
// event type / month) plus the biggest and smallest events by
// profit. All data served by /api/projects/analytics/profitability
// which reads from the finance rollup (already synced by the
// ledger write path).

export interface ProfitabilityBreakdown {
  key: string;
  count: number;
  income: number;
  // Owner P&L model: Revenue − COGS = GP; GP − Cost = NP. `cost` is the
  // NON-COGS cost (rental, setup, transport, commission, merchandise,
  // others); `cogs` is the goods cost; `profit` is Net Profit. `rental` is
  // the rental slice of `cost`, pulled out so it shows as its own column.
  cogs: number;
  cost: number;
  rental: number;
  gp: number;
  profit: number;
  margin: number | null;
}

// The dimension a breakdown groups on — drives the drill-down queries.
export type ProfitabilityGroupBy = "brand" | "event_type" | "organizer" | "venue" | "month";

// Filters currently active on the dashboard, forwarded to every drill query so
// a drill always reflects the same scope as the group table it opened from.
export interface ProfitabilityFilters {
  date_from?: string;
  date_to?: string;
  brand?: string;
  organizer?: string;
  event_type_id?: string;
  // Lifecycle scope — must be forwarded to the drill so a drilled level totals
  // the same population as the card it was opened from.
  scope?: string;
}

// The open drill path, held in the URL (see ProjectsAnalyticsView): which
// dimension card is expanded (dim), to which value (value), and — for the four
// real dimensions — which month under it (month). Only one path is open at a
// time so the URL stays a single shareable drill.
export interface ProfitabilityDrillState {
  dim: ProfitabilityGroupBy | null;
  value: string | null;
  month: string | null;
  toggleValue: (dim: ProfitabilityGroupBy, key: string) => void;
  toggleMonth: (key: string) => void;
}

// Layer 2 (dimension cards): one finance month inside a dimension value. Same
// P&L columns as the group row; `key` is the YYYY-MM bucket.
interface ProfitabilityDrillMonth {
  key: string;
  count: number;
  income: number;
  cogs: number;
  cost: number;
  rental: number;
  gp: number;
  profit: number;
  margin: number | null;
}

export interface ProfitabilityMonthsResponse {
  level: "months";
  dimension: ProfitabilityGroupBy;
  value: string;
  months: ProfitabilityDrillMonth[];
}

// Layer 3: one project inside a month (or, for the By-Month card, inside the
// clicked month). Same P&L columns plus identity so the row can navigate to
// the project page (Layer 4).
interface ProfitabilityProjectRow {
  id: number;
  code: string;
  name: string;
  brand: string | null;
  organizer: string | null;
  venue: string | null;
  start_date: string | null;
  event_type_name: string | null;
  income: number;
  cogs: number;
  cost: number;
  rental: number;
  gp: number;
  profit: number;
  margin: number | null;
}

export interface ProfitabilityProjectsResponse {
  level: "projects";
  dimension: ProfitabilityGroupBy;
  value: string;
  month: string | null;
  projects: ProfitabilityProjectRow[];
}

export interface ProfitabilityResponse {
  filters: {
    date_from: string | null;
    date_to: string | null;
    brand: string | null;
    event_type_id: string | null;
    organizer: string | null;
    scope: string;
  };
  totals: {
    projects: number;
    income: number;
    cogs: number;
    cost: number;
    rental: number;
    gp: number;
    profit: number;
    margin_pct: number | null;
  };
  by_brand: ProfitabilityBreakdown[];
  by_organizer: ProfitabilityBreakdown[];
  by_event_type: ProfitabilityBreakdown[];
  by_venue: ProfitabilityBreakdown[];
  by_month: ProfitabilityBreakdown[];
  top: Array<{
    id: number;
    code: string;
    name: string;
    brand: string | null;
    venue: string | null;
    start_date: string | null;
    income: number;
    cogs: number;
    cost: number;
    rental: number;
    gp: number;
    profit: number;
    margin: number | null;
  }>;
  bottom: ProfitabilityResponse["top"];
}

// Finances view — tabbed: List (raw ledger lines) / Analytics
// (per-project profitability) / P&L (monthly trend).
export type FinanceTab = "list" | "analytics" | "pnl";
export const FINANCE_TABS: FinanceTab[] = ["list", "analytics", "pnl"];

export const FINANCE_TAB_HEADER: Record<
  FinanceTab,
  { title: string; description: string }
> = {
  list: {
    title: "Finance Lines",
    description:
      "Every income and cost line across every project. Filter by date, brand, kind, category — or search.",
  },
  analytics: {
    title: "Profitability",
    description:
      "Revenue, COGS, gross profit, cost and net profit per project — sliced by brand, venue, type, and month.",
  },
  pnl: {
    title: "P&L Calendar",
    description:
      "Total project cost (COGS + other cost lines) across all projects, grouped by month.",
  },
};

export const PROJECTS_FINANCES_TAB_KEYS = ["tab"] as const;

export interface FinanceProjectRow {
  id: number;
  code: string;
  name: string;
  brand: string | null;
  stage: string;
  start_date: string | null;
  end_date: string | null;
  size_sqm: number | null;
  venue: string | null;
  organizer: string | null;
  income: number;
  sales: number;
  cost: number;
  cogs: number;
  rental: number;
  setup_cost: number;
  transport_cost: number;
  commission_cost: number;
  merchandise_cost: number;
  others_cost: number;
  net: number;
  net_profit: number;
  margin_pct: number | null;
  gp_pct: number | null;
  sales_per_day: number | null;
  rent_per_sqm: number | null;
  line_count: number;
}

export interface FinanceByProjectResponse {
  data: FinanceProjectRow[];
  page: number;
  per_page: number;
  total: number;
  totals: {
    income: number;
    sales: number;
    cost: number;
    cogs: number;
    rental: number;
    net: number;
    net_profit: number;
  };
}

export const FINANCE_STAGE_OPTIONS = [
  "draft",
  "setup",
  "live",
  "dismantle",
  "completed",
] as const;
