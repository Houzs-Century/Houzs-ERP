/* A sale as the device saves it and the ERP receives it (the pos_sales /
 * pos_sale_lines / pos_payments shape, layouts P7, P10, P12, P16), and the
 * payment rules: methods, split, cash rounding and change, the receipt
 * counter, void, return / exchange. Pure; money in integer sen. */
import { cartTotals, formatReceiptNo, lineAmountSen, lineDiscountSen, type Cart, type CartLine } from "./cart";
import type { PosPaymentMethod } from "@shared/pos-vocabulary";

export type SaleLine = {
  line_no: number;
  item_id: number;
  code: string;
  description: string;
  uom: string;
  qty: number;
  unit_price_sen: number;
  original_price_sen: number | null;
  override_by: string | null;
  override_reason: string | null;
  discount_source: "AUTO" | "MANUAL" | null;
  discount_type: "PCT" | "RM" | null;
  discount_value: number | null;
  /** The supervisor who passed a manual discount above the cap, else null. */
  discount_by: string | null;
  discount_amount_sen: number;
  is_foc: boolean;
  amount_sen: number;
};

export type SalePayment = { method: PosPaymentMethod; amount_sen: number; reference: string | null; tendered_sen: number | null; change_sen: number | null };

export type SaleRecord = {
  uuid: string;
  type: "SALE" | "RETURN";
  ref_sale_uuid: string | null;
  ref_receipt_no: string | null;
  receipt_no: string;
  terminal_code: string;
  project_id: number;
  cashier_id: number;
  cashier_name: string;
  salesman_id: number | null;
  salesman_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  sold_at: string;
  subtotal_sen: number;
  item_discount_sen: number;
  bill_discount_sen: number;
  bill_discount_by: string | null;
  sst_applied: boolean;
  sst_rate: number;
  sst_amount_sen: number;
  rounding_sen: number;
  total_sen: number;
  status: "PAID" | "VOID";
  void_reason: string | null;
  void_by: string | null;
  voided_at: string | null;
  is_test: boolean;
  local_seq: number;
  lines: SaleLine[];
  payments: SalePayment[];
  /** Set when the ERP acknowledged it (step 6). */
  synced_at: string | null;
  sync_error: string | null;
  /** RETURN only: the qty taken back per original line_no (positive). */
  returned: { line_no: number; qty: number; reason: string }[] | null;
};

export function saleLinesFromCart(lines: readonly CartLine[]): SaleLine[] {
  return lines.map((l) => ({
    line_no: l.line_no, item_id: l.item_id, code: l.code, description: l.receipt_name, uom: l.uom, qty: l.qty, unit_price_sen: l.unit_price_sen,
    original_price_sen: l.original_price_sen, override_by: l.override_by, override_reason: l.override_reason,
    discount_source: l.is_foc ? null : l.discount?.source ?? null, discount_type: l.is_foc ? null : l.discount?.type ?? null, discount_value: l.is_foc ? null : l.discount?.value ?? null,
    discount_by: l.is_foc ? null : l.discount?.approved_by ?? null, discount_amount_sen: lineDiscountSen(l), is_foc: l.is_foc, amount_sen: lineAmountSen(l),
  }));
}

/* ── payments (P7) ─────────────────────────────────────────────────────── */

export type PaymentDraft = { method: PosPaymentMethod; amount_sen: number; reference: string; tendered_sen: number | null };

/** 5 sen rounding applies only when CASH takes part and the setting is on. */
export const cashInvolved = (pays: readonly { method: PosPaymentMethod }[]): boolean => pays.some((p) => p.method === "CASH");

export type PaymentCheck = { ok: true; total_sen: number; rounding_sen: number; change_sen: number } | { ok: false; reason: string; total_sen: number; rounding_sen: number; balance_sen: number };

/** The bill total under this payment (cash rounding), the balance and the
 *  change. Max two lines; every line positive; Complete only at balance 0. */
export function checkPayment(cart: Cart, sstRate: number, roundingOnCash: boolean, pays: readonly PaymentDraft[]): PaymentCheck {
  const t = cartTotals(cart, sstRate, roundingOnCash && cashInvolved(pays));
  const total = t.total_sen;
  if (pays.length === 0 || pays.length > 2) return { ok: false, reason: pays.length === 0 ? "Choose a payment method" : "At most two payment lines", total_sen: total, rounding_sen: t.rounding_sen, balance_sen: total };
  if (pays.some((p) => !Number.isInteger(p.amount_sen) || p.amount_sen <= 0)) return { ok: false, reason: "Every payment line needs an amount", total_sen: total, rounding_sen: t.rounding_sen, balance_sen: total - pays.reduce((s, p) => s + Math.max(0, p.amount_sen), 0) };
  if (pays.length === 2 && pays[0]!.method === pays[1]!.method) return { ok: false, reason: "Use two different methods to split", total_sen: total, rounding_sen: t.rounding_sen, balance_sen: 0 };
  const paid = pays.reduce((s, p) => s + p.amount_sen, 0);
  const balance = total - paid;
  if (balance !== 0) return { ok: false, reason: balance > 0 ? `Balance RM ${(balance / 100).toFixed(2)} outstanding` : "Paid more than the total", total_sen: total, rounding_sen: t.rounding_sen, balance_sen: balance };
  const cash = pays.find((p) => p.method === "CASH");
  const change = cash && cash.tendered_sen != null ? Math.max(0, cash.tendered_sen - cash.amount_sen) : 0;
  if (cash && cash.tendered_sen != null && cash.tendered_sen < cash.amount_sen) return { ok: false, reason: "Cash tendered is below the cash amount", total_sen: total, rounding_sen: t.rounding_sen, balance_sen: 0 };
  return { ok: true, total_sen: total, rounding_sen: t.rounding_sen, change_sen: change };
}

/** Split: the first line's amount is typed, the second takes the balance. */
export function splitBalance(totalSen: number, firstAmountSen: number): number {
  return Math.max(0, totalSen - Math.max(0, firstAmountSen));
}

/* ── the record ─────────────────────────────────────────────────────────── */

export type SaleContext = {
  uuid: string;
  terminal_code: string;
  project_id: number;
  cashier: { id: number; name: string };
  receipt_format: string;
  counter: number;
  is_test: boolean;
  now: string;
};

export function buildSale(cart: Cart, sstRate: number, roundingOnCash: boolean, pays: readonly PaymentDraft[], ctx: SaleContext): SaleRecord {
  const check = checkPayment(cart, sstRate, roundingOnCash, pays);
  if (!check.ok) throw new Error(check.reason);
  const t = cartTotals(cart, sstRate, roundingOnCash && cashInvolved(pays));
  return {
    uuid: ctx.uuid, type: "SALE", ref_sale_uuid: null, ref_receipt_no: null,
    receipt_no: formatReceiptNo(ctx.receipt_format, ctx.terminal_code, ctx.counter, ctx.is_test),
    terminal_code: ctx.terminal_code, project_id: ctx.project_id, cashier_id: ctx.cashier.id, cashier_name: ctx.cashier.name,
    salesman_id: cart.salesman?.id ?? null, salesman_name: cart.salesman?.name ?? null,
    customer_name: cart.customer?.name || null, customer_phone: cart.customer?.phone || null,
    sold_at: ctx.now, subtotal_sen: t.subtotal_sen, item_discount_sen: t.item_discount_sen, bill_discount_sen: t.bill_discount_sen, bill_discount_by: cart.bill_discount?.approved_by ?? null,
    sst_applied: cart.sst_applied, sst_rate: cart.sst_applied ? sstRate : 0, sst_amount_sen: t.sst_sen, rounding_sen: t.rounding_sen, total_sen: t.total_sen,
    status: "PAID", void_reason: null, void_by: null, voided_at: null, is_test: ctx.is_test, local_seq: ctx.counter,
    lines: saleLinesFromCart(cart.lines),
    payments: pays.map((p) => ({ method: p.method, amount_sen: p.amount_sen, reference: p.reference.trim() || null, tendered_sen: p.method === "CASH" ? p.tendered_sen : null, change_sen: p.method === "CASH" && p.tendered_sen != null ? Math.max(0, p.tendered_sen - p.amount_sen) : null })),
    synced_at: null, sync_error: null, returned: null,
  };
}

/** The stock a receipt takes per item (FOC included): minus the line qty.
 *  A RETURN's returned lines carry a NEGATIVE qty, so they give stock back,
 *  and an exchange's new items carry a positive qty, so they deduct. */
export function stockDeltas(sale: SaleRecord): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of sale.lines) m.set(l.item_id, (m.get(l.item_id) ?? 0) - l.qty);
  return m;
}

/* ── void (P12) ─────────────────────────────────────────────────────────── */

export type VoidRule = "SUPERVISOR_ANY_TIME" | "SUPERVISOR_SAME_DAY";

export function voidAllowed(sale: SaleRecord, rule: VoidRule, todayMyt: string): { ok: true } | { ok: false; reason: string } {
  if (sale.status === "VOID") return { ok: false, reason: "Already void" };
  if (rule === "SUPERVISOR_SAME_DAY" && mytDate(sale.sold_at) !== todayMyt) return { ok: false, reason: "Void is allowed on the same day only (General setting)" };
  return { ok: true };
}

export function voidSale(sale: SaleRecord, by: string, reason: string, now: string): SaleRecord {
  return { ...sale, status: "VOID", void_by: by, void_reason: reason, voided_at: now, synced_at: null, sync_error: null };
}

/** YYYY-MM-DD of an instant in Malaysia time. */
export function mytDate(iso: string): string {
  return new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10);
}

/* ── return / exchange (P16) ───────────────────────────────────────────── */

export type ReturnPick = { line_no: number; qty: number; reason: string };

/** How much of each line may still come back (sold minus already returned). */
export function returnableQty(original: SaleRecord, priorReturns: readonly SaleRecord[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of original.lines) if (!l.is_foc) m.set(l.line_no, l.qty);
  for (const r of priorReturns) {
    if (r.ref_sale_uuid !== original.uuid || r.status === "VOID" || !r.returned) continue;
    for (const x of r.returned) m.set(x.line_no, Math.max(0, (m.get(x.line_no) ?? 0) - x.qty));
  }
  return m;
}

export function returnWindowOpen(original: SaleRecord, window: "EVENT" | "SAME_DAY", eventEndDate: string | null, nowIso: string): { ok: true } | { ok: false; reason: string } {
  if (original.status === "VOID") return { ok: false, reason: "That bill is void" };
  if (original.type === "RETURN") return { ok: false, reason: "That is a return receipt, not a sale" };
  if (window === "SAME_DAY" && mytDate(original.sold_at) !== mytDate(nowIso)) return { ok: false, reason: "Returns are allowed on the same day only (General setting)" };
  if (window === "EVENT" && eventEndDate && mytDate(nowIso) > eventEndDate.slice(0, 10)) return { ok: false, reason: "The event has ended; returns are closed" };
  return { ok: true };
}

export type ReturnTotals = { refund_sen: number; new_sen: number; difference_sen: number };

/** Refund value of the picked lines at their sold net unit value (after the
 *  line's own discount and the bill discount's share), the new items' value,
 *  and the difference: positive = customer pays, negative = refund. */
export function returnTotals(original: SaleRecord, picks: readonly ReturnPick[], newCart: Cart | null, sstRate: number): ReturnTotals {
  let refund = 0;
  const billShare = original.subtotal_sen - original.item_discount_sen > 0 ? original.bill_discount_sen / (original.subtotal_sen - original.item_discount_sen) : 0;
  for (const p of picks) {
    const l = original.lines.find((x) => x.line_no === p.line_no);
    if (!l || l.is_foc || p.qty <= 0) continue;
    const perUnitNet = l.amount_sen / l.qty;
    let v = perUnitNet * p.qty;
    v -= v * billShare;
    if (original.sst_applied) v += (v * original.sst_rate) / 100;
    refund += v;
  }
  refund = Math.round(refund);
  const newSen = newCart && newCart.lines.length ? cartTotals({ ...newCart, sst_applied: original.sst_applied }, sstRate, false).total_sen : 0;
  return { refund_sen: refund, new_sen: newSen, difference_sen: newSen - refund };
}

/** The RETURN receipt: returned lines as negative qty, new items positive,
 *  total = the difference (negative = refunded). */
export function buildReturn(
  original: SaleRecord,
  picks: readonly ReturnPick[],
  newCart: Cart | null,
  sstRate: number,
  pays: readonly PaymentDraft[],
  ctx: SaleContext,
): SaleRecord {
  const t = returnTotals(original, picks, newCart, sstRate);
  const lines: SaleLine[] = [];
  let n = 1;
  for (const p of picks) {
    const l = original.lines.find((x) => x.line_no === p.line_no);
    if (!l || l.is_foc || p.qty <= 0) continue;
    const unitDisc = l.qty > 0 ? Math.round(l.discount_amount_sen / l.qty) : 0;
    lines.push({ ...l, line_no: n++, qty: -p.qty, discount_amount_sen: -unitDisc * p.qty, amount_sen: -Math.round((l.amount_sen / l.qty) * p.qty), override_reason: p.reason });
  }
  if (newCart) for (const l of saleLinesFromCart(newCart.lines)) lines.push({ ...l, line_no: n++ });
  const refundMethod = original.payments[0]?.method ?? "QR";
  const payments: SalePayment[] = t.difference_sen > 0
    ? pays.map((p) => ({ method: p.method, amount_sen: p.amount_sen, reference: p.reference.trim() || null, tendered_sen: null, change_sen: null }))
    : t.difference_sen < 0
      ? [{ method: pays[0]?.method ?? refundMethod, amount_sen: t.difference_sen, reference: pays[0]?.reference.trim() || null, tendered_sen: null, change_sen: null }]
      : [];
  return {
    uuid: ctx.uuid, type: "RETURN", ref_sale_uuid: original.uuid, ref_receipt_no: original.receipt_no,
    receipt_no: `R-${formatReceiptNo(ctx.receipt_format, ctx.terminal_code, ctx.counter, ctx.is_test)}`,
    terminal_code: ctx.terminal_code, project_id: ctx.project_id, cashier_id: ctx.cashier.id, cashier_name: ctx.cashier.name,
    salesman_id: original.salesman_id, salesman_name: original.salesman_name, customer_name: original.customer_name, customer_phone: original.customer_phone,
    sold_at: ctx.now, subtotal_sen: lines.reduce((s, l) => s + l.qty * l.unit_price_sen, 0), item_discount_sen: lines.reduce((s, l) => s + l.discount_amount_sen, 0), bill_discount_sen: 0, bill_discount_by: null,
    sst_applied: original.sst_applied, sst_rate: original.sst_applied ? original.sst_rate : 0, sst_amount_sen: 0, rounding_sen: 0, total_sen: t.difference_sen,
    status: "PAID", void_reason: null, void_by: null, voided_at: null, is_test: ctx.is_test, local_seq: ctx.counter,
    lines, payments, synced_at: null, sync_error: null, returned: picks.filter((p) => p.qty > 0),
  };
}

export const newUuid = (): string => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
