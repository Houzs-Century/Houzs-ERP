import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { getDb } from "../../db/client";
import { pos_payments, pos_sale_lines, pos_sales } from "../../db/schema";
import { momentMs } from "../../scm/shared/pos-pairing";

type Db = ReturnType<typeof getDb>;
type SaleRow = typeof pos_sales.$inferSelect;
type LineRow = typeof pos_sale_lines.$inferSelect;
type PaymentRow = typeof pos_payments.$inferSelect;

/** The most bills one read hands a device; a fair runs to a few hundred. */
export const DEVICE_SALES_LIMIT = 1000;

export type DeviceSale = {
  uuid: string; type: string; ref_sale_uuid: string | null; ref_receipt_no: string | null; receipt_no: string; terminal_code: string; project_id: number;
  cashier_id: number; cashier_name: string; salesman_id: number | null; salesman_name: string | null; customer_name: string | null; customer_phone: string | null;
  sold_at: string; subtotal_sen: number; item_discount_sen: number; bill_discount_sen: number; bill_discount_by: string | null;
  sst_applied: boolean; sst_rate: number; sst_amount_sen: number; rounding_sen: number; total_sen: number;
  status: string; void_reason: string | null; void_by: string | null; voided_at: string | null; is_test: boolean; local_seq: number;
  lines: {
    line_no: number; item_id: number; code: string; description: string; uom: string; qty: number; unit_price_sen: number; original_price_sen: number | null;
    override_by: string | null; override_reason: string | null; discount_source: string | null; discount_type: string | null; discount_value: number | null;
    discount_by: string | null; discount_amount_sen: number; is_foc: boolean; amount_sen: number;
  }[];
  payments: { method: string; amount_sen: number; reference: string | null; tendered_sen: number | null; change_sen: number | null }[];
  synced_at: string | null; sync_error: null; returned: null;
};

const iso = (stored: string | null): string | null => {
  const t = momentMs(stored);
  return t == null ? null : new Date(t).toISOString();
};

export function toDeviceSale(h: SaleRow, lines: readonly LineRow[], payments: readonly PaymentRow[], refReceiptNo: string | null): DeviceSale {
  return {
    uuid: h.uuid, type: h.type, ref_sale_uuid: h.ref_sale_uuid, ref_receipt_no: refReceiptNo, receipt_no: h.receipt_no, terminal_code: h.terminal_code, project_id: h.project_id,
    cashier_id: h.cashier_id ?? 0, cashier_name: h.cashier_name ?? "", salesman_id: h.salesman_id, salesman_name: h.salesman_name, customer_name: h.customer_name, customer_phone: h.customer_phone,
    sold_at: iso(h.sold_at) ?? h.sold_at, subtotal_sen: h.subtotal_sen, item_discount_sen: h.item_discount_sen, bill_discount_sen: h.bill_discount_sen, bill_discount_by: h.bill_discount_by,
    sst_applied: h.sst_applied, sst_rate: Number(h.sst_rate), sst_amount_sen: h.sst_amount_sen, rounding_sen: h.rounding_sen, total_sen: h.total_sen,
    status: h.status, void_reason: h.void_reason, void_by: h.void_by, voided_at: iso(h.voided_at), is_test: h.is_test, local_seq: h.local_seq ?? 0,
    lines: [...lines].sort((a, b) => a.line_no - b.line_no).map((l) => ({
      line_no: l.line_no, item_id: l.item_id ?? 0, code: l.item_code, description: l.description, uom: l.uom, qty: Number(l.qty), unit_price_sen: l.unit_price_sen, original_price_sen: l.original_price_sen,
      override_by: l.override_by, override_reason: l.override_reason, discount_source: l.discount_source, discount_type: l.discount_type, discount_value: l.discount_value == null ? null : Number(l.discount_value),
      discount_by: l.discount_by, discount_amount_sen: l.discount_amount_sen, is_foc: l.is_foc, amount_sen: l.amount_sen,
    })),
    payments: payments.map((p) => ({ method: p.method, amount_sen: p.amount_sen, reference: p.reference, tendered_sen: p.tendered_sen, change_sen: p.change_sen })),
    synced_at: iso(h.synced_at), sync_error: null, returned: null,
  };
}

/** Every real (non-test) bill of one event of one company sold in [fromIso, toIso], newest first. */
export async function loadDeviceSales(db: Db, companyId: number, projectId: number, fromIso: string, toIso: string): Promise<DeviceSale[]> {
  const heads = await db.select().from(pos_sales)
    .where(and(eq(pos_sales.company_id, companyId), eq(pos_sales.project_id, projectId), eq(pos_sales.is_test, false), gte(pos_sales.sold_at, fromIso), lte(pos_sales.sold_at, toIso)))
    .orderBy(asc(pos_sales.sold_at))
    .limit(DEVICE_SALES_LIMIT);
  if (heads.length === 0) return [];
  const ids = heads.map((h) => h.id);
  const refs = Array.from(new Set(heads.map((h) => h.ref_sale_uuid).filter((v): v is string => v != null)));
  const [lines, payments, refRows] = await Promise.all([
    db.select().from(pos_sale_lines).where(inArray(pos_sale_lines.sale_id, ids)),
    db.select().from(pos_payments).where(inArray(pos_payments.sale_id, ids)),
    refs.length ? db.select({ uuid: pos_sales.uuid, receipt_no: pos_sales.receipt_no }).from(pos_sales).where(and(eq(pos_sales.company_id, companyId), inArray(pos_sales.uuid, refs))) : Promise.resolve([]),
  ]);
  const refBy = new Map(refRows.map((r) => [r.uuid, r.receipt_no]));
  return heads
    .map((h) => toDeviceSale(h, lines.filter((l) => l.sale_id === h.id), payments.filter((p) => p.sale_id === h.id), h.ref_sale_uuid ? refBy.get(h.ref_sale_uuid) ?? null : null))
    .reverse();
}
