// The receipts of one company (optionally one event / terminal / day range)
// in the shape pos-report.ts aggregates: the end-of-event summary email, the
// ERP Sales Report (E6) and the Sync Status KPIs read through here.
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { getDb } from "../../db/client";
import { pos_payments, pos_sale_lines, pos_sales } from "../../db/schema";
import type { ReportSale } from "./pos-report";

type Db = ReturnType<typeof getDb>;

export type ReportFilter = { projectId?: number | null; terminalCode?: string | null; fromIso?: string | null; toIso?: string | null; includeTest?: boolean };

export async function loadReportSales(db: Db, companyId: number, f: ReportFilter): Promise<ReportSale[]> {
  const conds = [eq(pos_sales.company_id, companyId)];
  if (f.projectId != null) conds.push(eq(pos_sales.project_id, f.projectId));
  if (f.terminalCode) conds.push(eq(pos_sales.terminal_code, f.terminalCode));
  if (f.fromIso) conds.push(gte(pos_sales.sold_at, f.fromIso));
  if (f.toIso) conds.push(lte(pos_sales.sold_at, f.toIso));
  if (!f.includeTest) conds.push(eq(pos_sales.is_test, false));
  const heads = await db
    .select({
      id: pos_sales.id, uuid: pos_sales.uuid, type: pos_sales.type, status: pos_sales.status, receipt_no: pos_sales.receipt_no, terminal_code: pos_sales.terminal_code, sold_at: pos_sales.sold_at,
      cashier_name: pos_sales.cashier_name, salesman_name: pos_sales.salesman_name, subtotal_sen: pos_sales.subtotal_sen, item_discount_sen: pos_sales.item_discount_sen, bill_discount_sen: pos_sales.bill_discount_sen,
      sst_amount_sen: pos_sales.sst_amount_sen, total_sen: pos_sales.total_sen, is_test: pos_sales.is_test,
    })
    .from(pos_sales)
    .where(and(...conds))
    .orderBy(asc(pos_sales.sold_at), asc(pos_sales.receipt_no));
  if (heads.length === 0) return [];
  const ids = heads.map((h) => h.id);
  const [lines, payments] = await Promise.all([
    db.select({ sale_id: pos_sale_lines.sale_id, item_code: pos_sale_lines.item_code, description: pos_sale_lines.description, qty: pos_sale_lines.qty, unit_price_sen: pos_sale_lines.unit_price_sen, discount_amount_sen: pos_sale_lines.discount_amount_sen, is_foc: pos_sale_lines.is_foc, amount_sen: pos_sale_lines.amount_sen }).from(pos_sale_lines).where(inArray(pos_sale_lines.sale_id, ids)).orderBy(asc(pos_sale_lines.line_no)),
    db.select({ sale_id: pos_payments.sale_id, method: pos_payments.method, amount_sen: pos_payments.amount_sen }).from(pos_payments).where(inArray(pos_payments.sale_id, ids)),
  ]);
  const lineBy = new Map<number, ReportSale["lines"]>();
  for (const l of lines) {
    const arr = lineBy.get(l.sale_id) ?? [];
    arr.push({ item_code: l.item_code, description: l.description, qty: Number(l.qty), unit_price_sen: l.unit_price_sen, discount_amount_sen: l.discount_amount_sen, is_foc: l.is_foc, amount_sen: l.amount_sen });
    lineBy.set(l.sale_id, arr);
  }
  const payBy = new Map<number, ReportSale["payments"]>();
  for (const p of payments) {
    const arr = payBy.get(p.sale_id) ?? [];
    arr.push({ method: p.method, amount_sen: p.amount_sen });
    payBy.set(p.sale_id, arr);
  }
  return heads.map((h) => ({
    uuid: h.uuid, type: h.type, status: h.status, receipt_no: h.receipt_no, terminal_code: h.terminal_code, sold_at: h.sold_at, cashier_name: h.cashier_name, salesman_name: h.salesman_name,
    subtotal_sen: h.subtotal_sen, item_discount_sen: h.item_discount_sen, bill_discount_sen: h.bill_discount_sen, sst_amount_sen: h.sst_amount_sen, total_sen: h.total_sen, is_test: h.is_test,
    lines: lineBy.get(h.id) ?? [], payments: payBy.get(h.id) ?? [],
  }));
}
