// ---------------------------------------------------------------------------
// mcp-quick.ts — the AI Connector's quick answers and the search / fetch pair
// (routes/mcp.ts). Owner 2026-11-25: searching through the connector felt slow
// — the AI walked list_modules → list_endpoints → erp_get and then read replies
// of tens of thousands of characters. A quick answer is ONE tool call that
// reads the endpoints the ERP's own pages read, as the person (routes/mcp.ts
// readValue: same permissions, page access and company scope), and returns a
// few hundred characters.
//
// Pure functions over those endpoints' JSON. Money comes in as sen and goes out
// as RM (2 dp).
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const label = (v: unknown, blank: string): string => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
  return s || blank;
};

/** Sen → RM, 2 dp. */
export const rm = (sen: unknown): number => Math.round(num(sen)) / 100;

/** Percent change, 1 dp; null when there is nothing to compare with. */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

// ── dates ────────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^(\d{4})(?:-(\d{2})|-Q([1-4]))?$/;

/** Today in Malaysia (UTC+8) as YYYY-MM-DD. */
export function myToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The same day `n` months earlier, clamped to that month's end (31 Mar − 1 → 28/29 Feb). */
export function shiftMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const idx = y * 12 + (m - 1) - n;
  const py = Math.floor(idx / 12);
  const pm = (idx % 12) + 1;
  return ymd(py, pm, Math.min(d, lastDay(py, pm)));
}

export type Range = { from: string; to: string };
export type Window = Range & { label: string; months: number; prev: Range };

/**
 * The window a question is about, ending today at the latest (the dashboards'
 * rule: "this month" = the 1st to today), and the same days one period earlier
 * for a fair comparison (1–25 Nov → 1–25 Oct; Q4 to date → the same days of Q3).
 * `period` is YYYY-MM, YYYY-Qn or YYYY; `from` + `to` override it; neither =
 * this month. Null when the input cannot be read.
 */
export function resolveWindow(args: { period?: unknown; from?: unknown; to?: unknown }, today: string): Window | null {
  const f = typeof args.from === "string" ? args.from.trim() : "";
  const t = typeof args.to === "string" ? args.to.trim() : "";
  if (f || t) {
    if (!YMD.test(f) || !YMD.test(t) || f > t) return null;
    if ((Date.parse(t) - Date.parse(f)) / 86_400_000 > 400) return null;
    return { from: f, to: t, label: `${f}..${t}`, months: 1, prev: { from: shiftMonths(f, 1), to: shiftMonths(t, 1) } };
  }
  const raw = typeof args.period === "string" && args.period.trim() ? args.period.trim().toUpperCase() : today.slice(0, 7);
  const m = PERIOD.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  let from: string;
  let end: string;
  let months: number;
  if (m[2]) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    from = ymd(y, mo, 1);
    end = ymd(y, mo, lastDay(y, mo));
    months = 1;
  } else if (m[3]) {
    const q = Number(m[3]);
    from = ymd(y, q * 3 - 2, 1);
    end = ymd(y, q * 3, lastDay(y, q * 3));
    months = 3;
  } else {
    from = ymd(y, 1, 1);
    end = ymd(y, 12, 31);
    months = 12;
  }
  if (from > today) return null;
  const to = end < today ? end : today;
  return { from, to, label: raw, months, prev: { from: shiftMonths(from, months), to: shiftMonths(to, months) } };
}

/** The YYYY-MM a window sits in, or null when it spans more than one month. */
export function singleMonth(w: Range): string | null {
  return w.from.slice(0, 7) === w.to.slice(0, 7) ? w.from.slice(0, 7) : null;
}

// ── sales ────────────────────────────────────────────────────────────────────

type Group = { name: string; orders: number; salesRm: number };

function groupBy(rows: Obj[], key: string, blank: string, top: number): Group[] {
  const acc = new Map<string, { orders: number; sen: number }>();
  for (const r of rows) {
    const k = label(r[key], blank);
    const g = acc.get(k) ?? { orders: 0, sen: 0 };
    g.orders += 1;
    g.sen += num(r.amount_sen);
    acc.set(k, g);
  }
  return [...acc.entries()]
    .map(([name, g]) => ({ name, orders: g.orders, salesRm: rm(g.sen) }))
    .sort((a, b) => b.salesRm - a.salesRm || a.name.localeCompare(b.name))
    .slice(0, top);
}

/**
 * Sales answer from the Sales Report's Sales Order stage
 * (GET /api/scm/reports/fair-report?stage=so&date_from&date_to — every order
 * not DRAFT / CANCELLED by SO date, the active company only) for the window and
 * the same days one period earlier, plus top models and the monthly trend from
 * the Sales Analysis (GET /api/scm/sales-analysis?period=YYYY-MM) when given.
 */
export function summariseSales(w: Window, cur: unknown, prev: unknown, analysis: unknown, analysisMonth: string | null) {
  const c = obj(cur);
  const rows = arr(c.rows);
  const s = obj(c.summary);
  const sales = num(s.total_amount_sen);
  const p = obj(prev);
  const ps = obj(p.summary);
  const prevSales = num(ps.total_amount_sen);
  const tender = obj(s.tender_totals);
  const byDay = new Map<string, { orders: number; sen: number }>();
  for (const r of rows) {
    const d = label(r.so_date, "").slice(0, 10);
    if (!d) continue;
    const g = byDay.get(d) ?? { orders: 0, sen: 0 };
    g.orders += 1;
    g.sen += num(r.amount_sen);
    byDay.set(d, g);
  }
  const a = obj(analysis);
  const models = Object.values(obj(obj(a.products).byCategory))
    .flatMap((ms) => arr(ms))
    .sort((x, y) => num(y.revenueSen) - num(x.revenueSen))
    .slice(0, 8)
    .map((x) => ({ model: label(x.modelName, "?"), category: label(x.category, ""), units: num(x.units), salesRm: rm(x.revenueSen) }));
  const monthly = arr(a.monthly).filter((x) => !analysisMonth || String(x.month) <= analysisMonth);
  return {
    from: w.from,
    to: w.to,
    note: "Money in RM. Sales = sales orders that are not draft or cancelled, by SO date (the Sales Report's Sales Order stage). previousPeriod = the same days one period earlier.",
    orders: num(s.orders),
    salesRm: rm(sales),
    productSalesRm: rm(s.total_selling_sen),
    serviceRm: rm(s.total_service_rev_sen),
    ...(typeof s.margin_pct === "number" ? { goodsMarginPct: s.margin_pct } : {}),
    outstandingBalanceRm: rm(s.total_balance_sen),
    ordersBelowDeposit: num(s.below_deposit_count),
    depositsByTenderRm: { cash: rm(tender.Cash), merchant: rm(tender.Merchant), installment: rm(tender.Installment), online: rm(tender.Online) },
    previousPeriod: Object.keys(ps).length
      ? { from: w.prev.from, to: w.prev.to, orders: num(ps.orders), salesRm: rm(prevSales), changePct: pctChange(sales, prevSales) }
      : null,
    byShowroom: groupBy(rows, "venue", "(no showroom)", 10),
    byBrand: groupBy(rows, "branding", "(no brand)", 10),
    bySalesperson: groupBy(rows, "salesperson", "(no salesperson)", 10),
    byState: groupBy(rows, "state", "(no state)", 6),
    daily: [...byDay.entries()].sort().map(([date, g]) => ({ date, orders: g.orders, salesRm: rm(g.sen) })),
    ...(models.length ? { topModels: models } : {}),
    ...(monthly.length
      ? {
          trend: monthly.slice(-6).map((x) => ({ month: String(x.month), orders: num(x.orders), salesRm: rm(x.revenueSen) })),
          trendNote: "topModels and trend come from the Sales Analysis, which counts every order not cancelled or on hold, so they can differ slightly from the totals above.",
        }
      : {}),
  };
}

// ── delivery ─────────────────────────────────────────────────────────────────

/**
 * Delivery answer from the Logistic Overview
 * (GET /api/scm/logistic-overview?from&to — delivery orders LOADED or DELIVERED
 * by DO date, the active company only) for the window and the same days one
 * period earlier.
 */
export function summariseDelivery(w: Window, cur: unknown, prev: unknown) {
  const c = obj(cur);
  const per = obj(c.period);
  const pp = obj(obj(prev).period);
  const amount = num(per.doAmountSen);
  const prevAmount = num(pp.doAmountSen);
  const notClosed = obj(c.doNotClosed);
  const noCost = obj(c.doNoCost);
  const unreleased = obj(c.soNoProcessing);
  const owing = obj(c.deliveredOwing);
  const owing30 = obj(c.deliveredOwingOver30);
  return {
    from: w.from,
    to: w.to,
    note: "Money in RM. Delivered = delivery orders loaded or delivered, by DO date (the Logistic Overview). podClosed = marked delivered with proof of delivery. The process gaps are as of today.",
    deliveryOrders: num(per.doCount),
    amountRm: rm(amount),
    podClosed: num(per.podClosed),
    previousPeriod: Object.keys(pp).length
      ? { from: w.prev.from, to: w.prev.to, deliveryOrders: num(pp.doCount), amountRm: rm(prevAmount), changePct: pctChange(amount, prevAmount) }
      : null,
    byRegion: arr(per.byRegion).map((r) => ({ region: label(r.region, "?"), orders: num(r.orders), amountRm: rm(r.amountSen) })),
    topLorries: arr(per.byLorry)
      .filter((l) => num(l.orders) > 0)
      .sort((x, y) => num(y.amountSen) - num(x.amountSen))
      .slice(0, 6)
      .map((l) => ({ lorry: label(l.lorry, "?"), orders: num(l.orders), amountRm: rm(l.amountSen), occupancyPct: l.occupancyPct == null ? null : num(l.occupancyPct) })),
    daily: arr(per.days)
      .filter((d) => num(d.orders) > 0)
      .map((d) => ({ date: label(d.date, ""), orders: num(d.orders), amountRm: rm(d.amountSen) })),
    gaps: {
      loadedOverAWeekNotClosed: { count: num(notClosed.count), amountRm: rm(notClosed.amountSen) },
      noCostLast90Days: { count: num(noCost.count), amountRm: rm(noCost.amountSen) },
      confirmedNotReleasedOver30Days: { count: num(unreleased.count), oldestDays: num(unreleased.oldestDays) },
      deliveredStillOwing: { count: num(owing.count), balanceRm: rm(owing.balanceSen), oldestDays: num(owing.oldestDays) },
      deliveredOwingOver30Days: { count: num(owing30.count), balanceRm: rm(owing30.balanceSen) },
    },
    trend: arr(c.months)
      .slice(-6)
      .map((m) => ({ month: String(m.month), deliveryOrders: num(m.doCount), amountRm: rm(m.doAmountSen) })),
  };
}

// ── erp_get fields ───────────────────────────────────────────────────────────

/** Keep only the named keys at every object level (rows stay rows). Empty list = unchanged. */
export function pickFields(v: unknown, fields: readonly string[]): unknown {
  if (!fields.length) return v;
  const keep = new Set(fields);
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 20) return x;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
    if (x && typeof x === "object") {
      const out: Obj = {};
      for (const [k, val] of Object.entries(x as Obj)) {
        if (keep.has(k)) out[k] = val;
        else if (val && typeof val === "object") {
          const inner = walk(val, depth + 1);
          if (inner && typeof inner === "object" && Object.keys(inner as Obj).length) out[k] = inner;
        }
      }
      return out;
    }
    return x;
  };
  return walk(v, 0);
}

// ── search / fetch (the shape ChatGPT requires) ─────────────────────────────
// ChatGPT outside Developer Mode only accepts a connector with a `search` and a
// `fetch` tool, and deep research uses only those two: search returns
// {results:[{id,title,url}]}, fetch returns one {id,title,text,url,metadata}.

const enc = encodeURIComponent;

/** Search hit type → the record's detail endpoint and its ERP page (the same pages /api/search links to). */
export const FETCH_KINDS: Record<string, { api: (id: string) => string; page: (id: string) => string }> = {
  sales_order: { api: (id) => `/api/scm/mfg-sales-orders/${enc(id)}`, page: (id) => `/scm/sales-orders/${enc(id)}` },
  purchase_order: { api: (id) => `/api/scm/mfg-purchase-orders/${enc(id)}`, page: (id) => `/scm/purchase-orders/${enc(id)}` },
  grn: { api: (id) => `/api/scm/grns/${enc(id)}`, page: (id) => `/scm/grns/${enc(id)}` },
  delivery_order: { api: (id) => `/api/scm/delivery-orders-mfg/${enc(id)}`, page: (id) => `/scm/delivery-orders/${enc(id)}` },
  sales_invoice: { api: (id) => `/api/scm/sales-invoices/${enc(id)}`, page: (id) => `/scm/sales-invoices/${enc(id)}` },
  purchase_invoice: { api: (id) => `/api/scm/purchase-invoices/${enc(id)}`, page: (id) => `/scm/purchase-invoices/${enc(id)}` },
  supplier: { api: (id) => `/api/scm/suppliers/${enc(id)}`, page: (id) => `/scm/suppliers/${enc(id)}` },
  customer: { api: (id) => `/api/scm/other-debtors/${enc(id)}`, page: (id) => `/scm/other-debtors/${enc(id)}` },
  credit_note: { api: (id) => `/api/scm/credit-notes/${enc(id)}`, page: (id) => `/scm/credit-notes/${enc(id)}` },
  delivery_return: { api: (id) => `/api/scm/delivery-returns/${enc(id)}`, page: (id) => `/scm/delivery-returns/${enc(id)}` },
  payment_voucher: { api: (id) => `/api/scm/payment-vouchers/${enc(id)}`, page: (id) => `/scm/payment-vouchers/${enc(id)}` },
  project: { api: (id) => `/api/projects/${enc(id)}`, page: (id) => `/projects?focus=${enc(id)}` },
  assr_case: { api: (id) => `/api/assr/${enc(id)}`, page: (id) => `/assr?focus=${enc(id)}` },
};

export type SearchResult = { id: string; title: string; url: string; text: string };

/** "sales_order" → "Sales order": the hit type in words, without a second copy of the search vocabulary. */
export const typeWord = (type: string): string => {
  const w = type.replace(/_/g, " ").trim();
  return w ? w[0].toUpperCase() + w.slice(1) : w;
};

/** /api/search's `{hits:[{type,id,title,subtitle,status,link}]}` → ChatGPT results; id = "<type>:<id>". */
export function searchResults(body: unknown, origin: string, max = 20): SearchResult[] {
  const out: SearchResult[] = [];
  for (const h of arr(obj(body).hits)) {
    const type = label(h.type, "");
    const rid = label(h.id, "");
    if (!type || !rid) continue;
    const link = label(h.link, "");
    const text = [label(h.subtitle, ""), label(h.status, ""), label(h.date, "")].filter(Boolean).join(" · ");
    out.push({
      id: `${type}:${rid}`,
      title: `${typeWord(type)}: ${label(h.title, rid)}`,
      url: link.startsWith("/") ? origin + link : origin,
      text,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** The fetch spec for a hit type; own keys only, so "__proto__" / "constructor" are not kinds. */
export function fetchKind(kind: string): { api: (id: string) => string; page: (id: string) => string } | null {
  return Object.prototype.hasOwnProperty.call(FETCH_KINDS, kind) ? FETCH_KINDS[kind] : null;
}

/** "sales_order:HC-SO-013402" → { kind, rowId }; null for anything else. */
export function parseFetchId(raw: unknown): { kind: string; rowId: string } | null {
  const m = /^([a-z_]{2,40}):([A-Za-z0-9._-]{1,80})$/.exec(String(raw ?? "").trim());
  return m ? { kind: m[1], rowId: m[2] } : null;
}

const NUMBER_KEYS = ["doc_no", "docNo", "po_number", "do_number", "grn_number", "invoice_number", "receipt_number", "note_number", "return_number", "voucher_number", "assr_no", "code", "name"];

/** A readable title for a fetched record: its type and document number (one level of nesting searched). */
export function docTitle(kind: string, rowId: string, doc: unknown): string {
  const top = obj(doc);
  const levels = [top, ...Object.values(top).filter((v) => v && typeof v === "object" && !Array.isArray(v)).map(obj)];
  for (const level of levels) {
    for (const k of NUMBER_KEYS) {
      const v = level[k];
      if (typeof v === "string" && v.trim()) return `${typeWord(kind)} ${v.trim()}`;
    }
  }
  return `${typeWord(kind)} ${rowId}`;
}

// ── prompts (ready-made questions shown in the AI app) ──────────────────────

export const PROMPTS = [
  {
    name: "monthly_sales_review",
    title: "Monthly sales review",
    description: "Sales for a month: total vs the same days last month, by showroom, brand and salesperson, top models, notable days.",
    arguments: [
      { name: "period", description: "YYYY-MM (default this month)", required: false },
      { name: "company", description: "Which company (default: your usual one)", required: false },
    ],
  },
  {
    name: "delivery_review",
    title: "Delivery review",
    description: "Deliveries this month against the same days last month, by region and lorry, and the open process gaps.",
    arguments: [{ name: "period", description: "YYYY-MM (default this month)", required: false }],
  },
  {
    name: "find_document",
    title: "Find a document",
    description: "Find a sales order, delivery order, invoice, PO, customer or service case by number or name and summarise it.",
    arguments: [{ name: "number", description: "Document number, customer or supplier name", required: true }],
  },
  {
    name: "daily-brief",
    title: "What do I need to look at today?",
    description: "Your own to-do from the ERP: approvals and mail waiting for you, orders due or overdue, your open service cases, leave to approve, unacknowledged announcements.",
    arguments: [],
  },
];

/** The message a prompt expands to (prompts/get). Unknown name → null. */
export function promptText(name: string, a: Record<string, unknown>): string | null {
  const v = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : "");
  if (name === "monthly_sales_review") {
    const company = v("company") ? ` for company ${v("company")}` : "";
    return `Review our sales for ${v("period") || "this month"}${company} using sales_summary. Give the total against the same days last month (RM and %), the top showrooms, brands and salespeople, the top models, and anything unusual in the daily figures. Keep it short, in plain language.`;
  }
  if (name === "delivery_review") {
    return `Using delivery_summary, review deliveries for ${v("period") || "this month"} against the same days last month: totals, by region and lorry, and the open process gaps (delivery orders not closed, delivered but still owing). Plain language, short.`;
  }
  if (name === "find_document") {
    return `Find "${v("number")}" with search, open the best match with fetch, and summarise it: status, customer or supplier, items, amounts and dates. Give the ERP link.`;
  }
  if (name === "daily-brief") {
    return "What do I need to look at today? Use daily_brief. Start with anything overdue, then what is due in the next 3 days, then approvals and mail waiting for me. Give each item's link. Keep it short, in plain language.";
  }
  return null;
}
