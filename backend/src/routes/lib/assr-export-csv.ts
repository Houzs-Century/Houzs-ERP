/* The Service Cases CSV (GET /api/assr/export.csv). Its "PO Amount" column is
   the SUPPLIER cost of the case, so it follows the purchase-cost rule used for
   SKU cost on SCM screens: pmsAccess.isProductCostViewer (directors +
   Purchasing; /auth/me `product_cost_viewer`, capability scm.productCost.view).
   Anyone else who may open the case list still gets the export, without that
   column — never a refusal. */

import { isProductCostViewer } from "../../services/pmsAccess";
import type { AuthUser } from "../../services/auth";

const COLUMNS: ReadonlyArray<readonly [header: string, field: string]> = [
  ["ASSR No", "assr_no"], ["SO No", "doc_no"], ["Delivery Order", "delivery_order"],
  ["Stage", "stage"], ["Status", "status"], ["Priority", "priority"],
  ["Customer", "customer_name"], ["Phone", "customer_phone"], ["Location", "location"], ["Salesperson", "sales_agent"],
  ["Category", "service_category"], ["NCR Category", "ncr_category"], ["Resolution", "resolution_method"],
  ["Item", "item_code"], ["Issue", "complaint_issue"],
  ["Complained Date", "complained_date"], ["Created", "created_at"], ["Deadline", "deadline_at"],
  ["PO Amount", "po_amount"], ["PO No", "po_no"],
  ["Assigned To", "assigned_to_name"], ["Created By", "created_by_name"], ["Creditor", "creditor_name"],
  ["SLA Breached", "is_breached"],
];

const COST_FIELDS = new Set(["po_amount"]);

export function assrExportShowsCost(user: AuthUser | null): boolean {
  return isProductCostViewer(user);
}

const esc = (v: unknown): string => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Header line + one line per row, CRLF-joined, BOM-prefixed (Excel). Rows
 *  arrive already shaped (creditor strip, DO precedence) by the route. */
export function buildAssrCasesCsv(rows: ReadonlyArray<Record<string, unknown>>, showCost: boolean): string {
  const cols = COLUMNS.filter(([, f]) => showCost || !COST_FIELDS.has(f));
  const lines = [cols.map(([h]) => h).join(",")];
  for (const r of rows) {
    lines.push(cols.map(([, f]) => {
      const v = r[f];
      return esc(f === "po_amount" && v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : v);
    }).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}
