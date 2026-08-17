/* Self-test corpus for tests/lib/date-write-scan.ts. NOT shipped code — nothing
 * imports it and it is outside backend/src, so the tree scan never sees it.
 *
 * Every shape below is copied from a real route in this repo. The UNSAFE half is
 * what the production 500 looked like; the SAFE half is what the routes that
 * were already right look like. `dateWriteCoercion.test.ts` asserts the scanner
 * finds exactly the four unsafe ones and none of the safe ones — so a scanner
 * that quietly stops matching (CLAUDE.md: "a checker that cannot match reports a
 * clean run") fails here before it can report a clean backend.
 */
/* eslint-disable */
import { z } from 'zod';

declare const sb: any;
declare function todayMyt(): string;
declare function dateOrNull(v: unknown): string | null;
declare function coerceEmptyDates<T extends Record<string, unknown>>(row: T): T;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ── UNSAFE 1: `!== undefined` is not a blank guard ───────────────────────── */
export async function unsafeNamedWrite(body: Record<string, unknown>) {
  const updates: Record<string, unknown> = {};
  if (body.voucherDate !== undefined) updates.voucher_date = body.voucherDate;
  await sb.from('payment_vouchers').update(updates).eq('id', 1);
}

/* ── UNSAFE 2: `??` is NULLISH, so "" survives the fallback ───────────────── */
export async function unsafeNullishFallback(body: Record<string, unknown>) {
  const paidAt = (body.paymentDate as string) ?? todayMyt();
  await sb.from('mfg_sales_order_payments').insert({ so_doc_no: 'X', paid_at: paidAt });
}

/* ── UNSAFE 3: the field-map loop, sent without coerceEmptyDates ──────────── */
export async function unsafeFieldMap(body: Record<string, unknown>) {
  const updates: Record<string, unknown> = {};
  for (const [from, to] of [['notes', 'notes'], ['soDate', 'so_date']] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  await sb.from('mfg_sales_orders').update(updates).eq('doc_no', 'X');
}

/* ── UNSAFE 4: a zod field that permits "" ────────────────────────────────── */
const looseSchema = z.object({ amendDate: z.string().nullable().optional() });
export async function unsafeLooseZod(body: unknown) {
  const p = looseSchema.parse(body);
  await sb.from('mfg_sales_orders').update({ amend_date_from_customer: p.amendDate }).eq('doc_no', 'X');
}

/* ── SAFE: the coercion itself ────────────────────────────────────────────── */
export async function safeCoerced(body: Record<string, unknown>) {
  await sb.from('purchase_orders').update({
    supplier_delivery_date_2: dateOrNull(body.supplierDeliveryDate2),
    expected_at: dateOrNull(body.expectedAt) ?? todayMyt(),
  }).eq('id', 1);
}

/* ── SAFE: "" is falsy, so a truthy guard cannot let it through ───────────── */
export async function safeTruthyGuards(body: Record<string, unknown>) {
  const headerInsert: Record<string, unknown> = {};
  if (body.poDate) headerInsert.po_date = body.poDate;
  headerInsert.transfer_date = (body.transferDate as string) || null;
  headerInsert.take_date = body.takeDate ? body.takeDate : null;
  await sb.from('purchase_orders').insert(headerInsert);
}

/* ── SAFE: a zod field "" cannot satisfy ──────────────────────────────────── */
const strictSchema = z.object({
  paidAt: z.string().min(1),
  startDate: z.string().regex(ISO_DATE),
});
export async function safeStrictZod(body: unknown) {
  const p = strictSchema.parse(body);
  await sb.from('driver_leave').insert({ paid_at: p.paidAt, start_date: p.startDate });
}

/* ── SAFE: the field-map loop, coerced in place before the send ───────────── */
export async function safeFieldMap(body: Record<string, unknown>) {
  const updates: Record<string, unknown> = {};
  for (const [from, to] of [['soDate', 'so_date']] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  coerceEmptyDates(updates);
  await sb.from('mfg_sales_orders').update(updates).eq('doc_no', 'X');
}

/* ── SAFE: a local helper that answers the empty string ───────────────────── */
function dateField(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? { ok: true, value: s } : { ok: false };
}
export async function safeLocalHelper(body: Record<string, unknown>) {
  const d = dateField(body.serviceDate);
  if (!d.ok) return;
  await sb.from('lorry_service_records').update({ service_date: d.value }).eq('id', 1);
}

/* ── SAFE: the handler already refused the blank with a 400 ───────────────── */
export async function safeEarlyReturn(body: Record<string, unknown>) {
  const date = String(body.date ?? '');
  if (!ISO_DATE.test(date)) return { error: 'bad_date' };
  await sb.from('acc_daily_closes').insert({ close_date: date, bucket: 'CASH' });
  return { ok: true };
}

/* ── SAFE: not a date column, and not a database write ────────────────────── */
export async function safeNonDate(body: Record<string, unknown>) {
  await sb.from('mfg_sales_orders').update({ notes: body.notes ?? null }).eq('doc_no', 'X');
  return { rows: [{ date: body.soDate ?? null, so_date: body.soDate ?? null }] };
}
