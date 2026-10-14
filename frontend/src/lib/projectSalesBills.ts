/* The evening sales report a project's chat carries, as the page reads it —
 * the wire shape of GET /api/project-sales-bills/:projectId and the small
 * derivations every surface shares (owner 2026-10-14): the red number beside a
 * name under Sales Attending is that person's bills not yet opened as Sales
 * Orders.
 *
 * Shared by the desktop block, the mobile panel and the chat so they cannot
 * disagree. Pure; no fetching here.
 */
import { fmtSen } from "../vendor/shared/format";

export type BillMatch = {
  status: "opened" | "not_opened";
  so_doc_no: string | null;
  so_status: string | null;
  so_project_id: number | null;
  so_salesperson_id: string | null;
  so_amount_sen: number | null;
  /** The order exists under ANOTHER event — the rep is asked to amend it. */
  other_event: boolean;
  /** The order exists and is linked to no event. */
  unlinked: boolean;
};

export type ProjectSalesBill = {
  /** `${source_activity_id}:${line}` — stable while the chat message is. */
  key: string;
  ref_raw: string;
  ref_token: string;
  amount_sen: number;
  /** A "+ 710(T)" tail the report keeps apart from the bill; shown, not counted. */
  extra_sen: number | null;
  extra_tag: string | null;
  salesperson_name: string | null;
  report_date: string | null;
  source_activity_id: number;
  created_at: string | null;
  match: BillMatch;
  person_key: string;
  sales_rep_id: number | null;
  /** The event a wrongly linked order sits under, when it is one. */
  other_event_name: string | null;
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

/** The latest summary message's Total — the figure for Total Sales. */
export type ReportSummary = {
  activity_id: number;
  total_sen: number;
  /** Sum of its day lines; null when it has none. */
  days_sen: number | null;
  created_at: string | null;
};

export type ProjectSalesBillsResponse = {
  bills: ProjectSalesBill[];
  persons: PersonSummary[];
  totals: BillTotals;
  /** Chat messages whose bills count — the chat marks those. */
  report_activity_ids: number[];
  summary: ReportSummary | null;
  /** Total Sales in whole RM — sent to the three who report only, else null. */
  total_sales_rm: number | null;
  can_save: boolean;
};

const ZERO: BillTotals = {
  count: 0, amount_sen: 0, opened_count: 0, opened_sen: 0, not_opened_count: 0, not_opened_sen: 0, other_event_count: 0,
};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function normalizeSummary(raw: unknown): ReportSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<ReportSummary>;
  if (typeof s.activity_id !== "number" || typeof s.total_sen !== "number") return null;
  return {
    activity_id: s.activity_id,
    total_sen: s.total_sen,
    days_sen: typeof s.days_sen === "number" ? s.days_sen : null,
    created_at: typeof s.created_at === "string" ? s.created_at : null,
  };
}

/** The read as the page may rely on it: a response of another shape (a stub,
 *  a proxy answering for another route) becomes an empty read, never a crash
 *  of the project page. */
export function normalizeProjectSalesBills(raw: unknown): ProjectSalesBillsResponse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ProjectSalesBillsResponse>;
  const t = r.totals && typeof r.totals === "object" ? r.totals : ZERO;
  return {
    bills: Array.isArray(r.bills) ? r.bills : [],
    persons: Array.isArray(r.persons) ? r.persons : [],
    totals: {
      count: num(t.count), amount_sen: num(t.amount_sen),
      opened_count: num(t.opened_count), opened_sen: num(t.opened_sen),
      not_opened_count: num(t.not_opened_count), not_opened_sen: num(t.not_opened_sen),
      other_event_count: num(t.other_event_count),
    },
    report_activity_ids: Array.isArray(r.report_activity_ids) ? r.report_activity_ids.map(Number).filter(Number.isFinite) : [],
    summary: normalizeSummary(r.summary),
    total_sales_rm: typeof r.total_sales_rm === "number" && Number.isFinite(r.total_sales_rm) ? r.total_sales_rm : null,
    can_save: r.can_save === true,
  };
}

/** sales_rep_id → sen still not opened, for the red number beside each name
 *  under Sales Attending. People the report named but the list does not carry
 *  have no chip to sit beside; they show in the block's own person row. */
export function notOpenedByRepId(persons: readonly PersonSummary[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of persons) {
    if (p.sales_rep_id == null || p.not_opened_sen <= 0) continue;
    out.set(p.sales_rep_id, (out.get(p.sales_rep_id) ?? 0) + p.not_opened_sen);
  }
  return out;
}

/** The bills the list shows: the ones still to be acted on. An order opened
 *  under THIS event is already in the Sales Orders list below the report, so
 *  its bill is not repeated (owner 2026-10-14); one opened under another
 *  event or under none still needs a person, so it stays. */
export function billsNeedingAction<T extends { match: BillMatch }>(bills: readonly T[]): T[] {
  return bills.filter((b) => b.match.status !== "opened" || b.match.other_event || b.match.unlinked);
}

export type BillStatusTone = "red" | "green" | "amber" | "grey";

/** The words a bill's row shows for its match, and the tone to draw them in. */
export function billStatusLabel(match: BillMatch): { text: string; tone: BillStatusTone } {
  if (match.status !== "opened") return { text: "Not opened", tone: "red" };
  if (match.other_event) return { text: "Opened under another event", tone: "amber" };
  if (match.unlinked) return { text: "Opened, no event on the order", tone: "amber" };
  return { text: "Opened", tone: "green" };
}

/** sen → "RM 1,234.00" (null-safe): the shared formatter under this feature's
 *  name, so every surface spells its money the way AutoCount does. */
export const fmtRmSen = fmtSen;
