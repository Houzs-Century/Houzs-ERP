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

/* ── UNSAFE 5: built in a .map() callback, wrapped, inserted separately ───── */
/* po-amendments.ts's shape, and the one the first version of this scanner could
   not see: the row is assembled from a CALLBACK PARAMETER (not a declaration),
   the array is only opened through the variable it was assigned to, and the
   insert hands it to a non-coercer wrapper. All three had to be taught. */
declare function stampCompany<T>(rows: T, c: unknown): T;
export async function unsafeMapCallbackRow(body: { lines?: Array<Record<string, unknown>> }, c: unknown) {
  const submittedLines = Array.isArray(body.lines) ? body.lines : [];
  const lineRows = submittedLines.map((l) => ({
    amendment_id: 'X',
    new_delivery_date: l.newDeliveryDate ?? null,
  }));
  await sb.from('po_amendment_lines').insert(stampCompany(lineRows, c));
}

/* ── SAFE: the same three shapes over a DATABASE read ─────────────────────── */
/* The counter-case that keeps the shape above honest. `it` is the commonest
   callback name in this repo and a route file routinely maps over `body.items`
   in one handler and a `purchase_order_items` read in another — judging by NAME
   reported this copy of one stored row into another as a request write. */
export async function safeDbRowCallbackRow(body: Record<string, unknown>, c: unknown) {
  const it = body.items as Array<Record<string, unknown>>; // same name, request data
  void it;
  const { data } = await sb.from('purchase_order_items').select('*').eq('po_id', 1);
  const itemList = ((data ?? []) as Array<Record<string, unknown>>).filter((r: any) => r.qty > 0);
  const rows = itemList.map((it) => ({
    grn_id: 'X',
    delivery_date: it.delivery_date ?? null,
  }));
  await sb.from('grn_items').insert(stampCompany(rows, c));
}

/* ── UNSAFE 6: `let x; try { x = await c.req.json() }` ────────────────────── */
/* The house 400-on-bad-JSON shape. The binding carries no initializer, so the
   request enters at the ASSIGNMENT; a scanner that only reads initializers sees
   a variable that came from nowhere. */
declare const c: { req: { json(): Promise<unknown> } };
export async function unsafeAssignedAfterDeclare() {
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return; }
  await sb.from('purchase_order_items').insert({ supplier_delivery_date_2: (it.supplierDeliveryDate2 as string) ?? null });
}

/* ── UNSAFE 7: the parsed payload passed on as a typed parameter ──────────── */
/* delivery-planning's two trip-mint paths: the route parses, the helper takes
   `p: z.infer<typeof schema>`. The parameter is not named `body`, and the parse
   happened in another function. */
const tripSchema = z.object({ tripDate: z.string().nullable().optional() });
export async function unsafeInferredParam(p: z.infer<typeof tripSchema>) {
  await sb.from('trips').insert({ trip_no: 'T1', trip_date: p.tripDate ?? todayMyt() });
}

/* ── UNSAFE 8: a for-of head bound to a SIMPLE IDENTIFIER ─────────────────── */
/* `for (const l of body.lines)` — the shape the docstring has always advertised,
   and the one the scope-correct rewrite silently lost: the head is a
   VariableDeclaration as well as a for-of head, so it was bound TWICE, and the
   initializer-less duplicate shadowed the derived one. It survived review because
   the DESTRUCTURED head (UNSAFE 9) kept working, so the shape read as covered.
   Both arms are pinned here: the assignment onto a payload variable and the
   inline object literal. */
export async function unsafeForOfSimpleName(body: { lines?: Array<Record<string, unknown>> }) {
  for (const l of body.lines ?? []) {
    const patch: Record<string, unknown> = {};
    patch.line_delivery_date = (l.deliveryDate as string) ?? null;
    await sb.from('mfg_sales_order_items').update(patch).eq('id', l.id);
    await sb.from('mfg_sales_order_items').update({ due_date: (l.dueDate as string) ?? null }).eq('id', l.id);
  }
}

/* ── UNSAFE 9: the DESTRUCTURED for-of head, kept as the counter-case ──────── */
export async function unsafeForOfDestructured(body: { lines?: Array<Record<string, unknown>> }) {
  for (const { shipDate, id } of body.lines ?? []) {
    await sb.from('mfg_sales_order_items').update({ ship_date: (shipDate as string) ?? null }).eq('id', id);
  }
}

/* ── UNSAFE 10: a row array built by .push(), inserted afterwards ─────────── */
/* takePayload followed the accumulator's DECLARATION, whose initializer is `[]`,
   so nothing in the pushed rows was ever looked at. ~505 `.push({` sites in
   backend/src make this a house construction, not a corner. */
export async function unsafePushedRows(body: { lines?: Array<Record<string, unknown>> }) {
  const rows: Array<Record<string, unknown>> = [];
  for (const { deliveryDate, id } of body.lines ?? []) {
    rows.push({ so_id: id, expected_delivery_date: (deliveryDate as string) ?? null });
  }
  await sb.from('mfg_sales_order_items').insert(rows);
}

/* ── SAFE: the same two shapes over a DATABASE read ───────────────────────── */
/* The counter-case for UNSAFE 8 and 10 both: identical syntax, stored data. */
export async function safeForOfOverDbRead() {
  const { data } = await sb.from('purchase_order_items').select('*').eq('po_id', 1);
  const rows: Array<Record<string, unknown>> = [];
  for (const l of (data ?? []) as Array<Record<string, unknown>>) {
    rows.push({ grn_id: 'X', delivery_date: l.delivery_date ?? null });
    await sb.from('grn_items').update({ received_date: l.received_date ?? null }).eq('id', l.id);
  }
  await sb.from('grn_items').insert(rows);
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
