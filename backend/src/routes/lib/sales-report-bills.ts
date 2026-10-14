// ─────────────────────────────────────────────────────────────────────────
// sales-report-bills.ts — the rules behind a project's pasted sales report:
// which bill is already an order, whose it is, and what each person still has
// to open. Pure; routes/project-sales-bills.ts does the reading and writing.
//
// Owner 2026-10-14: paste the evening report into the project, keep it, and
// once Total Sales is typed and the reps start opening orders, the project
// says how much is still not opened — per bill, and per salesperson beside
// their name under Sales Attending.
// ─────────────────────────────────────────────────────────────────────────
import { extractRefTokens } from "../../scm/shared/sales-report-parse";

export type BillRow = {
  id: number;
  ref_raw: string;
  ref_token: string;
  amount_sen: number;
  salesperson_name: string | null;
  report_date: string | null;
  source_activity_id: number | null;
  created_at: string | null;
};

/** The Sales Order columns the match reads — see routes/project-sales-bills.ts. */
export type OrderRow = {
  doc_no: string;
  project_id: number | null;
  status: string | null;
  customer_so_no: string | null;
  ref: string | null;
  salesperson_id: string | null;
  local_total_sen: number | null;
  total_revenue_sen: number | null;
};

export type AttendeeRow = {
  sales_rep_id: number;
  rep_name: string | null;
  user_name: string | null;
  rep_user_id: number | null;
};

export type BillMatch = {
  status: "opened" | "not_opened";
  so_doc_no: string | null;
  so_status: string | null;
  so_project_id: number | null;
  so_salesperson_id: string | null;
  so_amount_sen: number | null;
  /** The order exists but is linked to ANOTHER event — the rep picked the
   *  wrong fair and is asked to amend it. */
  other_event: boolean;
  /** The order exists and is linked to no event at all. */
  unlinked: boolean;
};

export type MatchedBill = BillRow & {
  match: BillMatch;
  person_key: string;
  sales_rep_id: number | null;
};

export type PersonSummary = {
  key: string;
  name: string;
  sales_rep_id: number | null;
  rep_user_id: number | null;
  count: number;
  amount_sen: number;
  opened_count: number;
  opened_sen: number;
  not_opened_count: number;
  not_opened_sen: number;
  other_event_count: number;
};

export type BillTotals = {
  count: number;
  amount_sen: number;
  opened_count: number;
  opened_sen: number;
  not_opened_count: number;
  not_opened_sen: number;
  other_event_count: number;
};

/* ── who may save ──────────────────────────────────────────────────────────
   Owner 2026-10-14: "ummu, owner, weisiang". Named people, not a role — the
   same shape as canCreateEvent (routes/projects.ts): the Owner position, and
   two accounts by email. Mirrored in frontend/src/auth/salesAccess.ts
   canSaveSalesReport, which only decides whether the button shows; this is
   the authority. Reading the saved report needs only the Sales section's own
   gate — the whole point is that every attending rep sees their red number. */
const SAVE_EMAILS = new Set(["weisiang329@gmail.com", "ummuaimanlm@gmail.com"]);

export function canSaveSalesReport(
  user: { email?: string | null; position_name?: string | null } | null | undefined,
): boolean {
  if (!user) return false;
  const position = (user.position_name ?? "").trim().toLowerCase();
  const email = (user.email ?? "").trim().toLowerCase();
  return position === "owner" || SAVE_EMAILS.has(email);
}

/* ── bill ↔ order ──────────────────────────────────────────────────────────
   The key is the booklet number. A new order carries it in Ref No.
   (customer_so_no, typed by the rep); an order migrated from AutoCount in
   `ref`, sometimes two to a field ("HC13503 + ZNT6191"). Both are read as
   tokens, so "HC13263 share with yuny" still matches HC13263 and HC1326 never
   does. Cancelled orders are not offered to this index — the route filters
   them out — because a cancelled order is not an opened bill. */

export function indexOrdersByToken(orders: readonly OrderRow[]): Map<string, OrderRow[]> {
  const index = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const tokens = new Set([...extractRefTokens(o.customer_so_no), ...extractRefTokens(o.ref)]);
    for (const t of tokens) {
      const arr = index.get(t) ?? [];
      arr.push(o);
      index.set(t, arr);
    }
  }
  return index;
}

const NOT_OPENED: BillMatch = {
  status: "not_opened",
  so_doc_no: null,
  so_status: null,
  so_project_id: null,
  so_salesperson_id: null,
  so_amount_sen: null,
  other_event: false,
  unlinked: false,
};

function orderAmountSen(o: OrderRow): number {
  const rev = Number(o.total_revenue_sen ?? 0);
  return rev > 0 ? rev : Number(o.local_total_sen ?? 0);
}

/** The order a bill is, when one carries its number. When several do (the
 *  same booklet number typed on two orders), the one linked to THIS event
 *  wins, then an unlinked one, then any — so a wrong-fair duplicate can never
 *  hide a right one. Ties break on doc_no so the answer is stable. */
export function matchBill(token: string, projectId: number, index: Map<string, OrderRow[]>): BillMatch {
  const candidates = index.get(token) ?? [];
  if (candidates.length === 0) return NOT_OPENED;
  const rank = (o: OrderRow): number =>
    o.project_id === projectId ? 0 : o.project_id == null ? 1 : 2;
  const best = [...candidates].sort((a, b) => rank(a) - rank(b) || a.doc_no.localeCompare(b.doc_no))[0]!;
  return {
    status: "opened",
    so_doc_no: best.doc_no,
    so_status: best.status,
    so_project_id: best.project_id,
    so_salesperson_id: best.salesperson_id,
    so_amount_sen: orderAmountSen(best),
    other_event: best.project_id != null && best.project_id !== projectId,
    unlinked: best.project_id == null,
  };
}

/* ── name → attending rep ──────────────────────────────────────────────────
   The report names people the way the floor does ("Jason", "Mei Ting"); the
   Sales Attending list carries the rep's full name. Exact first, then the
   pasted name as the first word(s) of a rep's name, then as a word anywhere
   in it. Ambiguity resolves to nobody rather than to the wrong person. */

export function personKey(name: string | null | undefined): string {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function namesOf(a: AttendeeRow): string[] {
  return [a.rep_name, a.user_name].map(personKey).filter((n) => n.length > 0);
}

export function resolveAttendee(name: string | null | undefined, attendees: readonly AttendeeRow[]): AttendeeRow | null {
  const key = personKey(name);
  if (!key) return null;
  const only = (hits: AttendeeRow[]): AttendeeRow | null => (hits.length === 1 ? hits[0]! : null);
  const exact = attendees.filter((a) => namesOf(a).includes(key));
  if (exact.length > 0) return only(exact);
  const prefix = attendees.filter((a) => namesOf(a).some((n) => n.startsWith(`${key} `)));
  if (prefix.length > 0) return only(prefix);
  const word = attendees.filter((a) => namesOf(a).some((n) => ` ${n} `.includes(` ${key} `)));
  if (word.length > 0) return only(word);
  /* Initials — the floor writes "CH" for Chea Huan (owner 2026-10-14). Two or
     three letters that are the first letters of a rep's name words, in order. */
  if (/^[a-z]{2,3}$/.test(key)) {
    const initials = attendees.filter((a) =>
      namesOf(a).some((n) => n.split(" ").map((w) => w.charAt(0)).join("") === key),
    );
    return only(initials);
  }
  return null;
}

/* ── the numbers ───────────────────────────────────────────────────────────── */

export function matchBills(
  bills: readonly BillRow[],
  projectId: number,
  orders: readonly OrderRow[],
  attendees: readonly AttendeeRow[],
): MatchedBill[] {
  const index = indexOrdersByToken(orders);
  return bills.map((b) => {
    const rep = resolveAttendee(b.salesperson_name, attendees);
    return {
      ...b,
      match: matchBill(b.ref_token, projectId, index),
      person_key: rep ? `rep:${rep.sales_rep_id}` : `name:${personKey(b.salesperson_name)}`,
      sales_rep_id: rep?.sales_rep_id ?? null,
    };
  });
}

export function summarizeBills(
  bills: readonly MatchedBill[],
  attendees: readonly AttendeeRow[],
): { persons: PersonSummary[]; totals: BillTotals } {
  const totals: BillTotals = {
    count: 0, amount_sen: 0, opened_count: 0, opened_sen: 0, not_opened_count: 0, not_opened_sen: 0, other_event_count: 0,
  };
  const byRep = new Map(attendees.map((a) => [a.sales_rep_id, a] as const));
  const persons = new Map<string, PersonSummary>();
  for (const b of bills) {
    const opened = b.match.status === "opened";
    totals.count += 1;
    totals.amount_sen += b.amount_sen;
    if (opened) { totals.opened_count += 1; totals.opened_sen += b.amount_sen; }
    else { totals.not_opened_count += 1; totals.not_opened_sen += b.amount_sen; }
    if (b.match.other_event) totals.other_event_count += 1;

    let p = persons.get(b.person_key);
    if (!p) {
      const rep = b.sales_rep_id != null ? byRep.get(b.sales_rep_id) : undefined;
      p = {
        key: b.person_key,
        name: rep?.rep_name || rep?.user_name || (b.salesperson_name ?? "").trim() || "(no name)",
        sales_rep_id: rep?.sales_rep_id ?? null,
        rep_user_id: rep?.rep_user_id ?? null,
        count: 0, amount_sen: 0, opened_count: 0, opened_sen: 0, not_opened_count: 0, not_opened_sen: 0, other_event_count: 0,
      };
      persons.set(b.person_key, p);
    }
    p.count += 1;
    p.amount_sen += b.amount_sen;
    if (opened) { p.opened_count += 1; p.opened_sen += b.amount_sen; }
    else { p.not_opened_count += 1; p.not_opened_sen += b.amount_sen; }
    if (b.match.other_event) p.other_event_count += 1;
  }
  const list = [...persons.values()].sort(
    (a, b) => b.not_opened_sen - a.not_opened_sen || b.amount_sen - a.amount_sen || a.name.localeCompare(b.name),
  );
  return { persons: list, totals };
}
