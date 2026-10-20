// Project Overview's arithmetic (owner, 2026-10-17: "project 的数据都没有接起来").
// Per project: the books keyed on it when they exist, otherwise the Sales
// Orders opened at it — sales from their amount, COGS from their cost — and a
// note of which, so an event that is not settled yet still shows what it sold.
// Rental and the other costs only come from the keyed books.

export interface OvProject {
  id: number; code: string; name: string; brand: string | null; organizer: string | null; venue: string | null;
  state: string | null; stage: string | null; startDate: string | null; endDate: string | null; eventType: string | null;
  keyed: {
    income: number; cogs: number; rental: number; commission: number; setup: number; transport: number; merchandise: number; other: number;
    /** The same lines as fine as the Financial Snapshot (owner 2026-10-19). */
    cogsMattSofa: number; cogsBedframe: number; cogsAccessories: number; transportFee: number; transportSetup: number;
  };
  /** costSplit: the orders' line cost by product group, only for an event with no COGS keyed. */
  salesOrders: { sen: number; costSen: number; count: number; costSplit: { mattSofa: number; bedframe: number; accessories: number } };
  /** The event's chat sales report against its Sales Orders; null = no report saved. */
  chatReport: { bills: number; billsSen: number; opened: number; openedSen: number; otherEvent: number } | null;
  /** The event page's P&L (backend services/eventPnl.ts), By Sales Orders when an
   *  order was opened, in RM; null when the server could not build it. */
  pnl: OvPnl | null;
  /** The orders' total (drafts in) and what the payment ledger says was paid, in sen. */
  collection: { totalSen: number; paidSen: number };
}

export interface OvPnl {
  fromOrders: boolean;
  sales: number; serviceRevenue: number;
  cogs: { mattSofa: number; bedframe: number; accessories: number; other: number };
  rental: number; setup: number; transportSetup: number; others: number;
  transportFee: number; commission: number; merchandise: number;
}

export type SalesSource = "keyed" | "sales_orders" | "none";

export interface Figures {
  sales: number; cogs: number; rental: number; commission: number; setup: number; transport: number; merchandise: number; other: number;
  otherCost: number; gp: number; np: number; salesSource: SalesSource; cogsFromSalesOrders: boolean;
  /** The orders' service charges, beside Sales. */
  serviceRevenue: number;
  cogsLines: { mattSofa: number; bedframe: number; accessories: number; other: number };
  transportFee: number; transportSetup: number;
}

/** One project's figures, in ringgit: the event page's P&L when the server sent
 *  it (owner 2026-10-20: the costs follow the orders opened), else the keyed
 *  lines and the orders' totals. */
export function figuresOf(p: OvProject): Figures {
  const e = p.pnl;
  if (e) {
    const cogs = e.cogs.mattSofa + e.cogs.bedframe + e.cogs.accessories + e.cogs.other;
    const transport = e.transportFee + e.transportSetup;
    const otherCost = e.setup + transport + e.commission + e.merchandise + e.others;
    return {
      sales: e.sales, cogs, rental: e.rental, commission: e.commission, setup: e.setup, transport, merchandise: e.merchandise, other: e.others,
      otherCost, gp: e.sales - cogs, np: e.sales + e.serviceRevenue - cogs - e.rental - otherCost,
      salesSource: e.fromOrders ? "sales_orders" : e.sales > 0 ? "keyed" : "none", cogsFromSalesOrders: e.fromOrders,
      serviceRevenue: e.serviceRevenue, cogsLines: e.cogs, transportFee: e.transportFee, transportSetup: e.transportSetup,
    };
  }
  const k = p.keyed;
  const salesSource: SalesSource = k.income > 0 ? "keyed" : p.salesOrders.sen > 0 ? "sales_orders" : "none";
  const sales = salesSource === "keyed" ? k.income : p.salesOrders.sen / 100;
  const cogsFromSalesOrders = !(k.cogs > 0) && p.salesOrders.costSen > 0 && sales > 0;
  const cogs = cogsFromSalesOrders ? p.salesOrders.costSen / 100 : k.cogs;
  const otherCost = k.commission + k.setup + k.transport + k.merchandise + k.other;
  const gp = sales - cogs;
  const sp = p.salesOrders.costSplit;
  const cogsLines = cogsFromSalesOrders
    ? { mattSofa: sp.mattSofa / 100, bedframe: sp.bedframe / 100, accessories: sp.accessories / 100, other: cogs - (sp.mattSofa + sp.bedframe + sp.accessories) / 100 }
    : { mattSofa: k.cogsMattSofa, bedframe: k.cogsBedframe, accessories: k.cogsAccessories, other: 0 };
  return { sales, cogs, rental: k.rental, commission: k.commission, setup: k.setup, transport: k.transport, merchandise: k.merchandise, other: k.other, otherCost, gp, np: gp - k.rental - otherCost, salesSource, cogsFromSalesOrders,
    serviceRevenue: 0, cogsLines, transportFee: k.transportFee, transportSetup: k.transportSetup };
}

export interface Totals {
  projects: number; sales: number; cogs: number; rental: number; commission: number; setup: number; transport: number; merchandise: number; other: number; otherCost: number; gp: number; np: number; fromSalesOrders: number; noSales: number;
  /** COGS split as keyed, or for an event with none keyed, its Sales Orders' cost by product group;
   *  cogsFromSo = the part of that cost no line accounts for (order total above its lines). */
  cogsMattSofa: number; cogsBedframe: number; cogsAccessories: number; cogsFromSo: number; transportFee: number; transportSetup: number;
  serviceRevenue: number;
}

export function totalsOf(ps: OvProject[]): Totals {
  const t: Totals = { projects: ps.length, sales: 0, cogs: 0, rental: 0, commission: 0, setup: 0, transport: 0, merchandise: 0, other: 0, otherCost: 0, gp: 0, np: 0, fromSalesOrders: 0, noSales: 0,
    cogsMattSofa: 0, cogsBedframe: 0, cogsAccessories: 0, cogsFromSo: 0, transportFee: 0, transportSetup: 0, serviceRevenue: 0 };
  for (const p of ps) {
    const f = figuresOf(p);
    t.sales += f.sales; t.cogs += f.cogs; t.rental += f.rental; t.commission += f.commission; t.setup += f.setup;
    t.transport += f.transport; t.merchandise += f.merchandise; t.other += f.other; t.otherCost += f.otherCost; t.gp += f.gp; t.np += f.np;
    t.cogsMattSofa += f.cogsLines.mattSofa; t.cogsBedframe += f.cogsLines.bedframe; t.cogsAccessories += f.cogsLines.accessories; t.cogsFromSo += f.cogsLines.other;
    t.transportFee += f.transportFee; t.transportSetup += f.transportSetup; t.serviceRevenue += f.serviceRevenue;
    if (f.salesSource === "sales_orders") t.fromSalesOrders += 1;
    if (f.salesSource === "none") t.noSales += 1;
  }
  return t;
}

export const pctOf = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** Projects grouped by a field, largest sales first. */
export function groupBy(ps: OvProject[], keyOf: (p: OvProject) => string | null) {
  const map = new Map<string, OvProject[]>();
  for (const p of ps) { const k = keyOf(p) || "—"; map.set(k, [...(map.get(k) ?? []), p]); }
  return [...map.entries()].map(([key, xs]) => ({ key, ...totalsOf(xs) })).sort((a, b) => b.sales - a.sales);
}

export type Grain = "month" | "quarter" | "year";

/** The trailing trend ending at `to`: 12 months, 8 quarters or 5 years, by event start date. */
export function trendOf(ps: OvProject[], to: string, grain: Grain) {
  const y = Number(to.slice(0, 4)); const m = Number(to.slice(5, 7));
  const buckets: Array<{ key: string; label: string; from: string; to: string }> = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (grain === "month") {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1)); const yy = d.getUTCFullYear(); const mm = d.getUTCMonth() + 1;
      buckets.push({ key: `${yy}-${pad(mm)}`, label: `${String(yy).slice(2)}/${pad(mm)}`, from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${pad(last(yy, mm))}` });
    }
  } else if (grain === "quarter") {
    const q = Math.ceil(m / 3);
    for (let i = 7; i >= 0; i--) {
      const qi = q - i; const yy = y + Math.floor((qi - 1) / 4); const qq = (((qi - 1) % 4) + 4) % 4 + 1; const m1 = (qq - 1) * 3 + 1;
      buckets.push({ key: `${yy}-Q${qq}`, label: `Q${qq} ${String(yy).slice(2)}`, from: `${yy}-${pad(m1)}-01`, to: `${yy}-${pad(m1 + 2)}-${pad(last(yy, m1 + 2))}` });
    }
  } else {
    for (let i = 4; i >= 0; i--) buckets.push({ key: String(y - i), label: String(y - i), from: `${y - i}-01-01`, to: `${y - i}-12-31` });
  }
  return buckets.map((b) => {
    const xs = ps.filter((p) => !!p.startDate && p.startDate >= b.from && p.startDate <= b.to);
    return { ...b, ...totalsOf(xs) };
  });
}

/** The trend's drill level (owner 2026-10-17): every year, a year's quarters,
 *  a quarter's months, a month's weeks (1–7, 8–14, 15–21, 22–end). */
export type Drill = { level: "years" } | { level: "quarters"; year: number } | { level: "yearMonths"; year: number } | { level: "months"; year: number; quarter: number } | { level: "weeks"; month: string };

export function drillOf(ps: OvProject[], drill: Drill, today: string) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const buckets: Array<{ key: string; label: string; from: string; to: string; next: Drill | null }> = [];
  if (drill.level === "years") {
    const years = ps.map((p) => Number((p.startDate ?? "").slice(0, 4))).filter((y) => y > 2000);
    const y1 = Number(today.slice(0, 4)); const y0 = Math.max(y1 - 6, Math.min(y1, ...years));
    for (let y = y0; y <= y1; y++) buckets.push({ key: String(y), label: String(y), from: `${y}-01-01`, to: `${y}-12-31`, next: { level: "quarters", year: y } });
  } else if (drill.level === "quarters") {
    for (let q = 1; q <= 4; q++) {
      const m1 = (q - 1) * 3 + 1;
      buckets.push({ key: `${drill.year}-Q${q}`, label: `Q${q} ${drill.year}`, from: `${drill.year}-${pad(m1)}-01`, to: `${drill.year}-${pad(m1 + 2)}-${pad(last(drill.year, m1 + 2))}`, next: { level: "months", year: drill.year, quarter: q } });
    }
  } else if (drill.level === "months" || drill.level === "yearMonths") {
    /* A quarter's three months, or all twelve months of a year (the opening view). */
    const first = drill.level === "months" ? (drill.quarter - 1) * 3 + 1 : 1;
    for (let i = 0; i < (drill.level === "months" ? 3 : 12); i++) {
      const mm = first + i; const key = `${drill.year}-${pad(mm)}`;
      buckets.push({ key, label: key, from: `${key}-01`, to: `${key}-${pad(last(drill.year, mm))}`, next: { level: "weeks", month: key } });
    }
  } else {
    const yy = Number(drill.month.slice(0, 4)); const mm = Number(drill.month.slice(5, 7)); const end = last(yy, mm);
    for (const [a, b] of [[1, 7], [8, 14], [15, 21], [22, end]] as Array<[number, number]>) {
      buckets.push({ key: `${drill.month}-${a}`, label: `${pad(mm)}/${pad(a)}–${pad(mm)}/${pad(b)}`, from: `${drill.month}-${pad(a)}`, to: `${drill.month}-${pad(b)}`, next: null });
    }
  }
  return buckets.map((b) => ({ ...b, ...totalsOf(ps.filter((p) => !!p.startDate && p.startDate >= b.from && p.startDate <= b.to)) }));
}
