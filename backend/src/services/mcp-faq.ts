// ---------------------------------------------------------------------------
// mcp-faq.ts — the owner's connector FAQ (2026-11-26), one tool call per question
// (docs/modules/ai-connector.md "FAQ"):
//   P1 + P4 po_overdue          open POs past their supplier date / still to be received
//   P2      supplier_lateness   late deliveries per supplier (PO date vs receipt)
//   P3      payables_summary    what we owe suppliers, aged, and due this week
//   S1      so_overdue          open SOs past the customer delivery date
//   S2      deliveries_due      delivery orders + open SOs due today / this week
//   S3      receivables_summary delivered-not-invoiced and invoiced-not-paid (aged)
//
// Every read goes through ctx.read (routes/mcp.ts readValue, as the person, with
// redactMoney), so each answer is exactly what that person sees in the ERP; a
// list they may not open becomes "you don't have access to X". Lists are the
// ERP's own (PO / SO / DO lists, the AP / AR aging, the unbilled-deliveries
// report). Pure shaping functions are exported for the tests.
// ---------------------------------------------------------------------------
import { addDays, poDueDate } from "./mcp-brief";
import { rm, myToday } from "./mcp-quick";
import { daysBetween } from "./mcp-quick2";
import type { R3Ctx, R3Outcome, R3Read } from "./mcp-round3";

type Obj = Record<string, unknown>;
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));
const enc = encodeURIComponent;
const sumRm = (xs: readonly Obj[], k: string): number => rm(xs.reduce((n, x) => n + num(x[k]), 0));
const TOP = 10;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const answer = (v: unknown, target: string): R3Outcome => ({ result: text(JSON.stringify(v)), status: 200, note: "", target });
const refused = (r: R3Read & { ok: false }, target: string, what: string): R3Outcome => ({
  result: text(r.status === 401 || r.status === 403 ? `You don't have access to ${what} in the ERP.` : r.message, true),
  status: r.status,
  note: r.note,
  target,
});

// ── paging a list the ERP serves 100 at a time (page is 0-based) ─────────────

export type Paged = { ok: true; rows: Obj[]; total: number; truncated: boolean } | { ok: false; r: R3Read & { ok: false } };

/**
 * Pages of one list, 4 at a time, up to `maxPages`. `enough(rows)` may stop
 * early (a list sorted by date stops once the last row is past the horizon).
 */
export async function pagedRows(ctx: R3Ctx, path: string, key: string, q: Obj, maxPages: number, enough: ((last: Obj) => boolean) | null = null): Promise<Paged> {
  const rowsOf = (v: unknown): Obj[] => arr(obj(v)[key]);
  const read = (n: number) => ctx.read(path, { ...q, page: n, pageSize: 100 });
  const first = await read(0);
  if (!first.ok) return { ok: false, r: first };
  const rows = rowsOf(first.value);
  const total = num(obj(first.value).total) || rows.length;
  const pages = Math.min(maxPages, Math.ceil(total / 100));
  let stopped = false;
  for (let p = 1; p < pages; p += 4) {
    const last = rows.at(-1);
    if (enough && last && enough(last)) {
      stopped = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded fan-out: 4 in-process page reads at a time
    const got = await Promise.all(Array.from({ length: Math.min(4, pages - p) }, (_, i) => read(p + i)));
    for (const g of got) {
      if (!g.ok) return { ok: false, r: g };
      rows.push(...rowsOf(g.value));
    }
  }
  return { ok: true, rows, total, truncated: !stopped && rows.length < total };
}

// ── P1 + P4: purchase orders overdue / awaiting receipt ─────────────────────

const poLine = (p: Obj, today: string, origin: string) => {
  const date = poDueDate(p);
  return {
    po: str(p.po_number),
    supplier: str(obj(p.supplier).name) || "(no supplier)",
    supplierDate: date || null,
    daysLate: date && date < today ? (daysBetween(date, today) ?? 0) : 0,
    status: str(p.status),
    valueRm: rm(p.total_sen),
    url: `${origin}/scm/purchase-orders/${enc(str(p.id))}`,
  };
};

/** Outstanding POs (submitted / partly received, the PO list's Outstanding tab) → overdue and still to receive. */
export function summarisePoOutstanding(rows: readonly Obj[], today: string, origin: string, truncated: boolean) {
  const open = rows.filter((p) => !p.on_hold);
  const lines = open.map((p) => poLine(p, today, origin));
  const overdue = lines.filter((l) => l.daysLate > 0).sort((a, b) => b.daysLate - a.daysLate);
  const week = addDays(today, 6);
  const dueThisWeek = lines.filter((l) => l.supplierDate && l.supplierDate >= today && l.supplierDate <= week).sort((a, b) => String(a.supplierDate).localeCompare(String(b.supplierDate)));
  const bySupplier = new Map<string, { pos: number; valueRm: number; worstDaysLate: number }>();
  for (const l of overdue) {
    const g = bySupplier.get(l.supplier) ?? { pos: 0, valueRm: 0, worstDaysLate: 0 };
    g.pos += 1;
    g.valueRm = Math.round((g.valueRm + l.valueRm) * 100) / 100;
    g.worstDaysLate = Math.max(g.worstDaysLate, l.daysLate);
    bySupplier.set(l.supplier, g);
  }
  return {
    today,
    note: "Money in RM (the whole PO's value; a partly received PO's remaining value is on its page). Supplier date = the latest of the PO's expected date and the supplier's revised dates. Held POs are left out.",
    awaitingReceipt: { pos: open.length, partlyReceived: open.filter((p) => str(p.status) === "PARTIALLY_RECEIVED").length, valueRm: sumRm(open, "total_sen") },
    overdue: { pos: overdue.length, valueRm: Math.round(overdue.reduce((n, l) => n + l.valueRm * 100, 0)) / 100, top: overdue.slice(0, TOP) },
    dueThisWeek: { pos: dueThisWeek.length, top: dueThisWeek.slice(0, TOP) },
    overdueBySupplier: [...bySupplier.entries()].map(([supplier, g]) => ({ supplier, ...g })).sort((a, b) => b.pos - a.pos || b.valueRm - a.valueRm).slice(0, TOP),
    ...(truncated ? { cut: "More than 1,000 outstanding POs; the figures cover the first 1,000." } : {}),
  };
}

async function poOverdue(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `po-overdue:${today}`;
  const got = await pagedRows(ctx, "/api/scm/mfg-purchase-orders", "purchaseOrders", { status: "outstanding", sort: "po_date:asc" }, 10);
  if (!got.ok) return refused(got.r, target, "purchase orders");
  return answer(summarisePoOutstanding(got.rows, today, ctx.origin, got.truncated), target);
}

// ── P2: supplier lateness ───────────────────────────────────────────────────

/**
 * Received POs in the window (by the day they were fully received) against their
 * ORIGINAL expected date, per supplier; plus each supplier's open POs already
 * past their date. `since` = the window's first day.
 */
export function summariseSupplierLateness(received: readonly Obj[], open: readonly Obj[], since: string, today: string) {
  const acc = new Map<string, { received: number; late: number; daysLate: number; openOverdue: number }>();
  const get = (name: string) => {
    const g = acc.get(name) ?? { received: 0, late: 0, daysLate: 0, openOverdue: 0 };
    acc.set(name, g);
    return g;
  };
  let counted = 0;
  for (const p of received) {
    const got = str(p.received_at).slice(0, 10);
    const promised = str(p.expected_at).slice(0, 10);
    if (!got || got < since || got > today || !promised) continue;
    counted += 1;
    const g = get(str(obj(p.supplier).name) || "(no supplier)");
    g.received += 1;
    const late = daysBetween(promised, got) ?? 0;
    if (late > 0) {
      g.late += 1;
      g.daysLate += late;
    }
  }
  for (const p of open) {
    if (p.on_hold) continue;
    const date = poDueDate(p);
    if (date && date < today) get(str(obj(p.supplier).name) || "(no supplier)").openOverdue += 1;
  }
  const suppliers = [...acc.entries()]
    .map(([supplier, g]) => ({
      supplier,
      receivedPos: g.received,
      lateDeliveries: g.late,
      onTimePct: g.received ? Math.round(((g.received - g.late) / g.received) * 1000) / 10 : null,
      avgDaysLate: g.late ? Math.round((g.daysLate / g.late) * 10) / 10 : 0,
      openPosPastDate: g.openOverdue,
    }))
    .filter((s) => s.lateDeliveries > 0 || s.openPosPastDate > 0)
    .sort((a, b) => b.lateDeliveries + b.openPosPastDate - (a.lateDeliveries + a.openPosPastDate) || b.avgDaysLate - a.avgDaysLate);
  return {
    from: since,
    to: today,
    note: "A delivery counts as late when the PO's received date (received_at, stamped when its last goods arrived) is after its original expected date. avgDaysLate is over the late ones only. openPosPastDate = POs still not received and past the supplier's latest date.",
    receivedPosInWindow: counted,
    lateDeliveries: suppliers.reduce((n, s) => n + s.lateDeliveries, 0),
    suppliers: suppliers.slice(0, 15),
  };
}

async function supplierLateness(ctx: R3Ctx, args: Obj): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const thisMonth = str(args.period) === "this_month";
  const since = thisMonth ? `${today.slice(0, 7)}-01` : addDays(today, -89);
  const target = `supplier-lateness:${since}..${today}`;
  // A PO is ordered before it is received: 120 days of PO dates before the window catch nearly every receipt in it.
  const poFrom = addDays(since, -120);
  const [received, open] = await Promise.all([
    pagedRows(ctx, "/api/scm/mfg-purchase-orders", "purchaseOrders", { status: "received", from: poFrom, to: today, sort: "po_date:desc" }, 20),
    pagedRows(ctx, "/api/scm/mfg-purchase-orders", "purchaseOrders", { status: "outstanding", sort: "po_date:asc" }, 10),
  ]);
  if (!received.ok) return refused(received.r, target, "purchase orders");
  const out = summariseSupplierLateness(received.rows, open.ok ? open.rows : [], since, today);
  return answer({ ...out, ...(received.truncated ? { cut: "More than 2,000 received POs in the window; the first 2,000 are counted." } : {}) }, target);
}

// ── P3 / S3: aging (AP and AR) ──────────────────────────────────────────────

/** The aging's five day columns (0-30, 31-60, 61-90, 91-120, 120+) folded to four: 0-30 / 31-60 / 61-90 / over 90. */
export function foldCells(cells: unknown): { "0-30": number; "31-60": number; "61-90": number; "90+": number } {
  const c = Array.isArray(cells) ? cells.map(num) : [];
  return { "0-30": rm(c[0]), "31-60": rm(c[1]), "61-90": rm(c[2]), "90+": rm((c[3] ?? 0) + (c[4] ?? 0)) };
}

/** GET /api/scm/accounting/{ap,ar}-aging?buckets=day → totals, the biggest parties, what falls due this week and what is past due. */
export function summariseAging(body: unknown, today: string, party: "supplier" | "customer") {
  const b = obj(body);
  const rows = arr(b.rows);
  const week = addDays(today, 6);
  let dueWeekSen = 0;
  let pastDueSen = 0;
  const dueWeek: { party: string; doc: string; dueDate: string; openRm: number }[] = [];
  for (const r of rows) {
    for (const i of arr(r.items)) {
      const due = str(i.dueDate).slice(0, 10);
      const open = num(i.openSen);
      if (!due || open <= 0) continue;
      if (due < today) pastDueSen += open;
      else if (due <= week) {
        dueWeekSen += open;
        dueWeek.push({ party: str(r.name), doc: str(i.docNo), dueDate: due, openRm: rm(open) });
      }
    }
  }
  dueWeek.sort((x, y) => x.dueDate.localeCompare(y.dueDate) || y.openRm - x.openRm);
  return {
    asOf: str(b.asOf) || today,
    totalRm: rm(obj(b.totals).balanceSen),
    aged: foldCells(obj(b.totals).cells),
    pastDueRm: rm(pastDueSen),
    dueThisWeekRm: rm(dueWeekSen),
    dueThisWeek: dueWeek.slice(0, TOP),
    [party === "supplier" ? "bySupplier" : "byCustomer"]: rows
      .filter((r) => num(r.balanceSen) > 0)
      .sort((x, y) => num(y.balanceSen) - num(x.balanceSen))
      .slice(0, TOP)
      .map((r) => ({ name: str(r.name), balanceRm: rm(r.balanceSen), aged: foldCells(r.cells) })),
  };
}

async function payablesSummary(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `payables:${today}`;
  const r = await ctx.read("/api/scm/accounting/ap-aging", { buckets: "day", basis: "invoice", asOf: today });
  if (!r.ok) return refused(r, target, "the creditor (AP) aging");
  return answer(
    { note: "Money in RM. The formal creditor aging (Accounting > AP aging): unpaid supplier bills aged by bill date. pastDue / dueThisWeek use each bill's due date (a bill without one is not counted there).", ...summariseAging(r.value, today, "supplier") },
    target,
  );
}

/** The unbilled-deliveries report (goods that left and were never invoiced) → total, by age, oldest. */
export function summariseUnbilled(body: unknown) {
  const b = obj(body);
  const rows = arr(b.rows);
  return {
    deliveryOrders: num(obj(b.totals).rows) || rows.length,
    unbilledRm: rm(obj(b.totals).unbilled_sen),
    byAge: arr(b.buckets).map((x) => ({ age: str(x.label), deliveryOrders: num(x.rows), unbilledRm: rm(x.unbilled_sen) })),
    oldest: rows.slice(0, TOP).map((x) => ({ do: str(x.do_number), so: str(x.so_doc_no), customer: str(x.debtor_name), salesperson: str(x.salesperson), ageDays: num(x.age_days), unbilledRm: rm(x.unbilled_sen), partlyInvoiced: !!x.partly_invoiced })),
  };
}

async function receivablesSummary(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `receivables:${today}`;
  const [ar, unbilled] = await Promise.all([ctx.read("/api/scm/accounting/ar-aging", { buckets: "day", basis: "invoice", asOf: today }), ctx.read("/api/scm/unbilled-deliveries", undefined)]);
  if (!ar.ok && !unbilled.ok) return refused(ar, target, "receivables (AR aging and unbilled deliveries)");
  const notAvailable: string[] = [];
  if (!ar.ok) notAvailable.push(ar.status === 401 || ar.status === 403 ? "You don't have access to the debtor (AR) aging." : "The AR aging could not be read just now.");
  if (!unbilled.ok) notAvailable.push(unbilled.status === 401 || unbilled.status === 403 ? "You don't have access to unbilled deliveries." : "Unbilled deliveries could not be read just now.");
  return answer(
    {
      today,
      note: "Money in RM. deliveredNotInvoiced = goods that left the warehouse and were never invoiced (the Unbilled Deliveries report, from the line ledger). invoicedNotPaid = the formal debtor aging, aged by invoice date; pastDue / dueThisWeek by due date.",
      ...(unbilled.ok ? { deliveredNotInvoiced: summariseUnbilled(unbilled.value) } : {}),
      ...(ar.ok ? { invoicedNotPaid: summariseAging(ar.value, today, "customer") } : {}),
      ...(notAvailable.length ? { notAvailable } : {}),
    },
    target,
  );
}

// ── S1 / S2: sales orders and deliveries by date ────────────────────────────

/** Statuses of an SO still waiting to go out (the list tabs). */
export const SO_OPEN_TABS = ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP"];
const DO_DONE = new Set(["SIGNED", "DELIVERED", "INVOICED", "CANCELLED"]);

/** Open SOs of every open tab, earliest customer delivery date first, read until the dates pass `horizon`. */
async function openSalesOrders(ctx: R3Ctx, horizon: string): Promise<{ ok: true; rows: Obj[]; truncated: boolean } | { ok: false; r: R3Read & { ok: false } }> {
  const past = (last: Obj) => {
    const d = str(last.customer_delivery_date).slice(0, 10);
    return !d || d > horizon;
  };
  const tabs = await Promise.all(SO_OPEN_TABS.map((t) => pagedRows(ctx, "/api/scm/mfg-sales-orders", "salesOrders", { status: t, sort: "customer_delivery_date:asc" }, 5, past)));
  const rows: Obj[] = [];
  let truncated = false;
  for (const t of tabs) {
    if (!t.ok) return { ok: false, r: t.r };
    rows.push(...t.rows.filter((o) => !o.on_hold));
    truncated = truncated || t.truncated;
  }
  return { ok: true, rows, truncated };
}

const soLine = (o: Obj, today: string, origin: string) => {
  const date = str(o.customer_delivery_date).slice(0, 10);
  return {
    so: str(o.doc_no),
    customer: str(o.debtor_name),
    salesperson: str(o.agent) || null,
    deliveryDate: date,
    daysLate: date < today ? daysBetween(date, today) ?? 0 : 0,
    status: str(o.status),
    valueRm: rm(o.local_total_sen),
    url: `${origin}/scm/sales-orders/${enc(str(o.doc_no))}`,
  };
};

/** S1: open SOs whose customer delivery date has passed. */
export function summariseSoOverdue(rows: readonly Obj[], today: string, origin: string, truncated: boolean) {
  const late = rows
    .filter((o) => {
      const d = str(o.customer_delivery_date).slice(0, 10);
      return d && d < today;
    })
    .map((o) => soLine(o, today, origin))
    .sort((a, b) => b.daysLate - a.daysLate);
  const bySp = new Map<string, number>();
  for (const l of late) bySp.set(l.salesperson ?? "(none)", (bySp.get(l.salesperson ?? "(none)") ?? 0) + 1);
  return {
    today,
    note: "Money in RM. Overdue = confirmed / in production / ready to ship (not held) with a customer delivery date before today. Only the orders you may see in the ERP.",
    overdue: late.length,
    valueRm: Math.round(late.reduce((n, l) => n + l.valueRm * 100, 0)) / 100,
    top: late.slice(0, TOP),
    bySalesperson: [...bySp.entries()].map(([salesperson, orders]) => ({ salesperson, orders })).sort((a, b) => b.orders - a.orders).slice(0, TOP),
    ...(truncated ? { cut: "Some status tabs have more than 500 overdue orders; the first 500 of each are counted." } : {}),
  };
}

async function soOverdue(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `so-overdue:${today}`;
  const got = await openSalesOrders(ctx, addDays(today, -1));
  if (!got.ok) return refused(got.r, target, "sales orders");
  return answer(summariseSoOverdue(got.rows, today, ctx.origin, got.truncated), target);
}

/** S2: delivery orders with a delivery date today..+6 not yet delivered, and open SOs due in the same days with no delivery yet. */
export function summariseDeliveriesDue(dos: readonly Obj[], sos: readonly Obj[], today: string, origin: string) {
  const week = addDays(today, 6);
  const inWeek = (d: string) => d >= today && d <= week;
  const dueDos = dos
    .filter((d) => !DO_DONE.has(str(d.status).toUpperCase()) && inWeek(str(d.customer_delivery_date).slice(0, 10)))
    .map((d) => ({
      do: str(d.do_number),
      so: str(d.so_doc_no),
      customer: str(d.debtor_name),
      deliveryDate: str(d.customer_delivery_date).slice(0, 10),
      status: str(d.status),
      driver: str(d.driver_name) || null,
      lorry: str(d.vehicle) || null,
      area: [str(d.city), str(d.state)].filter(Boolean).join(", ") || null,
      url: `${origin}/scm/delivery-orders/${enc(str(d.id))}`,
    }))
    .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));
  const onDo = new Set(dueDos.map((d) => d.so));
  const dueSos = sos
    .filter((o) => inWeek(str(o.customer_delivery_date).slice(0, 10)) && !onDo.has(str(o.doc_no)))
    .map((o) => soLine(o, today, origin))
    .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));
  const byDay = new Map<string, { deliveryOrders: number; salesOrdersWithoutDo: number }>();
  for (const d of dueDos) {
    const g = byDay.get(d.deliveryDate) ?? { deliveryOrders: 0, salesOrdersWithoutDo: 0 };
    g.deliveryOrders += 1;
    byDay.set(d.deliveryDate, g);
  }
  for (const o of dueSos) {
    const g = byDay.get(o.deliveryDate) ?? { deliveryOrders: 0, salesOrdersWithoutDo: 0 };
    g.salesOrdersWithoutDo += 1;
    byDay.set(o.deliveryDate, g);
  }
  return {
    from: today,
    to: week,
    note: "By customer delivery date. deliveryOrders = DOs not yet signed / delivered; salesOrdersWithoutDo = open SOs due these days with no DO in this list yet.",
    today: { deliveryOrders: dueDos.filter((d) => d.deliveryDate === today).length, salesOrdersWithoutDo: dueSos.filter((o) => o.deliveryDate === today).length },
    thisWeek: { deliveryOrders: dueDos.length, salesOrdersWithoutDo: dueSos.length },
    byDay: [...byDay.entries()].sort().map(([date, g]) => ({ date, ...g })),
    deliveryOrders: dueDos.slice(0, 15),
    salesOrdersWithoutDo: dueSos.slice(0, TOP),
  };
}

async function deliveriesDue(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const week = addDays(today, 6);
  const target = `deliveries-due:${today}..${week}`;
  const [dos, sos] = await Promise.all([
    pagedRows(ctx, "/api/scm/delivery-orders-mfg", "deliveryOrders", { dateBy: "delivery", from: today, to: week, sort: "customer_delivery_date:asc" }, 5),
    openSalesOrders(ctx, week),
  ]);
  if (!dos.ok && !sos.ok) return refused(dos.r, target, "delivery orders or sales orders");
  const out = summariseDeliveriesDue(dos.ok ? dos.rows : [], sos.ok ? sos.rows : [], today, ctx.origin);
  const notAvailable = [...(!dos.ok ? ["You don't have access to delivery orders."] : []), ...(!sos.ok ? ["You don't have access to sales orders."] : [])];
  return answer({ ...out, ...(notAvailable.length ? { notAvailable } : {}) }, target);
}

// ── registration ────────────────────────────────────────────────────────────

const readOnly = { readOnlyHint: true, openWorldHint: false };
const COMPANY = { type: "string", description: "Which company's data, as for the other tools (default: the person's usual company)" };
const noArgs = { type: "object", properties: { company: COMPANY }, additionalProperties: false };

export const FAQ_TOOLS = [
  { name: "po_overdue", title: "Overdue POs and what is still to be received (quick answer)", description: "Open purchase orders past their supplier date (supplier, days late, value) and everything still waiting to be received (partly received or awaiting goods receipt), by supplier, in ONE call.", inputSchema: noArgs, annotations: readOnly },
  {
    name: "supplier_lateness",
    title: "Which suppliers are late most often (quick answer)",
    description: "Late deliveries per supplier: POs received after their expected date (count, average days late, on-time %) and open POs past their date. period: \"90d\" (default, the last 90 days) or \"this_month\".",
    inputSchema: { type: "object", properties: { period: { type: "string", enum: ["90d", "this_month"] }, company: COMPANY }, additionalProperties: false },
    annotations: readOnly,
  },
  { name: "payables_summary", title: "How much we owe suppliers (quick answer)", description: "Unpaid supplier bills from the formal AP aging: total, aged 0-30 / 31-60 / 61-90 / over 90 days, per supplier, past due and due this week. Finance access only.", inputSchema: noArgs, annotations: readOnly },
  { name: "so_overdue", title: "Overdue sales orders (quick answer)", description: "Open sales orders past their customer delivery date and not yet delivered: customer, days late, salesperson, value, in ONE call.", inputSchema: noArgs, annotations: readOnly },
  { name: "deliveries_due", title: "Deliveries due today and this week (quick answer)", description: "Delivery orders due today and in the next 6 days (by customer delivery date, not yet delivered) plus open sales orders due those days that have no delivery order yet, by day.", inputSchema: noArgs, annotations: readOnly },
  {
    name: "receivables_summary",
    title: "Delivered not invoiced, invoiced not paid (quick answer)",
    description: "Receivables in ONE call: goods delivered but never invoiced (aged, oldest first) and unpaid customer invoices from the formal AR aging (aged 0-30 / 31-60 / 61-90 / over 90, past due, due this week, biggest customers). Finance access only.",
    inputSchema: noArgs,
    annotations: readOnly,
  },
];
export const FAQ_TOOL_NAMES = new Set(FAQ_TOOLS.map((t) => t.name));

export const FAQ_INSTRUCTIONS = `- Overdue POs / what is still to be received: po_overdue. Late suppliers: supplier_lateness. What we owe suppliers: payables_summary. Overdue sales orders: so_overdue. Deliveries due today / this week: deliveries_due. Delivered-not-invoiced and unpaid invoices: receivables_summary.`;

export function runFaqTool(ctx: R3Ctx, name: string, args: Obj): Promise<R3Outcome> | null {
  switch (name) {
    case "po_overdue":
      return poOverdue(ctx);
    case "supplier_lateness":
      return supplierLateness(ctx, args);
    case "payables_summary":
      return payablesSummary(ctx);
    case "so_overdue":
      return soOverdue(ctx);
    case "deliveries_due":
      return deliveriesDue(ctx);
    case "receivables_summary":
      return receivablesSummary(ctx);
    default:
      return null;
  }
}
