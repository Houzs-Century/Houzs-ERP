/* The Sales Order list's Approval Code column (owner 2026-09-15,
   docs/bugs/0909: 我要的就是这个 payment 的 approval code). A module of its own
   because MfgSalesOrdersListV2.tsx is over its size ceiling and may only
   shrink.

   The value is the server's per-payment summary (`approval_codes_summary`:
   each card payment's code, in the order the money was paid, " + " joined),
   never the header's legacy single `approval_code`. Hidden by default like
   Payment Method; the Columns drawer shows it. */
import type { Column } from "../../components/DataTable";

/** What the column reads off a list row — `doc_no` names the row type the
    list uses, so the column slots into its `Column<SoRow>[]` unchanged. */
export type ApprovalCodeRow = { doc_no: string; approval_codes_summary?: string };

export const approvalCodeText = (r: ApprovalCodeRow): string => r.approval_codes_summary || "—";

export const approvalCodeColumn: Column<ApprovalCodeRow> = {
  key: "approval_codes",
  group: "Amounts",
  label: "Approval Code",
  width: "150px",
  defaultHidden: true,
  disableSort: true,
  getValue: (r) => r.approval_codes_summary ?? "",
  render: (r) => <span className="font-mono text-[12.5px] text-ink-secondary">{approvalCodeText(r)}</span>,
};
