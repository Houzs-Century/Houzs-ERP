
import { SO_TERMINAL_STATES } from "../scm/shared/so-terminal-states";

type Obj = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));
const enc = encodeURIComponent;

export const BRIEF_TOP = 5;
export const DUE_SOON_DAYS = 3;

/** The sidebar counts the brief asks for, with the words a person reads. */
export const BRIEF_BADGES: Record<string, string> = {
  "amendment-approvals": "Sales order amendments to approve",
  "po-amendment-approvals": "Purchase order amendments to approve",
  "payment-backdate-approvals": "Backdated payments to approve",
  "payment-requests-waiting": "Payment requests waiting",
  "product-request-approvals": "Product requests to approve",
  "stock-take-approvals": "Stock takes to approve",
  "finance-todo": "Finance to-do items",
  "fair-links-to-settle": "Fair orders to settle",
  "mail-waiting": "Mail Center threads waiting for you",
  "meetings-unread": "Meeting updates unread",
  "it-support-replies": "IT support replies unread",
};

/** YYYY-MM-DD `n` days after `day`. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}

export type BriefSection = { title: string; count: number; overdue?: number; top: Obj[]; link?: string };
export type BriefRead = { ok: true; value: unknown } | { ok: false; status: number; message: string };

/** A read the person may not make: say so in plain words, and carry on with the rest. */
export const noAccess = (what: string, r: BriefRead): string =>
  !r.ok && (r.status === 401 || r.status === 403) ? `You don't have access to ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} could not be read just now.`;

/** Approvals and waiting counts from /api/badge-counts; zero and unreadable counts are left out. */
export function briefApprovals(body: unknown): { title: string; count: number }[] {
  const counts = obj(obj(body).counts);
  return Object.entries(BRIEF_BADGES)
    .map(([k, title]) => ({ title, count: counts[k] === null || counts[k] === undefined ? 0 : num(counts[k]) }))
    .filter((x) => x.count > 0);
}

const SO_DONE = new Set<string>(SO_TERMINAL_STATES);

/** Their sales orders whose customer delivery date is past or within DUE_SOON_DAYS and not yet delivered. */
export function briefSalesOrders(body: unknown, today: string, origin: string): BriefSection {
  const soon = addDays(today, DUE_SOON_DAYS);
  const due = arr(obj(body).salesOrders)
    .filter((o) => !SO_DONE.has(str(o.status).toUpperCase()))
    .map((o) => ({ o, date: str(o.customer_delivery_date).slice(0, 10) }))
    .filter((x) => x.date && x.date <= soon)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    title: "Your sales orders due for delivery (past or within 3 days)",
    count: due.length,
    overdue: due.filter((x) => x.date < today).length,
    top: due.slice(0, BRIEF_TOP).map(({ o, date }) => ({
      doc: str(o.doc_no),
      customer: str(o.debtor_name),
      deliveryDate: date,
      overdue: date < today,
      status: str(o.status),
      url: `${origin}/scm/sales-orders/${enc(str(o.doc_no))}`,
    })),
  };
}

/** A PO's effective supplier date: the latest of expected_at and the three revised dates. */
export function poDueDate(po: Obj): string {
  const ds = [po.expected_at, po.supplier_delivery_date_2, po.supplier_delivery_date_3, po.supplier_delivery_date_4].map((d) => str(d).slice(0, 10)).filter(Boolean);
  return ds.sort().at(-1) ?? "";
}

/** Outstanding purchase orders (submitted / partly received) whose supplier date is past or within DUE_SOON_DAYS. */
export function briefPurchaseOrders(body: unknown, today: string, origin: string): BriefSection {
  const soon = addDays(today, DUE_SOON_DAYS);
  const due = arr(obj(body).purchaseOrders)
    .filter((p) => !p.on_hold)
    .map((p) => ({ p, date: poDueDate(p) }))
    .filter((x) => x.date && x.date <= soon)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    title: "Purchase orders awaiting goods (past or within 3 days of the supplier date)",
    count: due.length,
    overdue: due.filter((x) => x.date < today).length,
    top: due.slice(0, BRIEF_TOP).map(({ p, date }) => ({
      po: str(p.po_number),
      supplier: str(obj(p.supplier).name),
      supplierDate: date,
      overdue: date < today,
      status: str(p.status),
      url: `${origin}/scm/purchase-orders/${enc(str(p.id))}`,
    })),
  };
}

const CASE_DONE = new Set(["completed", "voided"]);

/** Their open service cases, nearest deadline first. */
export function briefCases(body: unknown, today: string, origin: string): BriefSection {
  const open = arr(obj(body).cases).filter((c) => !CASE_DONE.has(str(c.stage).toLowerCase()));
  const keyed = open.map((c) => ({ c, deadline: str(c.deadline_at).slice(0, 10) }));
  keyed.sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"));
  return {
    title: "Your open service cases",
    count: open.length,
    overdue: keyed.filter((x) => x.deadline && x.deadline < today).length,
    top: keyed.slice(0, BRIEF_TOP).map(({ c, deadline }) => ({
      case: str(c.assr_no),
      customer: str(c.customer_name),
      stage: str(c.stage),
      deadline: deadline || null,
      overdue: !!deadline && deadline < today,
      url: `${origin}/assr?focus=${enc(str(c.id))}`,
    })),
  };
}

/** Leave requests waiting for this person's approval (only an approver gets any). */
export function briefLeave(body: unknown): BriefSection {
  const pending = arr(obj(body).pending);
  return {
    title: "Leave requests waiting for your approval",
    count: pending.length,
    top: pending.slice(0, BRIEF_TOP).map((l) => ({ employee: str(l.employeeName), leave: str(l.leaveStatus), from: str(l.startDate), to: str(l.endDate) })),
  };
}

/** Notices on the pop-up feed this person has not acknowledged. */
export function briefNotices(body: unknown): BriefSection {
  const b = obj(body);
  const acked = new Set((Array.isArray(b.ackedIds) ? (b.ackedIds as unknown[]) : []).map(String));
  const open = arr(b.data).filter((n) => !acked.has(str(n.id)));
  return {
    title: "Announcements you have not acknowledged",
    count: open.length,
    top: open.slice(0, BRIEF_TOP).map((n) => ({ title: str(n.title), from: str(n.createdByName ?? n.created_by_name) || null })),
  };
}

export type BriefInputs = {
  badges: BriefRead;
  salesOrders: BriefRead;
  purchaseOrders: BriefRead;
  cases: BriefRead;
  leave: BriefRead;
  notices: BriefRead;
};

/** The brief: only sections with something in them, plus a plain list of what the person cannot see. */
export function buildBrief(inp: BriefInputs, today: string, origin: string) {
  const notAvailable: string[] = [];
  const sections: BriefSection[] = [];
  const add = (r: BriefRead, what: string, shape: (v: unknown) => BriefSection) => {
    if (!r.ok) {
      notAvailable.push(noAccess(what, r));
      return;
    }
    const s = shape(r.value);
    if (s.count > 0) sections.push(s);
  };
  let waiting: { title: string; count: number }[] = [];
  if (inp.badges.ok) waiting = briefApprovals(inp.badges.value);
  else notAvailable.push(noAccess("your approval and waiting counts", inp.badges));
  add(inp.salesOrders, "your sales orders", (v) => briefSalesOrders(v, today, origin));
  add(inp.purchaseOrders, "purchase orders", (v) => briefPurchaseOrders(v, today, origin));
  add(inp.cases, "service cases", (v) => briefCases(v, today, origin));
  add(inp.leave, "leave requests", briefLeave);
  add(inp.notices, "announcements", briefNotices);
  return {
    today,
    note: "Only what this person can see in the ERP. Each list shows its count and the first 5; open the link for the rest.",
    waitingForYou: waiting,
    sections,
    ...(sections.length === 0 && waiting.length === 0 ? { allClear: "Nothing due, overdue or waiting for you right now." } : {}),
    ...(notAvailable.length ? { notAvailable } : {}),
  };
}
