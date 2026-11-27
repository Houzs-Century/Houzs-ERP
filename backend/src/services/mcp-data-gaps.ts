import { myToday, rm } from "./mcp-quick";
import { pagedRows, SO_OPEN_TABS } from "./mcp-faq";
import type { R3Ctx, R3Outcome, R3Read } from "./mcp-round3";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const enc = encodeURIComponent;

/** How many example rows each data-gap section lists. */
export const GAP_TOP = 5;
/** Pages of 100 read per open sales-order tab (5 tabs). */
export const GAP_SO_PAGES = 5;

export type GapSection = { title: string; count: number; valueRm?: number; top: Obj[]; url: string; note?: string; cut?: string };
export type GapRead = { ok: true; value: unknown } | { ok: false; status: number; message: string };

const denied = (r: GapRead): boolean => !r.ok && (r.status === 401 || r.status === 403);
const missing = (r: GapRead, what: string): string => (denied(r) ? `You don't have access to ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} could not be read just now.`);

/** Supplier payments, advances and credit notes not yet knocked off a bill (the AP aging's unapplied column). */
export function gapUnappliedPayments(apAging: unknown, origin: string): GapSection {
  const b = obj(apAging);
  const rows = arr(b.rows).filter((r) => num(r.unappliedSen) !== 0);
  const items = rows.reduce((n, r) => n + arr(r.unapplied).length, 0);
  rows.sort((x, y) => num(x.unappliedSen) - num(y.unappliedSen));
  return {
    title: "Supplier payments not matched to a bill",
    count: items,
    valueRm: Math.abs(rm(obj(b.totals).unappliedSen)),
    note: "Payments, advances and credit notes on the creditor aging that are not knocked off any supplier bill yet. Match them to the bill in Accounting.",
    top: rows.slice(0, GAP_TOP).map((r) => ({ supplier: str(r.name), unappliedRm: Math.abs(rm(r.unappliedSen)), documents: arr(r.unapplied).length })),
    url: `${origin}/scm/accounting?tab=ap`,
  };
}

/** Open sales orders (confirmed / in production / ready to ship, not held) with no customer delivery date. */
export function gapSoNoDeliveryDate(rows: readonly Obj[], origin: string, truncated: boolean): GapSection {
  const gaps = rows.filter((o) => !o.on_hold && !str(o.customer_delivery_date)).sort((a, b) => str(a.so_date).localeCompare(str(b.so_date)));
  return {
    title: "Open sales orders with no delivery date",
    count: gaps.length,
    top: gaps.slice(0, GAP_TOP).map((o) => ({ so: str(o.doc_no), customer: str(o.debtor_name), soDate: str(o.so_date).slice(0, 10) || null, status: str(o.status), url: `${origin}/scm/sales-orders/${enc(str(o.doc_no))}` })),
    url: `${origin}/scm/sales-orders`,
    ...(truncated ? { cut: `Some status tabs have more than ${GAP_SO_PAGES * 100} open orders; the first ${GAP_SO_PAGES * 100} of each are checked.` } : {}),
  };
}

const priced = (p: Obj): boolean => num(p.sell_price_sen) > 0 || num(p.price1_sen) > 0 || num(p.base_price_sen) > 0;

/** Active products (SKU Master) with no supplier cost, no selling price on any tier, or no category. */
export function gapProducts(products: unknown, origin: string): { noCost: GapSection; noPrice: GapSection; noCategory: GapSection } {
  const rows = arr(obj(products).products).filter((p) => str(p.category).toUpperCase() !== "SERVICE");
  const line = (p: Obj) => ({ item: str(p.code), name: str(p.name), category: str(p.category) || null, url: `${origin}/scm/products` });
  const anchored = rows.some((p) => "costAnchorState" in p);
  const noCost = anchored ? rows.filter((p) => str(p.costAnchorState) === "empty") : [];
  const noPrice = rows.filter((p) => !priced(p));
  const noCategory = rows.filter((p) => !str(p.category));
  const url = `${origin}/scm/products`;
  return {
    noCost: {
      title: "Products with no supplier cost",
      count: noCost.length,
      top: noCost.slice(0, GAP_TOP).map(line),
      url,
      note: anchored ? "No supplier binding carries a cost for the item (the SKU Master's cost marker)." : "The SKU Master did not return cost markers for this login.",
    },
    noPrice: { title: "Products with no selling price", count: noPrice.length, top: noPrice.slice(0, GAP_TOP).map(line), url, note: "Selling price, Price 1 and Price 2 all empty." },
    noCategory: { title: "Products with no category", count: noCategory.length, top: noCategory.slice(0, GAP_TOP).map(line), url },
  };
}

/** Customers (from their sales orders, as on the Customers screen) with no phone number. */
export function gapCustomersNoPhone(body: unknown, origin: string): GapSection {
  const rows = arr(obj(body).customers);
  const gaps = rows.filter((c) => !str(c.phone));
  return {
    title: "Customers with no phone number",
    count: gaps.length,
    note: `${gaps.length} of ${rows.length} customers on sales orders you can see.`,
    top: gaps.slice(0, GAP_TOP).map((c) => ({ customer: str(c.name), orders: num(c.order_count), lastOrder: str(c.last_order_at).slice(0, 10) || null, url: `${origin}/scm/sales-orders?q=${enc(str(c.name))}` })),
    url: `${origin}/scm/sales-orders`,
  };
}

export type GapInputs = { apAging: GapRead; salesOrders: { ok: true; rows: Obj[]; truncated: boolean } | { ok: false; r: GapRead }; products: GapRead; customers: GapRead };

/** The data-gaps list: every section the person may read, gaps first; what they cannot read is a plain line. */
export function buildDataGaps(inp: GapInputs, today: string, origin: string) {
  const sections: GapSection[] = [];
  const notAvailable: string[] = [];
  if (inp.apAging.ok) sections.push(gapUnappliedPayments(inp.apAging.value, origin));
  else notAvailable.push(missing(inp.apAging, "the creditor (AP) aging"));
  if (inp.salesOrders.ok) sections.push(gapSoNoDeliveryDate(inp.salesOrders.rows, origin, inp.salesOrders.truncated));
  else notAvailable.push(missing(inp.salesOrders.r, "sales orders"));
  if (inp.products.ok) {
    const p = gapProducts(inp.products.value, origin);
    sections.push(p.noCost, p.noPrice, p.noCategory);
  } else notAvailable.push(missing(inp.products, "the product list"));
  if (inp.customers.ok) sections.push(gapCustomersNoPhone(inp.customers.value, origin));
  else notAvailable.push(missing(inp.customers, "customers"));
  const open = sections.filter((s) => s.count > 0);
  return {
    today,
    note: "Records missing something the ERP needs. Only what this person can see. Each section: the count and the first 5, with the ERP link.",
    gaps: open,
    clean: sections.filter((s) => s.count === 0).map((s) => s.title),
    ...(notAvailable.length ? { notAvailable } : {}),
  };
}

const asGap = (r: R3Read): GapRead => (r.ok ? { ok: true, value: r.value } : { ok: false, status: r.status, message: r.message });

async function openSalesOrderRows(ctx: R3Ctx): Promise<GapInputs["salesOrders"]> {
  const tabs = await Promise.all(SO_OPEN_TABS.map((t) => pagedRows(ctx, "/api/scm/mfg-sales-orders", "salesOrders", { status: t, sort: "so_date:asc" }, GAP_SO_PAGES)));
  const rows: Obj[] = [];
  let truncated = false;
  for (const t of tabs) {
    if (!t.ok) return { ok: false, r: asGap(t.r) };
    rows.push(...t.rows);
    truncated = truncated || t.truncated;
  }
  return { ok: true, rows, truncated };
}

export const DATA_GAPS_TOOL = {
  name: "data_gaps",
  title: "Records with missing data (quick answer)",
  description:
    "What is incomplete in the ERP, in ONE call: supplier payments not matched to a bill (unapplied, RM), open sales orders with no delivery date, products with no supplier cost / no selling price / no category, and customers with no phone. Each with a count and the first 5 with links. Only what the person may see.",
  inputSchema: { type: "object", properties: { company: { type: "string", description: "Which company's data, as for the other tools: HOUZS (default) or 2990" } }, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const DATA_GAPS_INSTRUCTIONS = "- Incomplete records (unapplied supplier payments, SOs without a delivery date, products without cost / price / category, customers without a phone): data_gaps.";

/** data_gaps: four reads as the person (AP aging, open SO tabs, the SKU Master with cost markers, the SO customers list). */
export async function dataGaps(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `data-gaps:${today}`;
  const [apAging, salesOrders, products, customers] = await Promise.all([
    ctx.read("/api/scm/accounting/ap-aging", { buckets: "day", basis: "invoice", asOf: today }),
    openSalesOrderRows(ctx),
    ctx.read("/api/scm/mfg-products", { anchorState: 1 }),
    ctx.read("/api/scm/mfg-sales-orders/customers", undefined),
  ]);
  const out = buildDataGaps({ apAging: asGap(apAging), salesOrders, products: asGap(products), customers: asGap(customers) }, today, ctx.origin);
  return { result: { content: [{ type: "text", text: JSON.stringify(out) }] }, status: 200, note: "", target };
}
