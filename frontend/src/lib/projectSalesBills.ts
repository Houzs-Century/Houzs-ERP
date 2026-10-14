/* The evening sales report a project keeps, as the page reads it — the wire
 * shape of GET /api/project-sales-bills/:projectId and the small derivations
 * every surface shares (owner 2026-10-14): the red number beside a name under
 * Sales Attending is that person's bills not yet opened as Sales Orders.
 *
 * Shared by the desktop block, the mobile panel and the chat's Save dialog so
 * the three cannot disagree. Pure; no fetching here.
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
  id: number;
  ref_raw: string;
  ref_token: string;
  amount_sen: number;
  salesperson_name: string | null;
  report_date: string | null;
  source_activity_id: number | null;
  created_at: string | null;
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

export type ProjectSalesBillsResponse = {
  bills: ProjectSalesBill[];
  persons: PersonSummary[];
  totals: BillTotals;
  /** Chat message ids a report was saved from — the chat marks those "Saved". */
  saved_activity_ids: number[];
  can_save: boolean;
};

/** What a paste would save, from POST …/preview. */
export type SalesReportPreviewBill = {
  line: number;
  ref_raw: string;
  ref_token: string;
  amount_sen: number;
  salesperson_name: string | null;
  existing: boolean;
  match: BillMatch;
  sales_rep_id: number | null;
};

export type SalesReportPreview = {
  date: { day: number; month: number } | null;
  report_date: string | null;
  total_sen: number | null;
  skipped: Array<{ line: number; text: string }>;
  warnings: string[];
  bills: SalesReportPreviewBill[];
};

const ZERO: BillTotals = {
  count: 0, amount_sen: 0, opened_count: 0, opened_sen: 0, not_opened_count: 0, not_opened_sen: 0, other_event_count: 0,
};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

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
    saved_activity_ids: Array.isArray(r.saved_activity_ids) ? r.saved_activity_ids.map(Number).filter(Number.isFinite) : [],
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
