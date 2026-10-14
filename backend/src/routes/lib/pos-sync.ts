// ----------------------------------------------------------------------------
// pos-sync.ts — the pure half of POST /api/pos-device/sales/batch (layout P14):
// what an incoming receipt must look like, how it is classified against what
// the ERP already holds (new / duplicate / void applied / salesman changed /
// rejected), and the inventory movements it produces. Tested without a
// database. Money is integer sen; the device's uuid is the identity.
// ----------------------------------------------------------------------------
import { isPosPaymentMethod } from "../../scm/shared/pos-vocabulary";

export type IncomingLine = {
  line_no: number; item_id: number | null; code: string; description: string; uom: string; qty: number; unit_price_sen: number;
  original_price_sen: number | null; override_by: string | null; override_reason: string | null;
  discount_source: "AUTO" | "MANUAL" | null; discount_type: "PCT" | "RM" | null; discount_value: number | null; discount_amount_sen: number; is_foc: boolean; amount_sen: number;
};
export type IncomingPayment = { method: string; amount_sen: number; reference: string | null; tendered_sen: number | null; change_sen: number | null };
export type IncomingSale = {
  uuid: string; type: "SALE" | "RETURN"; ref_sale_uuid: string | null; receipt_no: string; terminal_code: string; project_id: number;
  cashier_id: number | null; cashier_name: string; salesman_id: number | null; salesman_name: string | null; customer_name: string | null; customer_phone: string | null;
  sold_at: string; subtotal_sen: number; item_discount_sen: number; bill_discount_sen: number; sst_applied: boolean; sst_rate: number; sst_amount_sen: number; rounding_sen: number; total_sen: number;
  status: "PAID" | "VOID"; void_reason: string | null; void_by: string | null; voided_at: string | null; is_test: boolean; local_seq: number | null;
  lines: IncomingLine[]; payments: IncomingPayment[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);

/** The shape a device may send; anything else is rejected with a reason, never
 *  stored half-way. */
export function parseIncomingSale(raw: unknown): { ok: true; sale: IncomingSale } | { ok: false; reason: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof r.uuid !== "string" || !UUID_RE.test(r.uuid)) return { ok: false, reason: "uuid missing" };
  if (r.is_test === true) return { ok: false, reason: "test sale never syncs" };
  const type = r.type === "RETURN" ? "RETURN" : r.type === "SALE" ? "SALE" : null;
  if (!type) return { ok: false, reason: "type must be SALE or RETURN" };
  const status = r.status === "VOID" ? "VOID" : r.status === "PAID" ? "PAID" : null;
  if (!status) return { ok: false, reason: "status must be PAID or VOID" };
  if (typeof r.receipt_no !== "string" || !r.receipt_no.trim()) return { ok: false, reason: "receipt_no missing" };
  if (typeof r.terminal_code !== "string" || !r.terminal_code.trim()) return { ok: false, reason: "terminal_code missing" };
  if (!isInt(r.project_id) || r.project_id <= 0) return { ok: false, reason: "project_id missing" };
  if (typeof r.sold_at !== "string" || !Number.isFinite(Date.parse(r.sold_at))) return { ok: false, reason: "sold_at missing" };
  for (const k of ["subtotal_sen", "item_discount_sen", "bill_discount_sen", "sst_amount_sen", "rounding_sen", "total_sen"]) if (!isInt(r[k])) return { ok: false, reason: `${k} must be integer sen` };
  if (!Array.isArray(r.lines) || r.lines.length === 0) return { ok: false, reason: "no lines" };
  if (!Array.isArray(r.payments)) return { ok: false, reason: "payments missing" };
  const lines: IncomingLine[] = [];
  for (const [i, lr] of r.lines.entries()) {
    const l = (lr && typeof lr === "object" ? lr : {}) as Record<string, unknown>;
    if (!isInt(l.qty) || l.qty === 0) return { ok: false, reason: `line ${i + 1}: qty must be a non-zero integer` };
    if (!isInt(l.unit_price_sen) || !isInt(l.amount_sen) || !isInt(l.discount_amount_sen)) return { ok: false, reason: `line ${i + 1}: money must be integer sen` };
    if (typeof l.code !== "string" || !l.code.trim()) return { ok: false, reason: `line ${i + 1}: code missing` };
    lines.push({
      line_no: isInt(l.line_no) ? l.line_no : i + 1, item_id: isInt(l.item_id) && l.item_id > 0 ? l.item_id : null, code: l.code.trim().slice(0, 80),
      description: typeof l.description === "string" ? l.description.slice(0, 200) : l.code.trim(), uom: typeof l.uom === "string" && l.uom ? l.uom.slice(0, 20) : "UNIT",
      qty: l.qty, unit_price_sen: l.unit_price_sen, original_price_sen: isInt(l.original_price_sen) ? l.original_price_sen : null,
      override_by: strOrNull(l.override_by), override_reason: strOrNull(l.override_reason),
      discount_source: l.discount_source === "AUTO" || l.discount_source === "MANUAL" ? l.discount_source : null,
      discount_type: l.discount_type === "PCT" || l.discount_type === "RM" ? l.discount_type : null,
      discount_value: isNum(l.discount_value) ? l.discount_value : null, discount_amount_sen: l.discount_amount_sen, is_foc: l.is_foc === true, amount_sen: l.amount_sen,
    });
  }
  const payments: IncomingPayment[] = [];
  for (const [i, pr] of r.payments.entries()) {
    const p = (pr && typeof pr === "object" ? pr : {}) as Record<string, unknown>;
    if (!isPosPaymentMethod(p.method)) return { ok: false, reason: `payment ${i + 1}: unknown method` };
    if (!isInt(p.amount_sen)) return { ok: false, reason: `payment ${i + 1}: amount must be integer sen` };
    payments.push({ method: p.method, amount_sen: p.amount_sen, reference: strOrNull(p.reference), tendered_sen: isInt(p.tendered_sen) ? p.tendered_sen : null, change_sen: isInt(p.change_sen) ? p.change_sen : null });
  }
  const paid = payments.reduce((s, p) => s + p.amount_sen, 0);
  if (status === "PAID" && paid !== (r.total_sen as number)) return { ok: false, reason: `payments ${paid} do not equal total ${String(r.total_sen)}` };
  return {
    ok: true,
    sale: {
      uuid: r.uuid.toLowerCase(), type, ref_sale_uuid: typeof r.ref_sale_uuid === "string" && UUID_RE.test(r.ref_sale_uuid) ? r.ref_sale_uuid.toLowerCase() : null,
      receipt_no: r.receipt_no.trim().slice(0, 40), terminal_code: r.terminal_code.trim().slice(0, 20), project_id: r.project_id,
      cashier_id: isInt(r.cashier_id) ? r.cashier_id : null, cashier_name: typeof r.cashier_name === "string" ? r.cashier_name.slice(0, 80) : "",
      salesman_id: isInt(r.salesman_id) ? r.salesman_id : null, salesman_name: strOrNull(r.salesman_name), customer_name: strOrNull(r.customer_name), customer_phone: strOrNull(r.customer_phone),
      sold_at: new Date(r.sold_at).toISOString(), subtotal_sen: r.subtotal_sen as number, item_discount_sen: r.item_discount_sen as number, bill_discount_sen: r.bill_discount_sen as number,
      sst_applied: r.sst_applied === true, sst_rate: isNum(r.sst_rate) ? r.sst_rate : 0, sst_amount_sen: r.sst_amount_sen as number, rounding_sen: r.rounding_sen as number, total_sen: r.total_sen as number,
      status, void_reason: strOrNull(r.void_reason), void_by: strOrNull(r.void_by), voided_at: typeof r.voided_at === "string" && Number.isFinite(Date.parse(r.voided_at)) ? new Date(r.voided_at).toISOString() : null,
      is_test: false, local_seq: isInt(r.local_seq) ? r.local_seq : null, lines, payments,
    },
  };
}

export type StoredSale = { id: number; status: "PAID" | "VOID"; salesman_id: number | null; salesman_name: string | null; terminal_code: string; receipt_no: string };

export type Classification =
  | { kind: "new" }
  | { kind: "duplicate" }
  | { kind: "void"; stored: StoredSale }
  | { kind: "salesman"; stored: StoredSale }
  | { kind: "conflict"; reason: string };

/** The same uuid twice is a duplicate unless the device now says VOID (apply
 *  once) or the salesman changed (update + audit). A different device
 *  claiming the same receipt number is a conflict. */
export function classifyIncoming(sale: IncomingSale, stored: StoredSale | null, sameReceiptOtherUuid: boolean): Classification {
  if (!stored) return sameReceiptOtherUuid ? { kind: "conflict", reason: "receipt number already used by another sale" } : { kind: "new" };
  if (stored.terminal_code !== sale.terminal_code || stored.receipt_no !== sale.receipt_no) return { kind: "conflict", reason: "uuid known under another receipt number" };
  if (sale.status === "VOID" && stored.status === "PAID") return { kind: "void", stored };
  if (sale.status === "PAID" && stored.status === "PAID" && (stored.salesman_id ?? null) !== (sale.salesman_id ?? null)) return { kind: "salesman", stored };
  return { kind: "duplicate" };
}

export type MovementRow = { movement_type: "IN" | "OUT"; item_code: string; product_name: string; qty: number; source_doc_type: string; source_doc_no: string; notes: string };

/** OUT for every unit sold (FOC included), IN for every unit returned; the
 *  receipt number is the document the movement is logged against. */
export function movementsFor(sale: IncomingSale): MovementRow[] {
  const out: MovementRow[] = [];
  const kind = sale.type === "RETURN" ? "POS_RETURN" : "POS_SALE";
  for (const l of sale.lines) {
    if (l.qty > 0) out.push({ movement_type: "OUT", item_code: l.code, product_name: l.description, qty: l.qty, source_doc_type: kind, source_doc_no: sale.receipt_no, notes: `POS ${sale.type === "RETURN" ? "exchange" : "sale"} ${sale.receipt_no}` });
    else out.push({ movement_type: "IN", item_code: l.code, product_name: l.description, qty: -l.qty, source_doc_type: kind, source_doc_no: sale.receipt_no, notes: `POS return ${sale.receipt_no}` });
  }
  return out;
}

/** A VOID reverses the receipt: every OUT becomes an IN and vice versa. */
export function voidMovementsFor(sale: IncomingSale): MovementRow[] {
  return movementsFor(sale).map((m) => ({ ...m, movement_type: m.movement_type === "OUT" ? "IN" : "OUT", source_doc_type: "POS_VOID", notes: `POS void ${sale.receipt_no}` }));
}

export type BatchResult = { uuid: string; status: "accepted" | "duplicate" | "updated" | "rejected"; reason?: string; stock_warning?: string | null };
