import { PnlCalendar, QueryClientProvider, queryClient } from "autocount-sync-frontend";

// PnlCalendar is a CONNECTED component: it queries /api/finance/pnl itself
// (via the app's TanStack-backed useQuery) and renders 12 month cards of
// cash-basis gross profit. This preview stubs the network layer with a full
// year of realistic 2025 numbers, keyed off the scope/year/granularity
// params the component actually requests, and wraps each story in the
// bundle's own QueryClientProvider + queryClient (single-instance rule).

// Monthly revenue/cost (RM) — aircon + furniture retail, seasonal Q4 lift.
const MONTHS: Array<[string, number, number]> = [
  ["Jan", 268400, 171800],
  ["Feb", 189200, 128700],
  ["Mar", 312750, 196000],
  ["Apr", 295600, 189200],
  ["May", 402100, 249300],
  ["Jun", 358900, 226100],
  ["Jul", 288400, 184600],
  ["Aug", 316200, 199200],
  ["Sep", 274800, 178600],
  ["Oct", 391500, 242700],
  ["Nov", 428900, 261600],
  ["Dec", 512300, 307400],
];

function buckets(year: number, scope: string) {
  return MONTHS.map(([label, rev, cost], i) => {
    const mm = String(i + 1).padStart(2, "0");
    const next = i === 11 ? `${year + 1}-01-01` : `${year}-${String(i + 2).padStart(2, "0")}-01`;
    const revenue = scope === "all" || scope === "sales" ? rev : 0;
    const c = scope === "all" || scope === "projects" || scope === "service" || scope === "po"
      ? scope === "projects" ? Math.round(cost * 0.4)
      : scope === "service" ? Math.round(cost * 0.1)
      : scope === "po" ? Math.round(cost * 0.5)
      : cost
      : 0;
    return {
      key: `${year}-${mm}`,
      label,
      start: `${year}-${mm}-01`,
      endExclusive: next,
      revenue,
      cost: c,
      gross: revenue - c,
      by_source: {
        sales_revenue: revenue,
        project_cost: Math.round(c * 0.4),
        service_cost: Math.round(c * 0.1),
        po_cost: Math.round(c * 0.5),
      },
    };
  });
}

function pnlResponse(year: number, scope: string, granularity: string) {
  const bs = buckets(year, scope);
  const revenue = bs.reduce((s, b) => s + b.revenue, 0);
  const cost = bs.reduce((s, b) => s + b.cost, 0);
  return {
    year,
    granularity,
    scope,
    buckets: bs,
    totals: {
      revenue,
      cost,
      gross: revenue - cost,
      margin_pct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null,
      by_source: {
        sales_revenue: revenue,
        project_cost: Math.round(cost * 0.4),
        service_cost: Math.round(cost * 0.1),
        po_cost: Math.round(cost * 0.5),
      },
    },
    notes: { excludes: ["opex"], basis: "cash", po_missing_price_count: 2 },
  };
}

// Drill-down payload for a clicked month card.
const BUCKET_DETAIL = {
  start: "2025-05-01",
  end: "2025-06-01",
  sales: [
    {
      doc_no: "SO-2990-0417",
      debtor_name: "Tan Wei Ming",
      doc_date: "2025-05-02",
      local_total: 6180,
      sales_agent: "Farra",
      region: "Klang Valley",
    },
    {
      doc_no: "SO-2990-0421",
      debtor_name: "Lim & Sons Trading",
      doc_date: "2025-05-12",
      local_total: 2990,
      sales_agent: "Kumar",
      region: "Penang",
    },
  ],
  project_cost_lines: [
    {
      id: 1,
      project_id: 4,
      project_code: "PRJ-014",
      project_name: "Bandar Puteri Showroom Fit-out",
      category: "Materials",
      description: "Ducting + insulation",
      amount: 18400,
      anchor_date: "2025-05-18",
    },
  ],
  service_cases: [
    {
      id: 231,
      assr_no: "ASSR-0231",
      customer_name: "Nurul Aina",
      po_amount: 480,
      anchor_date: "2025-05-21",
      supplier_name: "Panasonic Malaysia",
    },
  ],
  po_lines: [
    {
      doc_no: "PO-2990-0088",
      item_code: "PNA-25INV",
      item_description: "Panasonic 2.5HP Inverter",
      creditor_name: "Panasonic Malaysia",
      anchor_date: "2025-05-06",
      remaining_qty: 0,
      unit_price: 2340,
      amount: 46800,
      amount_source: null,
    },
  ],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/finance/pnl/bucket")) return json(BUCKET_DETAIL);
  if (url.includes("/api/finance/pnl")) {
    const params = new URLSearchParams(url.split("?")[1] ?? "");
    const year = Number(params.get("year") || "2025");
    const scope = params.get("scope") || "all";
    const granularity = params.get("granularity") || "monthly";
    return json(pnlResponse(year, scope, granularity));
  }
  // Unstubbed API paths must NOT fall through: the DS bundle's baseUrl points
  // at the real workers.dev API, and a genuine 401 there fires the global
  // logout listener — wiping the preview auth token mid-render.
  if (url.includes("/api/"))
    return new Response(JSON.stringify({ error: "not stubbed in preview" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  return realFetch(input as RequestInfo, init);
};

export const AllSources = () => (
  <QueryClientProvider client={queryClient}>
    <div className="w-[48rem]">
      <PnlCalendar scope="all" title="Profit & Loss" subtitle="Cash-basis gross profit across all modules" defaultYear={2025} />
    </div>
  </QueryClientProvider>
);

export const SalesRevenueOnly = () => (
  <QueryClientProvider client={queryClient}>
    <div className="w-[48rem]">
      <PnlCalendar scope="sales" title="Sales Revenue" defaultYear={2025} />
    </div>
  </QueryClientProvider>
);

export const ProjectCostCompact = () => (
  <QueryClientProvider client={queryClient}>
    <div className="w-[42rem]">
      <PnlCalendar scope="projects" title="Project Cost" defaultYear={2025} compact />
    </div>
  </QueryClientProvider>
);
