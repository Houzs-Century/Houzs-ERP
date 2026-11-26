
export interface ProfitabilityBreakdown {
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

export type ProfitabilityGroupBy = "brand" | "event_type" | "organizer" | "venue" | "month";

export interface ProfitabilityFilters {
  date_from?: string;
  date_to?: string;
  brand?: string;
  organizer?: string;
  event_type_id?: string;
  scope?: string;
}

export interface ProfitabilityDrillState {
  dim: ProfitabilityGroupBy | null;
  value: string | null;
  month: string | null;
  toggleValue: (dim: ProfitabilityGroupBy, key: string) => void;
  toggleMonth: (key: string) => void;
}

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
    title: "Project Overview",
    description:
      "Sales, COGS, rental, gross and net profit for the period — then by brand, event type, organizer and venue.",
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
