// ─────────────────────────────────────────────────────────────────────────
// sales-report-bills.ts — the rules behind a project's sales report: which
// chat messages count, which bill is already an order, whose it is, and what
// each person still has to open. Pure; routes/project-sales-bills.ts reads.
//
// Owner 2026-10-14: the evening report pasted into the project's chat is the
// record — it counts the moment it is posted, a message pasted before this
// existed counts too, and a wrong paste is voided by voiding the message. So
// the bills are DERIVED from the chat on every read, never copied out of it:
// there is no second store to fall out of step with what the chat shows.
// ─────────────────────────────────────────────────────────────────────────
import { extractRefTokens, parseSalesReport, reportDateFor, summaryTotalOf } from "../../scm/shared/sales-report-parse";

export type BillRow = {
  /** `${source_activity_id}:${line}` — stable for as long as the message is. */
  key: string;
  ref_raw: string;
  ref_token: string;
  amount_sen: number;
  extra_sen: number | null;
  extra_tag: string | null;
  salesperson_name: string | null;
  report_date: string | null;
  source_activity_id: number;
  created_at: string | null;
};

/** A chat message (project_activity, action 'note', not archived) and who wrote it. */
export type NoteRow = {
  id: number;
  note: string | null;
  created_at: string | null;
  author_email: string | null;
  author_position: string | null;
  /** The author's role name — canSaveSalesReport admits role "Sales Person" as
   *  well as position "Owner" / "Sales Director" (owner 2026-11-09). Caller joins
   *  roles on users.role_id. Null means the user has no role assigned. */
  author_role: string | null;
};

export type ReportSummary = {
  activity_id: number;
  total_sen: number;
  /** Sum of the message's day lines; null when it has none. */
  days_sen: number | null;
  created_at: string | null;
};

/** Every bill the project's chat carries, newest message winning per booklet
 *  number; the messages that contributed; and the latest summary's total.
 *  Only messages written by someone who may report (canSaveSalesReport) count:
 *  a rep chatting a number does not move the event's figures. */
export function collectReport(
  notes: readonly NoteRow[],
  projectStartDate: string | null,
  attendeeEmails: ReadonlySet<string> | null,
): { bills: BillRow[]; report_activity_ids: number[]; summary: ReportSummary | null } {
  const ordered = [...notes].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id - b.id,
  );
  const byToken = new Map<string, BillRow>();
  const contributing = new Set<number>();
  let summary: ReportSummary | null = null;
  for (const n of ordered) {
    if (!canSaveSalesReport({ email: n.author_email, position_name: n.author_position, role_name: n.author_role }, attendeeEmails)) continue;
    const parsed = parseSalesReport(n.note);
    if (parsed.bills.length > 0) {
      const reportDate = reportDateFor(parsed.date, projectStartDate);
      dropCorrected(byToken, new Set(parsed.bills.map((b) => b.ref_token)), reportDate);
      for (const b of parsed.bills) {
        byToken.set(b.ref_token, {
          key: `${n.id}:${b.line}`,
          ref_raw: b.ref_raw,
          ref_token: b.ref_token,
          amount_sen: b.amount_sen,
          extra_sen: b.extra_sen,
          extra_tag: b.extra_tag,
          salesperson_name: b.salesperson_name,
          report_date: reportDate,
          source_activity_id: n.id,
          created_at: n.created_at,
        });
      }
      contributing.add(n.id);
      continue;
    }
    const s = summaryTotalOf(parsed);
    if (s) summary = { activity_id: n.id, total_sen: s.total_sen, days_sen: s.days_sen, created_at: n.created_at };
  }
  /* A message whose every bill was overtaken by a later message no longer
     contributes; the chat should not mark it as counted. */
  const bills = [...byToken.values()].sort(
    (a, b) => (b.report_date ?? "").localeCompare(a.report_date ?? "") || a.ref_token.localeCompare(b.ref_token),
  );
  const live = new Set(bills.map((b) => b.source_activity_id));
  return { bills, report_activity_ids: [...contributing].filter((id) => live.has(id)), summary };
}

/** A report posted again to fix a typo replaces the first: same day, as many bills,
 *  and at least half of the earlier message's repeat, so the mistyped bill goes with
 *  it. A later message correcting one bill, or of new bills, adds to it. */
function dropCorrected(byToken: Map<string, BillRow>, tokens: ReadonlySet<string>, reportDate: string | null): void {
  if (reportDate === null) return;
  const bySource = new Map<number, BillRow[]>();
  for (const b of byToken.values()) {
    if (b.report_date === reportDate) bySource.set(b.source_activity_id, [...(bySource.get(b.source_activity_id) ?? []), b]);
  }
  for (const rows of bySource.values()) {
    if (tokens.size < rows.length || rows.filter((b) => tokens.has(b.ref_token)).length * 2 < rows.length) continue;
    for (const b of rows) if (!tokens.has(b.ref_token)) byToken.delete(b.ref_token);
  }
}

/** The message with one bill's reference changed, or null when it does not print
 *  that reference as a whole word. */
export function renameRef(note: string, from: string, to: string): string | null {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const whole = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`);
  return whole.test(note) ? note.replace(whole, to) : null;
}

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
   Owner 2026-10-14: "ummu, owner, weisiang". Owner 2026-10-30: add Peter
   (Sales Director, yzhe212@gmail.com) and every Sales Attending of THIS
   project. Owner 2026-11-09: open to every Sales Director (position) and every
   Sales Person (role), so the floor can post without being named one by one.
   The admin tier stays named (Owner position + two emails) and the per-event
   attendee path still works. Mirrored in frontend/src/auth/salesAccess.ts
   canSaveSalesReport, which only decides whether the chat shows the Save
   button; this is the authority. Reading the saved report needs only the Sales
   section's own gate — every attending rep sees their red number. */
const SAVE_EMAILS = new Set([
  "weisiang329@gmail.com",
  "ummuaimanlm@gmail.com",
]);

/* attendeeEmails is REQUIRED (CLAUDE.md: a parameter that decides something is
   not optional). Pass a lowercased Set of this project's attendee emails when
   the gate is per-event, or null when the gate is being asked without an event
   context (e.g. "would this user's chat ever count"). Making it required stops
   a new caller from forgetting it and silently dropping attendees — which was
   the bug behind the "No chat report" marker on project overview and the empty
   SALES REPORT (CHAT) panel on KLCC 31/10. */
export function canSaveSalesReport(
  user: {
    email?: string | null;
    position_name?: string | null;
    role_name?: string | null;
  } | null | undefined,
  attendeeEmails: ReadonlySet<string> | null,
): boolean {
  if (!user) return false;
  const position = (user.position_name ?? "").trim().toLowerCase();
  const role = (user.role_name ?? "").trim().toLowerCase();
  const email = (user.email ?? "").trim().toLowerCase();
  // Named admin tier: the Owner position + Weisiang + Ummu (owner 2026-10-14).
  if (position === "owner") return true;
  if (SAVE_EMAILS.has(email)) return true;
  // Open Sales tiers (owner 2026-11-09): any Sales Director (position) and any
  // Sales Person (role) may post. Position AND role are both checked because the
  // ERP writes a Sales Director either way — role on some seats, position on
  // others — and "Sales Person" is the role name every sales-floor seat holds.
  if (position === "sales director" || role === "sales director") return true;
  if (role === "sales person") return true;
  // Per-event attendee path — unchanged.
  if (attendeeEmails && email && attendeeEmails.has(email)) return true;
  return false;
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

export function orderAmountSen(o: OrderRow): number {
  const rev = Number(o.total_revenue_sen ?? 0);
  return rev > 0 ? rev : Number(o.local_total_sen ?? 0);
}

/** The order a bill is, when one carries its number. When several do (the
 *  same booklet number typed on two orders), the one linked to THIS event
 *  wins, then an unlinked one, then any — so a wrong-fair duplicate can never
 *  hide a right one. Ties break on doc_no so the answer is stable. */
/** One order, one booklet number that differs from the report by a single letter
 *  of the prefix: the report's ZNF6767 is the order's ZNT6767. Several such orders
 *  name nobody. */
function typedWrong(token: string, index: Map<string, OrderRow[]>): OrderRow[] {
  const m = /^([A-Z]+)(\d{4,})$/.exec(token);
  if (!m) return [];
  const near = [...index.entries()].filter(([t]) => {
    const o = /^([A-Z]+)(\d{4,})$/.exec(t);
    return !!o && o[2] === m[2] && o[1].length === m[1].length && o[1][0] === m[1][0];
  }).flatMap(([, rows]) => rows);
  return new Set(near.map((o) => o.doc_no)).size === 1 ? near : [];
}

/** An order carrying two booklet numbers (ZNT1234+HC1234) is one sale of two
 *  brands: either event may hold it. */
export function isBinding(o: Pick<OrderRow, "customer_so_no" | "ref">): boolean {
  return new Set([...extractRefTokens(o.customer_so_no), ...extractRefTokens(o.ref)]).size > 1;
}

export type BoothRef = { venue: string | null; start: string | null; end: string | null };

/** Two brands' booths of one fair: one venue, dates that overlap. A sale can sit
 *  under either, so it is not "under another event". */
export function sameFair(a: BoothRef | undefined, b: BoothRef | undefined): boolean {
  if (!a?.venue || !b?.venue || !a.start || !b.start) return false;
  const key = (v: string) => v.trim().toUpperCase();
  return key(a.venue) === key(b.venue) && a.start.slice(0, 10) <= (b.end ?? b.start).slice(0, 10) && b.start.slice(0, 10) <= (a.end ?? a.start).slice(0, 10);
}

export function matchBill(token: string, projectId: number, index: Map<string, OrderRow[]>): BillMatch {
  const exact = index.get(token) ?? [];
  const candidates = exact.length > 0 ? exact : typedWrong(token, index);
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
