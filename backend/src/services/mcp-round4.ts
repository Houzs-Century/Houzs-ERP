import { pagedRows } from "./mcp-faq";
import { BAD_PERIOD, PERIOD_SCHEMA, resolvePeriod, type Period, type Range } from "./mcp-period";
import { myToday, shiftMonths } from "./mcp-quick";
import {
  reportMonths,
  summariseAwaitingReceipt,
  summariseCompanyReport,
  summariseCustomer,
  summariseInventory,
  summariseOutletPeriod,
  summarisePosPeriod,
  summariseServiceCases,
  summariseSla,
  summariseStock,
  summariseUninvoiced,
} from "./mcp-round4-shape";
import type { R3Ctx, R3Outcome, R3Read } from "./mcp-round3";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const answer = (v: unknown, target: string): R3Outcome => ({ result: text(JSON.stringify(v)), status: 200, note: "", target });
const bad = (msg: string, target: string): R3Outcome => ({ result: text(msg, true), status: 400, note: "", target });
const denied = (r: R3Read & { ok: false }) => r.status === 401 || r.status === 403;
const refused = (r: R3Read & { ok: false }, target: string, what: string): R3Outcome => ({
  result: text(denied(r) ? `You don't have access to ${what} in the ERP.` : r.message, true),
  status: r.status,
  note: r.note,
  target,
});
const missing = (r: R3Read & { ok: false }, what: string): string => (denied(r) ? `You don't have access to ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} could not be read just now.`);
const queryArg = (args: Obj): string => str(args.query).slice(0, 80);

const readOnly = { readOnlyHint: true, openWorldHint: false };
const COMPANY = { type: "string", description: "Which company's data, as for the other tools: HOUZS (default) or 2990 (the 2990's book)" };
const noArgs = { type: "object", properties: { company: COMPANY }, additionalProperties: false };
const periodArgs = { type: "object", properties: { ...PERIOD_SCHEMA, company: COMPANY }, additionalProperties: false };
const queryArgs = (what: string) => ({ type: "object", properties: { query: { type: "string", description: what }, company: COMPANY }, required: ["query"], additionalProperties: false });

export const ROUND4_TOOLS = [
  { name: "stock_check", title: "Do we have stock? (quick answer)", description: "One product by code or name: on hand by warehouse and showroom, consignment held, reserved for orders (with / without delivery date), available, and incoming purchase orders with ETA. Same numbers as the Inventory screen.", inputSchema: queryArgs("Item code, product name or barcode"), annotations: readOnly },
  { name: "inventory_summary", title: "Short, negative and slow-moving stock (quick answer)", description: "Stock problems in ONE call: items where orders exceed stock + incoming (short), items below zero, and slow-moving stock with no sale in 90 days (selling locations only).", inputSchema: noArgs, annotations: readOnly },
  { name: "uninvoiced_deliveries", title: "Delivered but not invoiced (quick answer)", description: "Delivery orders that left the warehouse and were never invoiced: total, by age, by salesperson and customer, oldest first. min_age_days skips the normal billing lag. Finance (outstanding) access.", inputSchema: { type: "object", properties: { min_age_days: { type: "number", description: "Only deliveries at least this many days old (e.g. 31)" }, company: COMPANY }, additionalProperties: false }, annotations: readOnly },
  { name: "po_awaiting_receipt", title: "POs still being received (quick answer)", description: "Purchase orders partly received or still waiting for their first goods receipt: qty remaining, supplier date, days late, and per receiving warehouse / outlet / showroom. Pass company 2990 for the 2990's.", inputSchema: noArgs, annotations: readOnly },
  { name: "customer_overview", title: "Customer overview (quick answer)", description: "One customer by name, phone or code: recent sales orders, outstanding balance, open service cases, last delivery and last contact in the ERP.", inputSchema: queryArgs("Customer name, phone number or debtor code"), annotations: readOnly },
  { name: "after_sales_sla", title: "Service cases past their deadline (quick answer)", description: "Open after-sales cases past their SLA deadline, by stage and priority, the most overdue with days late, and cases stuck more than 3 days in a stage.", inputSchema: noArgs, annotations: readOnly },
  { name: "service_cases", title: "Service cases in a period and what they are about (quick answer)", description: "After-sales / service cases reported in a period: count vs the previous period, by category, outlet and stage, and the latest cases with a line on what each is about, status and age.", inputSchema: periodArgs, annotations: readOnly },
  {
    name: "company_report",
    title: "Company management report (quick answer)",
    description: "The management report for a month, quarter or year vs the period before: P&L from the books (sales, cost of sales, gross profit, net profit), sales orders by outlet, receivables and payables aging, and after-sales. Each section only if your role may read it (the P&L needs finance access). company 2990 = the 2990's book.",
    inputSchema: { type: "object", properties: { period: { type: "string", description: "month (default, to date) | last_month | quarter | year, or YYYY-MM / YYYY-Qn / YYYY" }, company: COMPANY }, additionalProperties: false },
    annotations: readOnly,
  },
];
export const ROUND4_TOOL_NAMES = new Set(ROUND4_TOOLS.map((t) => t.name));

/** outlet_sales / pos_sales take a period (round 4, H10); their definitions stay in mcp-round3.ts. */
export const PERIOD_TOOL_SCHEMA = periodArgs;

export const ROUND4_INSTRUCTIONS = `- Stock of one item ("do we have stock?"): stock_check {query}. Short / negative / slow stock: inventory_summary. Delivered not invoiced: uninvoiced_deliveries. POs still being received (by outlet / warehouse): po_awaiting_receipt.
- One customer: customer_overview {query}. Service cases past deadline: after_sales_sla. Service cases in a period and what they are about: service_cases {period}.
- Management report for a month / quarter / year: company_report {period}. Every period-type tool takes period = today | week | month | last_month | quarter | year | custom (+ from, to) and compares with the previous period. For the 2990's pass company "2990".`;


async function stockCheck(ctx: R3Ctx, args: Obj): Promise<R3Outcome> {
  const q = queryArg(args);
  const target = `stock:${q}`;
  if (q.length < 2) return bad("Give an item code or product name (at least 2 characters).", target);
  const [products, warehouses] = await Promise.all([ctx.read("/api/scm/inventory/products", { search: q }), ctx.read("/api/scm/inventory/warehouses", undefined)]);
  if (!products.ok) return refused(products, target, "inventory");
  return answer(summariseStock(products.value, warehouses.ok ? warehouses.value : null, q, ctx.origin), target);
}

async function inventorySummary(ctx: R3Ctx): Promise<R3Outcome> {
  const target = `inventory:${myToday(new Date(ctx.now))}`;
  const [products, analytics] = await Promise.all([ctx.read("/api/scm/inventory/products", undefined), ctx.read("/api/scm/inventory/analytics", { days: 90 })]);
  if (!products.ok) return refused(products, target, "inventory");
  const out = summariseInventory(products.value, analytics.ok ? analytics.value : null, ctx.origin);
  return answer({ ...out, ...(!analytics.ok ? { notAvailable: [missing(analytics, "the inventory analytics (slow-moving stock)")] } : {}) }, target);
}

async function uninvoiced(ctx: R3Ctx, args: Obj): Promise<R3Outcome> {
  const minAge = Math.max(0, Math.min(3650, Math.trunc(num(args.min_age_days))));
  const target = `uninvoiced:${myToday(new Date(ctx.now))}${minAge ? `:>=${minAge}d` : ""}`;
  const r = await ctx.read("/api/scm/unbilled-deliveries", minAge ? { minAgeDays: minAge } : undefined);
  if (!r.ok) return refused(r, target, "unbilled deliveries");
  return answer(summariseUninvoiced(r.value, ctx.origin), target);
}

async function awaitingReceipt(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `po-awaiting:${today}`;
  const got = await pagedRows(ctx, "/api/scm/mfg-purchase-orders", "purchaseOrders", { status: "outstanding", sort: "po_date:asc" }, 10);
  if (!got.ok) return refused(got.r, target, "purchase orders");
  return answer(summariseAwaitingReceipt(got.rows, today, ctx.origin, got.truncated), target);
}

async function customerOverview(ctx: R3Ctx, args: Obj): Promise<R3Outcome> {
  const q = queryArg(args);
  const target = `customer:${q}`;
  if (q.length < 3) return bad("Give a customer name, phone number or code (at least 3 characters).", target);
  const [sos, cases, dos] = await Promise.all([
    ctx.read("/api/scm/mfg-sales-orders", { q, page: 0, pageSize: 50, sort: "so_date:desc" }),
    ctx.read("/api/assr", { search: q, per_page: 50 }),
    ctx.read("/api/scm/delivery-orders-mfg", { q, page: 0, pageSize: 20, sort: "do_date:desc" }),
  ]);
  if (!sos.ok && !cases.ok) return refused(sos, target, "sales orders or service cases");
  const notAvailable = [...(!sos.ok ? [missing(sos, "sales orders")] : []), ...(!cases.ok ? [missing(cases, "service cases")] : []), ...(!dos.ok ? [missing(dos, "delivery orders")] : [])];
  const out = summariseCustomer(q, sos.ok ? arr(obj(sos.value).salesOrders) : [], cases.ok ? arr(obj(cases.value).data) : [], dos.ok ? arr(obj(dos.value).deliveryOrders) : [], ctx.origin, myToday(new Date(ctx.now)));
  return answer({ ...out, ...(notAvailable.length ? { notAvailable } : {}) }, target);
}

async function afterSalesSla(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `assr-sla:${today}`;
  const [summary, breached, stuck] = await Promise.all([
    ctx.read("/api/assr/summary", undefined),
    ctx.read("/api/assr/metrics/drill", { metric: "breach_now", limit: 500 }),
    ctx.read("/api/assr/metrics/drill", { metric: "aging", limit: 500 }),
  ]);
  if (!breached.ok) return refused(breached, target, "service cases");
  return answer(summariseSla(summary.ok ? summary.value : null, breached.value, stuck.ok ? stuck.value : null, today, ctx.origin), target);
}

const CASE_PAGE = 200;

async function serviceCases(ctx: R3Ctx, p: Period): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `service-cases:${p.from}..${p.to}`;
  const page = (n: number, r: Range, size: number) => ctx.read("/api/assr", { from: r.from, to: r.to, per_page: size, page: n });
  const [first, prev] = await Promise.all([page(1, p, CASE_PAGE), page(1, p.prev, 1)]);
  if (!first.ok) return refused(first, target, "service cases");
  const total = num(obj(first.value).total);
  const rows = arr(obj(first.value).data);
  if (total > CASE_PAGE) {
    const more = await Promise.all([2, 3].filter((n) => (n - 1) * CASE_PAGE < total).map((n) => page(n, p, CASE_PAGE)));
    for (const r of more) if (r.ok) rows.push(...arr(obj(r.value).data));
  }
  return answer(summariseServiceCases(rows, total, prev.ok ? num(obj(prev.value).total) : null, p, today, ctx.origin), target);
}

/** H10: outlet sales for any period, vs the previous period and the same days last month. */
export async function outletSalesPeriod(ctx: R3Ctx, p: Period): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `outlets:${p.from}..${p.to}`;
  const fair = (r: Range) => ctx.read("/api/scm/reports/fair-report", { stage: "so", date_from: r.from, date_to: r.to });
  const [cur, prev, lm] = await Promise.all([fair(p), fair(p.prev), fair(p.lastMonth)]);
  if (!cur.ok) return refused(cur, target, "the Sales Report");
  return answer(summariseOutletPeriod(cur.value, prev.ok ? prev.value : null, lm.ok ? lm.value : null, p, today), target);
}

export const POS_EVENTS_COMPARED = 3;

/** Booth events active in the window: on going, or ended on / after its first day, started by its last; on going first. */
export function eventsInWindow(events: unknown, r: Range): { projectId: number; name: string; status: string }[] {
  return arr(obj(events).data)
    .map((e) => ({ projectId: num(e.project_id), name: str(e.name) || str(e.code), status: str(e.status), start: str(e.start_date).slice(0, 10), end: str(e.end_date).slice(0, 10) }))
    .filter((e) => e.projectId > 0 && (e.status === "ON GOING" || e.status === "DONE") && (!e.start || e.start <= r.to) && (e.status === "ON GOING" || (e.end || e.start) >= r.from))
    .sort((a, b) => (a.status === b.status ? b.start.localeCompare(a.start) : a.status === "ON GOING" ? -1 : 1))
    .map(({ projectId, name, status }) => ({ projectId, name, status }));
}

/** H10: booth POS for any period; each event read for the window and once over the comparison days (split by day). */
export async function posSalesPeriod(ctx: R3Ctx, p: Period): Promise<R3Outcome> {
  const target = `pos:${p.from}..${p.to}`;
  const ev = await ctx.read("/api/pos-admin/events", undefined);
  if (!ev.ok) return refused(ev, target, "POS Admin");
  const all = eventsInWindow(ev.value, { from: p.from < p.lastMonth.from ? p.from : p.lastMonth.from, to: p.to });
  const events = all.slice(0, POS_EVENTS_COMPARED);
  const cmpFrom = p.prev.from < p.lastMonth.from ? p.prev.from : p.lastMonth.from;
  const cmpTo = p.prev.to > p.lastMonth.to ? p.prev.to : p.lastMonth.to;
  const reads = await Promise.all(
    events.map((e) => Promise.all([ctx.read("/api/pos-admin/report", { project_id: e.projectId, from: p.from, to: p.to }), ctx.read("/api/pos-admin/report", { project_id: e.projectId, from: cmpFrom, to: cmpTo })])),
  );
  const shaped: { name: string; status: string; current: unknown; compare: unknown | null }[] = [];
  const unreadable: string[] = [];
  reads.forEach(([cur, cmp], i) => {
    if (cur.ok) shaped.push({ name: events[i].name, status: events[i].status, current: cur.value, compare: cmp.ok ? cmp.value : null });
    else unreadable.push(events[i].name);
  });
  return answer(summarisePosPeriod(shaped, unreadable, all.length, p), target);
}

const lastDayOf = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

async function companyReport(ctx: R3Ctx, args: Obj): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const span = reportMonths(str(args.period), today);
  const target = `company-report:${str(args.period) || "month"}:${today}`;
  if (!span) return bad("Give period as month, last_month, quarter or year, or YYYY-MM / YYYY-Qn / YYYY (not in the future).", target);
  const curFrom = `${span.months[0]}-01`;
  const curEnd = lastDayOf(span.months.at(-1)!);
  const curTo = curEnd < today ? curEnd : today;
  const prevFrom = `${span.prevMonths[0]}-01`;
  const monthsBack = (Number(span.months[0].slice(0, 4)) * 12 + Number(span.months[0].slice(5, 7))) - (Number(span.prevMonths[0].slice(0, 4)) * 12 + Number(span.prevMonths[0].slice(5, 7)));
  const prevTo = curEnd < today ? lastDayOf(span.prevMonths.at(-1)!) : shiftMonths(today, monthsBack);
  const [dash, salesCur, salesPrev, ar, ap, cases] = await Promise.all([
    ctx.read("/api/scm/accounting/dashboard", { granularity: "month", from: span.prevMonths[0], to: span.months.at(-1) }),
    ctx.read("/api/scm/reports/fair-report", { stage: "so", date_from: curFrom, date_to: curTo }),
    ctx.read("/api/scm/reports/fair-report", { stage: "so", date_from: prevFrom, date_to: prevTo }),
    ctx.read("/api/scm/accounting/ar-aging", { buckets: "day", basis: "invoice", asOf: today }),
    ctx.read("/api/scm/accounting/ap-aging", { buckets: "day", basis: "invoice", asOf: today }),
    ctx.read("/api/assr/summary", undefined),
  ]);
  const parts = [
    [dash, "the financial statements (P&L)"],
    [salesCur, "the Sales Report"],
    [ar, "the debtor (AR) aging"],
    [ap, "the creditor (AP) aging"],
    [cases, "service cases"],
  ] as const;
  const notAvailable = parts.filter(([r]) => !r.ok).map(([r, what]) => missing(r as R3Read & { ok: false }, what));
  if (notAvailable.length === parts.length) return refused(dash as R3Read & { ok: false }, target, "any of the company reports");
  return answer(
    {
      window: { from: curFrom, to: curTo, previous: { from: prevFrom, to: prevTo } },
      ...summariseCompanyReport({
        label: span.label,
        months: span.months,
        prevMonths: span.prevMonths,
        dashboard: dash.ok ? dash.value : null,
        salesCur: salesCur.ok ? salesCur.value : null,
        salesPrev: salesCur.ok && salesPrev.ok ? salesPrev.value : null,
        ar: ar.ok ? ar.value : null,
        ap: ap.ok ? ap.value : null,
        cases: cases.ok ? cases.value : null,
        notAvailable,
        today,
      }),
    },
    target,
  );
}

function withPeriod(ctx: R3Ctx, args: Obj, name: string, run: (p: Period) => Promise<R3Outcome>): Promise<R3Outcome> {
  const p = resolvePeriod(args, myToday(new Date(ctx.now)));
  return p ? run(p) : Promise.resolve(bad(BAD_PERIOD, `${name}:bad period`));
}

/** Run one round-4 tool (or outlet_sales / pos_sales, now period-aware); null = not ours. */
export function runRound4Tool(ctx: R3Ctx, name: string, args: Obj): Promise<R3Outcome> | null {
  switch (name) {
    case "stock_check":
      return stockCheck(ctx, args);
    case "inventory_summary":
      return inventorySummary(ctx);
    case "uninvoiced_deliveries":
      return uninvoiced(ctx, args);
    case "po_awaiting_receipt":
      return awaitingReceipt(ctx);
    case "customer_overview":
      return customerOverview(ctx, args);
    case "after_sales_sla":
      return afterSalesSla(ctx);
    case "service_cases":
      return withPeriod(ctx, args, name, (p) => serviceCases(ctx, p));
    case "outlet_sales":
      return withPeriod(ctx, args, name, (p) => outletSalesPeriod(ctx, p));
    case "pos_sales":
      return withPeriod(ctx, args, name, (p) => posSalesPeriod(ctx, p));
    case "company_report":
      return companyReport(ctx, args);
    default:
      return null;
  }
}
