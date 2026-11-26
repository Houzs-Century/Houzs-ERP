import { DO_ARRIVED_STATES } from "../scm/shared/do-shipped-states";
import { poDueDate } from "./mcp-brief";
import { summariseAging, summariseUnbilled } from "./mcp-faq";
import { change, type Period, type Range } from "./mcp-period";
import { rm } from "./mcp-quick";
import { daysBetween } from "./mcp-quick2";

type Obj = Record<string, unknown>;
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));
const has = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null && o[k] !== undefined;
const enc = encodeURIComponent;
const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const inRange = (d: string, r: Range): boolean => !!d && d >= r.from && d <= r.to;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const TOP = 10;

/** Rows counted per key, biggest first. */
export function tally(rows: readonly Obj[], key: (r: Obj) => string, max = TOP): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r) || "(none)", (m.get(key(r) || "(none)") ?? 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, max);
}

const periodHead = (p: Period) => ({ period: p.period, from: p.from, to: p.to, previous: p.prev, sameDaysLastMonth: p.lastMonth });


/** H2: GET /api/scm/inventory/products?search= (+ /warehouses for each location's type) → what is on hand, reserved and coming in. */
export function summariseStock(products: unknown, warehouses: unknown, query: string, origin: string) {
  const rows = arr(obj(products).products);
  const whType = new Map(arr(obj(warehouses).warehouses).map((w) => [str(w.id), str(w.type) || (w.is_showroom ? "showroom" : "warehouse")]));
  const items = rows.slice(0, TOP).map((p) => {
    const byWh = arr(p.stock_by_warehouse).map((w) => ({ location: str(w.name) || str(w.code), code: str(w.code), type: whType.get(str(w.warehouse_id)) ?? "warehouse", qty: num(w.qty), consignmentHeld: num(w.held_qty) }));
    return {
      item: str(p.item_code),
      name: str(p.product_name),
      category: str(p.category) || null,
      onHand: num(p.total_qty),
      owned: num(p.owned_qty),
      consignmentHeld: num(p.held_qty),
      reservedWithDate: num(p.committed_scheduled),
      reservedNoDate: num(p.unscheduled_qty),
      available: num(p.available_qty),
      incomingWithin30Days: num(p.incoming_qty),
      incomingPos: arr(p.incoming_pos).slice(0, 5).map((x) => ({ po: str(x.po_number), eta: str(x.eta) || null, qty: num(x.qty) })),
      inShowrooms: byWh.filter((w) => w.type === "showroom" || w.type === "display").reduce((n, w) => n + w.qty, 0),
      byLocation: byWh.slice(0, 12),
      ...(p.ledger_mismatch ? { ledgerMismatch: true } : {}),
      url: `${origin}/scm/inventory?search=${enc(str(p.item_code))}`,
    };
  });
  return {
    query,
    note: "Quantities are units, from the Inventory screen. available = owned stock + incoming within 30 days - reserved with a delivery date (reserved without a date is future demand). Consignment held is a supplier's goods standing in our locations, never counted as available. A showroom or display piece is on hand but may not be sellable.",
    matches: rows.length,
    items,
    ...(rows.length > TOP ? { more: `${rows.length - TOP} more items match; give a fuller code or name.` } : {}),
    ...(rows.length === 0 ? { answer: `No product matches "${query}".` } : {}),
  };
}


/** H3: the whole product list (/api/scm/inventory/products) + the analytics' dead stock (/api/scm/inventory/analytics) → short, negative and slow stock. */
export function summariseInventory(products: unknown, analytics: unknown, origin: string) {
  const rows = arr(obj(products).products).filter((p) => num(p.total_qty) !== 0 || num(p.reserved_total) !== 0 || num(p.incoming_qty) !== 0 || num(p.movement_qty) !== 0);
  const line = (p: Obj) => ({ item: str(p.item_code), name: str(p.product_name), onHand: num(p.total_qty), reserved: num(p.reserved_total), incoming: num(p.incoming_qty), available: num(p.available_qty), url: `${origin}/scm/inventory?search=${enc(str(p.item_code))}` });
  const short = rows.filter((p) => num(p.available_qty) < 0).sort((a, b) => num(a.available_qty) - num(b.available_qty));
  const negative = rows.filter((p) => num(p.total_qty) < 0 || num(p.movement_qty) < 0);
  const mismatch = rows.filter((p) => p.ledger_mismatch === true);
  const a = obj(analytics);
  const dead = arr(a.deadStock);
  return {
    note: "Units unless marked RM. There are no reorder levels in the ERP, so 'short' = reserved orders with a delivery date exceed owned stock plus what arrives within 30 days (available below zero). Negative = the stock ledger below zero. Slow-moving = owned stock in selling locations with no sale in the window (showroom / display / service stock is left out, as on the Inventory analytics).",
    skusWithStock: rows.filter((p) => num(p.total_qty) > 0).length,
    short: { skus: short.length, top: short.slice(0, TOP).map(line) },
    negative: { skus: negative.length, top: negative.slice(0, TOP).map((p) => ({ ...line(p), ledgerQty: num(p.movement_qty) })) },
    ledgerMismatch: mismatch.length,
    ...(has(a, "deadStock")
      ? {
          slowMoving: {
            windowDays: num(a.windowDays) || 90,
            skus: dead.length,
            ...(dead.some((d) => has(d, "valueSen")) ? { valueRm: rm(dead.reduce((n, d) => n + num(d.valueSen), 0)) } : {}),
            top: dead.slice(0, TOP).map((d) => ({ item: str(d.item_code), name: str(d.product_name), qty: num(d.qty), ...(has(d, "valueSen") ? { valueRm: rm(d.valueSen) } : {}), lastSold: str(d.lastSoldAt).slice(0, 10) || "never" })),
          },
        }
      : {}),
  };
}


/** H4: the Unbilled Deliveries report → the FAQ summary plus who and which customers carry it. */
export function summariseUninvoiced(body: unknown, origin: string) {
  const rows = arr(obj(body).rows);
  const group = (key: (r: Obj) => string) => {
    const m = new Map<string, { deliveryOrders: number; sen: number }>();
    for (const r of rows) {
      const k = key(r) || "(none)";
      const g = m.get(k) ?? { deliveryOrders: 0, sen: 0 };
      g.deliveryOrders += 1;
      g.sen += num(r.unbilled_sen);
      m.set(k, g);
    }
    return [...m.entries()].map(([name, g]) => ({ name, deliveryOrders: g.deliveryOrders, unbilledRm: rm(g.sen) })).sort((a, b) => b.unbilledRm - a.unbilledRm || b.deliveryOrders - a.deliveryOrders).slice(0, TOP);
  };
  const base = summariseUnbilled(body);
  return {
    asOf: str(obj(body).as_of) || null,
    note: "Money in RM. Goods that left the warehouse and were never invoiced (the Unbilled Deliveries report, from the line ledger); age counts from the DO date. 0-30 days is the normal billing lag.",
    ...base,
    partlyInvoiced: { deliveryOrders: num(obj(obj(obj(body).totals).partly_invoiced).rows), unbilledRm: rm(obj(obj(obj(body).totals).partly_invoiced).unbilled_sen) },
    overOneYear: { deliveryOrders: num(obj(obj(obj(body).totals).over_365).rows), unbilledRm: rm(obj(obj(obj(body).totals).over_365).unbilled_sen) },
    bySalesperson: group((r) => str(r.salesperson)),
    byCustomer: group((r) => str(r.debtor_name)),
    oldest: rows.slice(0, 15).map((x) => ({ do: str(x.do_number), doDate: str(x.do_date).slice(0, 10), so: str(x.so_doc_no), customer: str(x.debtor_name), salesperson: str(x.salesperson) || null, ageDays: num(x.age_days), unbilledRm: rm(x.unbilled_sen), url: `${origin}/scm/delivery-orders/${enc(str(x.delivery_order_id))}` })),
  };
}


/** H5 / H9: the PO list's Outstanding tab (lines = the outstanding ones) → what is still being received, by receiving location. */
export function summariseAwaitingReceipt(rows: readonly Obj[], today: string, origin: string, truncated: boolean) {
  const open = rows.filter((p) => !p.on_hold);
  const byLoc = new Map<string, { pos: Set<string>; qty: number }>();
  const lines = open.map((p) => {
    const ls = arr(p.lines);
    const ordered = ls.reduce((n, l) => n + num(l.qty), 0);
    const received = ls.reduce((n, l) => n + num(l.received_qty), 0);
    const remaining = ls.reduce((n, l) => n + num(l.remaining_qty), 0);
    const priced = ls.every((l) => has(l, "unit_price_sen"));
    for (const l of ls) {
      const loc = str(l.location) || "(no location)";
      const g = byLoc.get(loc) ?? { pos: new Set<string>(), qty: 0 };
      g.pos.add(str(p.id));
      g.qty += num(l.remaining_qty);
      byLoc.set(loc, g);
    }
    const due = poDueDate(p);
    const grns = arr(p.transfer_to_grns);
    return {
      po: str(p.po_number),
      supplier: str(obj(p.supplier).name) || "(no supplier)",
      status: str(p.status),
      poDate: str(p.po_date).slice(0, 10) || null,
      supplierDate: due || null,
      daysLate: due && due < today ? (daysBetween(due, today) ?? 0) : 0,
      qtyOrdered: ordered,
      qtyReceived: received,
      qtyRemaining: remaining,
      ...(priced && ls.length ? { remainingValueRm: rm(ls.reduce((n, l) => n + num(l.remaining_qty) * num(l.unit_price_sen), 0)) } : {}),
      grns: grns.length,
      locations: [...new Set(ls.map((l) => str(l.location)).filter(Boolean))],
      url: `${origin}/scm/purchase-orders/${enc(str(p.id))}`,
    };
  });
  const partly = lines.filter((l) => l.status === "PARTIALLY_RECEIVED" || (l.qtyReceived > 0 && l.qtyRemaining > 0));
  const none = lines.filter((l) => !partly.includes(l));
  const byDate = (a: (typeof lines)[number], b: (typeof lines)[number]) => b.daysLate - a.daysLate || String(a.supplierDate ?? "9").localeCompare(String(b.supplierDate ?? "9"));
  return {
    today,
    note: "Units unless marked RM. Still being received = submitted or partly received POs (the PO list's Outstanding tab, held POs left out); qty is the outstanding lines only. Location = the line's receiving warehouse / showroom, else the PO's. remainingValueRm appears only when you may see PO prices.",
    stillBeingReceived: { pos: lines.length, qtyRemaining: lines.reduce((n, l) => n + l.qtyRemaining, 0) },
    partlyReceived: { pos: partly.length, top: partly.sort(byDate).slice(0, TOP) },
    awaitingFirstReceipt: { pos: none.length, top: none.sort(byDate).slice(0, TOP) },
    byLocation: [...byLoc.entries()].map(([location, g]) => ({ location, pos: g.pos.size, qtyRemaining: g.qty })).sort((a, b) => b.qtyRemaining - a.qtyRemaining).slice(0, 15),
    ...(truncated ? { cut: "More than 1,000 outstanding POs; the figures cover the first 1,000." } : {}),
  };
}


const OPEN_SO = (s: string) => !["DRAFT", "CANCELLED"].includes(s.toUpperCase());

/** H6: one customer from the SO list (?q=), their service cases (/api/assr?search=) and deliveries (DO list ?q=). */
export function summariseCustomer(query: string, sos: readonly Obj[], cases: readonly Obj[], dos: readonly Obj[], origin: string, today: string) {
  const live = sos.filter((o) => OPEN_SO(str(o.status)));
  const names = tally(live, (o) => [str(o.debtor_name), str(o.debtor_code)].filter(Boolean).join(" / "), 5);
  const balanceVisible = live.some((o) => has(o, "balance_sen_live"));
  const owing = live.filter((o) => num(o.balance_sen_live) > 0);
  const openCases = cases.filter((c) => !["completed", "voided"].includes(str(c.stage).toLowerCase()));
  const touches: { kind: string; date: string; ref: string }[] = [
    ...sos.map((o) => ({ kind: "sales order", date: str(o.so_date).slice(0, 10), ref: str(o.doc_no) })),
    ...dos.map((d) => ({ kind: "delivery", date: str(d.do_date).slice(0, 10), ref: str(d.do_number) })),
    ...cases.map((c) => ({ kind: "service case", date: str(c.updated_at || c.created_at).slice(0, 10), ref: str(c.assr_no) })),
  ].filter((t) => t.date && t.date <= today);
  touches.sort((a, b) => b.date.localeCompare(a.date));
  return {
    query,
    note: "Money in RM. From the documents you may see in the ERP: sales orders matching the name / phone / code, their deliveries and service cases. outstanding = unpaid balance on live (not draft / cancelled) orders. lastContact = the latest order, delivery or service-case update; chats and calls are not in the ERP.",
    customersMatched: names,
    ...(names.length > 1 ? { careful: "More than one customer matches; figures below cover all of them. Give a fuller name, phone or code to narrow it." } : {}),
    salesOrders: {
      count: live.length,
      ...(live.some((o) => has(o, "local_total_sen")) ? { totalRm: rm(live.reduce((n, o) => n + num(o.local_total_sen), 0)) } : {}),
      recent: live.slice(0, 8).map((o) => ({ so: str(o.doc_no), date: str(o.so_date).slice(0, 10), status: str(o.status), ...(has(o, "local_total_sen") ? { totalRm: rm(o.local_total_sen) } : {}), ...(has(o, "balance_sen_live") ? { balanceRm: rm(o.balance_sen_live) } : {}), url: `${origin}/scm/sales-orders/${enc(str(o.doc_no))}` })),
    },
    ...(balanceVisible ? { outstanding: { orders: owing.length, rm: rm(owing.reduce((n, o) => n + num(o.balance_sen_live), 0)) } } : {}),
    openServiceCases: { count: openCases.length, cases: openCases.slice(0, 5).map((c) => ({ case: str(c.assr_no), stage: str(c.stage), about: trim(str(c.complaint_issue) || str(c.issue_category), 120), opened: str(c.complained_date || c.created_at).slice(0, 10), url: `${origin}/assr?focus=${enc(str(c.id))}` })) },
    lastDelivery: dos.length ? { do: str(dos[0].do_number), date: str(dos[0].do_date).slice(0, 10), status: str(dos[0].status), delivered: (DO_ARRIVED_STATES as readonly string[]).includes(str(dos[0].status).toUpperCase()) } : null,
    lastContact: touches[0] ?? null,
  };
}


/** H7: /api/assr/summary (by_stage breached counts) + the drill lists breach_now and aging → cases past their deadline / stuck in a stage. */
export function summariseSla(summary: unknown, breached: unknown, stuck: unknown, today: string, origin: string) {
  const b = arr(obj(breached).cases);
  const st = arr(obj(stuck).cases);
  const late = b.map((c) => ({
    case: str(c.assr_no) || `#${str(c.id)}`,
    stage: str(c.stage),
    priority: str(c.priority) || null,
    customer: str(c.customer_name),
    about: trim(str(c.complaint_issue) || str(c.issue_category), 100),
    deadline: str(c.deadline_at).slice(0, 10),
    daysPastDeadline: daysBetween(str(c.deadline_at), today) ?? 0,
    url: `${origin}/assr?focus=${enc(str(c.id))}`,
  })).sort((x, y) => y.daysPastDeadline - x.daysPastDeadline);
  const byStage = arr(obj(summary).by_stage).filter((s) => num(s.breached) > 0).map((s) => ({ stage: str(s.stage), pastDeadline: num(s.breached), cases: num(s.total) })).sort((x, y) => y.pastDeadline - x.pastDeadline);
  return {
    today,
    note: "Past deadline = an open case whose deadline (set from its priority's SLA hours) has passed. Stuck = an open case more than 3 days in its current stage. Only the cases you may see in the ERP.",
    pastDeadline: num(obj(summary).breach_count) || b.length,
    pastDeadlineByStage: byStage.length ? byStage : tally(b, (c) => str(c.stage)).map((x) => ({ stage: x.name, pastDeadline: x.count })),
    pastDeadlineByPriority: tally(b, (c) => str(c.priority)),
    mostOverdue: late.slice(0, 15),
    stuckInStage: { cases: num(obj(summary).aging_count) || st.length, byStage: tally(st, (c) => str(c.stage)) },
    ...(obj(breached).limited ? { cut: "More than 500 cases past deadline; the lists cover 500." } : {}),
  };
}


/** H8: service cases reported in the period (/api/assr?from&to) → how many, what about, where, and the latest with a line each. */
export function summariseServiceCases(rows: readonly Obj[], total: number, prevTotal: number | null, p: Period, today: string, origin: string) {
  const open = rows.filter((c) => !["completed", "voided"].includes(str(c.stage).toLowerCase()));
  return {
    ...periodHead(p),
    note: "Cases by the date the complaint was reported. about = the complaint text, trimmed. outlet = the case's location. Only the cases you may see in the ERP.",
    cases: total,
    ...(prevTotal !== null ? { previousPeriodCases: prevTotal, changePct: change(total, prevTotal) } : {}),
    stillOpen: open.length,
    byCategory: tally(rows, (c) => str(c.issue_category)),
    byOutlet: tally(rows, (c) => str(c.location)),
    byStage: tally(rows, (c) => str(c.stage)),
    recent: rows.slice(0, 15).map((c) => ({
      case: str(c.assr_no) || `#${str(c.id)}`,
      reported: str(c.complained_date || c.created_at).slice(0, 10),
      customer: str(c.customer_name),
      outlet: str(c.location) || null,
      category: str(c.issue_category) || null,
      about: trim(str(c.complaint_issue), 160) || null,
      stage: str(c.stage),
      status: str(c.status) || null,
      ageDays: daysBetween(str(c.complained_date || c.created_at), today),
      url: `${origin}/assr?focus=${enc(str(c.id))}`,
    })),
    ...(total > rows.length ? { cut: `Categories, outlets and the list cover the latest ${rows.length} of ${total} cases.` } : {}),
  };
}


/** H10: three reads of the Sales Report's SO stage (the window, the previous period, the same days last month) → per outlet. */
export function summariseOutletPeriod(cur: unknown, prev: unknown, lastMonth: unknown, p: Period, today: string) {
  const fold = (body: unknown) => {
    const m = new Map<string, { orders: number; sen: number }>();
    for (const r of arr(obj(body).rows)) {
      const k = str(r.venue) || "(no showroom)";
      const g = m.get(k) ?? { orders: 0, sen: 0 };
      g.orders += 1;
      g.sen += num(r.amount_sen);
      m.set(k, g);
    }
    return m;
  };
  const c = fold(cur);
  const pv = prev === null ? null : fold(prev);
  const lm = lastMonth === null ? null : fold(lastMonth);
  const total = (m: Map<string, { orders: number; sen: number }> | null) => (m ? [...m.values()].reduce((a, g) => ({ orders: a.orders + g.orders, sen: a.sen + g.sen }), { orders: 0, sen: 0 }) : null);
  const tc = total(c)!;
  const tp = total(pv);
  const tl = total(lm);
  const todayRows = p.to === today && p.from !== today ? arr(obj(cur).rows).filter((r) => str(r.so_date).slice(0, 10) === today) : [];
  const names = [...new Set([...c.keys(), ...(pv?.keys() ?? [])])];
  const outlets = names
    .map((outlet) => {
      const g = c.get(outlet) ?? { orders: 0, sen: 0 };
      const gp = pv?.get(outlet);
      const gl = lm?.get(outlet);
      return {
        outlet,
        orders: g.orders,
        salesRm: rm(g.sen),
        ...(pv ? { previousRm: rm(gp?.sen ?? 0), changePct: change(g.sen, gp?.sen ?? 0) } : {}),
        ...(lm ? { sameDaysLastMonthRm: rm(gl?.sen ?? 0) } : {}),
      };
    })
    .sort((a, b) => b.salesRm - a.salesRm || a.outlet.localeCompare(b.outlet));
  return {
    ...periodHead(p),
    note: "Money in RM. Sales = sales orders not draft or cancelled, by SO date, per showroom / outlet (the Sales Report's Sales Order stage), for the company asked (company 2990 = the 2990's book).",
    totals: {
      orders: tc.orders,
      salesRm: rm(tc.sen),
      ...(tp ? { previousOrders: tp.orders, previousRm: rm(tp.sen), changePct: change(tc.sen, tp.sen) } : {}),
      ...(tl ? { sameDaysLastMonthRm: rm(tl.sen), vsLastMonthPct: change(tc.sen, tl.sen) } : {}),
      ...(todayRows.length || (p.to === today && p.from !== today) ? { todayOrders: todayRows.length, todayRm: rm(todayRows.reduce((n, r) => n + num(r.amount_sen), 0)) } : {}),
    },
    outlets: outlets.slice(0, 25),
    ...(outlets.length > 25 ? { moreOutlets: outlets.length - 25 } : {}),
  };
}


/** Booth POS: one event's report over the window (+ an optional report over the comparison span, split by day). */
export function posWindowTotals(report: unknown, r: Range): { bills: number; netSen: number } {
  let bills = 0;
  let netSen = 0;
  for (const d of arr(obj(obj(report).totals).by_day)) {
    if (!inRange(str(d.day), r)) continue;
    bills += num(d.bills);
    netSen += num(d.net_sen);
  }
  return { bills, netSen };
}

export function summarisePosPeriod(
  events: { name: string; status: string; current: unknown; compare: unknown | null }[],
  unreadable: string[],
  eventsTotal: number,
  p: Period,
) {
  const shaped = events.map((e) => {
    const t = obj(obj(e.current).totals);
    const prev = e.compare === null ? null : posWindowTotals(e.compare, p.prev);
    const lm = e.compare === null ? null : posWindowTotals(e.compare, p.lastMonth);
    return {
      event: e.name,
      status: e.status,
      bills: num(t.bills),
      netRm: rm(t.net_sen),
      ...(prev ? { previousNetRm: rm(prev.netSen), changePct: change(num(t.net_sen), prev.netSen) } : {}),
      ...(lm ? { sameDaysLastMonthNetRm: rm(lm.netSen) } : {}),
      returnsRm: rm(t.return_sen),
      voids: num(t.void_count),
      byMethodRm: arr(t.by_method).slice(0, 6).map((m) => ({ method: str(m.method), amountRm: rm(m.amount_sen) })),
      topItems: arr(t.by_item).sort((a, b) => num(b.net_sen) - num(a.net_sen)).slice(0, 5).map((i) => ({ item: str(i.description) || str(i.item_code), qty: num(i.qty), netRm: rm(i.net_sen) })),
    };
  });
  const sum = (k: "netRm" | "previousNetRm" | "sameDaysLastMonthNetRm") => round2(shaped.reduce((n, e) => n + num((e as Obj)[k]), 0));
  const compared = shaped.some((e) => "previousNetRm" in e);
  return {
    ...periodHead(p),
    note: "Money in RM. The booth POS (Cash & Carry and fair terminals): receipts synced to the ERP for the company asked; net = sales minus returns, voids excluded. Comparisons are for the same events in the earlier windows.",
    totals: { bills: shaped.reduce((n, e) => n + e.bills, 0), netRm: sum("netRm"), ...(compared ? { previousNetRm: sum("previousNetRm"), changePct: change(sum("netRm"), sum("previousNetRm")), sameDaysLastMonthNetRm: sum("sameDaysLastMonthNetRm") } : {}) },
    events: shaped,
    ...(eventsTotal > events.length + unreadable.length ? { more: `Showing ${events.length} events active in the window of ${eventsTotal}.` } : {}),
    ...(unreadable.length ? { couldNotRead: unreadable } : {}),
  };
}


type Figures = Partial<Record<(typeof FIG_KEYS)[number], number>>;
const FIG_KEYS = ["salesSen", "costOfSalesSen", "grossProfitSen", "expensesSen", "netProfitSen"] as const;

/**
 * The finance dashboard's monthly periods summed over a set of months; null when
 * the person sees no figures. A key the reply does not carry (redactMoney took
 * it) stays absent, never a made-up 0.
 */
export function dashboardFigures(dashboard: unknown, months: readonly string[]): Figures | null {
  const want = new Set(months);
  const periods = arr(obj(dashboard).periods).filter((x) => want.has(str(x.key)) && x.actual);
  if (!periods.length) return null;
  const out: Figures = {};
  for (const x of periods) {
    const a = obj(x.actual);
    for (const k of FIG_KEYS) if (has(a, k)) out[k] = (out[k] ?? 0) + num(a[k]);
  }
  return out;
}

/** company_report's period: whole months (this month / quarter / year to date, or one named), with the period before. */
export function reportMonths(period: string, today: string): { label: string; months: string[]; prevMonths: string[] } | null {
  const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
  const back = (s: string, n: number) => {
    const [y, m] = s.split("-").map(Number);
    const i = y * 12 + (m - 1) - n;
    return ym(Math.floor(i / 12), (i % 12) + 1);
  };
  const run = (first: string, n: number) => Array.from({ length: n }, (_, i) => back(first, -i));
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const raw = period.trim().toLowerCase() || "month";
  let first: string;
  let n: number;
  let label: string;
  if (raw === "month") [first, n, label] = [ym(y, m), 1, `${ym(y, m)} to date`];
  else if (raw === "last_month") [first, n, label] = [back(ym(y, m), 1), 1, back(ym(y, m), 1)];
  else if (raw === "quarter") [first, n, label] = [ym(y, Math.floor((m - 1) / 3) * 3 + 1), (m - 1) % 3 + 1, `Q${Math.floor((m - 1) / 3) + 1} ${y} to date`];
  else if (raw === "year") [first, n, label] = [ym(y, 1), m, `${y} to date`];
  else if (/^\d{4}-\d{2}$/.test(raw) && raw <= ym(y, m)) [first, n, label] = [raw, 1, raw];
  else if (/^\d{4}-q[1-4]$/.test(raw) && raw.slice(0, 4) <= String(y)) {
    const q = Number(raw.slice(6));
    first = ym(Number(raw.slice(0, 4)), (q - 1) * 3 + 1);
    if (first > ym(y, m)) return null;
    n = Math.min(3, (y * 12 + m) - (Number(first.slice(0, 4)) * 12 + Number(first.slice(5, 7))) + 1);
    label = raw.toUpperCase();
  } else if (/^\d{4}$/.test(raw) && Number(raw) <= y) [first, n, label] = [`${raw}-01`, Number(raw) === y ? m : 12, raw];
  else return null;
  const months = run(first, n);
  const span = raw === "quarter" || /q/.test(raw) ? 3 : raw === "year" || /^\d{4}$/.test(raw) ? 12 : 1;
  const prevFirst = back(first, span);
  return { label, months, prevMonths: run(prevFirst, n) };
}

const RM_NAMES: Record<(typeof FIG_KEYS)[number], string> = { salesSen: "salesRm", costOfSalesSen: "costOfSalesRm", grossProfitSen: "grossProfitRm", expensesSen: "expensesRm", netProfitSen: "netProfitRm" };
const figRm = (f: Figures): Obj => Object.fromEntries(FIG_KEYS.filter((k) => f[k] !== undefined).map((k) => [RM_NAMES[k], rm(f[k])]));
const figOut = (f: Figures | null, p: Figures | null) =>
  f
    ? {
        ...figRm(f),
        ...(f.salesSen && f.grossProfitSen !== undefined ? { grossMarginPct: Math.round((f.grossProfitSen / f.salesSen) * 1000) / 10 } : {}),
        ...(p ? { previous: figRm(p), ...(f.salesSen !== undefined ? { salesChangePct: change(f.salesSen, p.salesSen ?? 0) } : {}), ...(f.grossProfitSen !== undefined ? { grossProfitChangePct: change(f.grossProfitSen, p.grossProfitSen ?? 0) } : {}) } : {}),
      }
    : null;

/** company_report: the books' P&L (finance dashboard), sales by outlet (Sales Report), AR / AP aging and service cases, each only if readable. */
export function summariseCompanyReport(parts: {
  label: string;
  months: string[];
  prevMonths: string[];
  dashboard: unknown | null;
  salesCur: unknown | null;
  salesPrev: unknown | null;
  ar: unknown | null;
  ap: unknown | null;
  cases: unknown | null;
  notAvailable: string[];
  today: string;
}) {
  const fold = (body: unknown) => {
    const m = new Map<string, number>();
    let orders = 0;
    for (const r of arr(obj(body).rows)) {
      const k = str(r.venue) || "(no showroom)";
      m.set(k, (m.get(k) ?? 0) + num(r.amount_sen));
      orders += 1;
    }
    return { m, orders, sen: [...m.values()].reduce((a, b) => a + b, 0) };
  };
  const sc = parts.salesCur === null ? null : fold(parts.salesCur);
  const sp = parts.salesPrev === null ? null : fold(parts.salesPrev);
  const agingShort = (body: unknown, party: "supplier" | "customer") => {
    const a = summariseAging(body, parts.today, party);
    return { totalRm: a.totalRm, aged: a.aged, pastDueRm: a.pastDueRm, dueThisWeekRm: a.dueThisWeekRm, biggest: (party === "supplier" ? (a as Obj).bySupplier : (a as Obj).byCustomer) as unknown[] };
  };
  const cs = obj(parts.cases);
  return {
    period: parts.label,
    months: parts.months,
    comparedWith: parts.prevMonths,
    note: "Money in RM. profitAndLoss = the books (Accounting > Finance dashboard, posted entries; a month still open is provisional). salesOrders = sales orders taken (the Sales Report's SO stage), by outlet. Receivables / payables = the formal aging today. Each section appears only if your ERP role may read it.",
    profitAndLoss: parts.dashboard === null ? null : figOut(dashboardFigures(parts.dashboard, parts.months), dashboardFigures(parts.dashboard, parts.prevMonths)),
    salesOrders: sc
      ? {
          orders: sc.orders,
          salesRm: rm(sc.sen),
          ...(sp ? { previousRm: rm(sp.sen), changePct: change(sc.sen, sp.sen) } : {}),
          byOutlet: [...sc.m.entries()].map(([outlet, sen]) => ({ outlet, salesRm: rm(sen), ...(sp ? { previousRm: rm(sp.m.get(outlet) ?? 0) } : {}) })).sort((a, b) => b.salesRm - a.salesRm).slice(0, 15),
        }
      : null,
    receivables: parts.ar === null ? null : agingShort(parts.ar, "customer"),
    payables: parts.ap === null ? null : agingShort(parts.ap, "supplier"),
    afterSales: parts.cases === null ? null : { openCases: num(cs.active_count), pastDeadline: num(cs.breach_count), stuckOver3Days: num(cs.aging_count), avgDaysToClose: cs.avg_e2e_days === null || cs.avg_e2e_days === undefined ? null : num(cs.avg_e2e_days) },
    ...(parts.notAvailable.length ? { notAvailable: parts.notAvailable } : {}),
  };
}
