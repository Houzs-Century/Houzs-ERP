// /payment-vouchers — a standalone "very plain" Payment Voucher (PV).
//
// Port of 2990's apps/api/src/routes/payment-vouchers.ts (migrations 0189 +
// 0202) into Houzs SCM. Phase 1-B, MYR-only: the currency/exchange_rate columns
// are kept but always resolve to MYR / 1 here — no foreign-currency UI (phase A).
//
// A PV pays a vendor that is NOT a goods invoice (freight forwarder, one-off
// service): a payee + a credit account (the bank/cash/AP the money is paid
// FROM) + a few expense lines (description + debit account + amount) + a total
// that posts to the GL. A SUPPLIER_PAYMENT PV can also SETTLE one or more
// Purchase Invoices at face value (pv_allocations → PI paid_centi on post).
//
// GL post (source_type 'PV', mirrors postPiAccounting's JE shape but with
// DYNAMIC legs — the PV's debit accounts + chosen credit account, not the PI's
// fixed Dr 1200 / Cr 2000):
//   Dr each line.debit_account_code   round(amount_centi * exchange_rate)  (MYR)
//   Cr header.credit_account_code      = Σ of those rounded Dr legs          (MYR)
// The credit leg is the SUM of the rounded debit legs so the JE balances
// byte-for-byte even when rounding splits across lines.
//
// Houzs adaptation vs 2990:
//   * tables via the scm-scoped service-role `sb` (snake_case), scm schema.
//   * writes gated with hasHouzsPerm on flat scm.payment_voucher.* keys (2990's
//     scm.staff.role gates are dead — the SCM bridge pins every caller to one
//     super_admin row).
//   * multi-company: company_id stamped on insert (activeCompanyId / stampCompany)
//     + scopeToCompany on the list; JE + JE-lines inherit the PV's company_id.
//   * doc numbers via companyDocPrefix + mintMonthlyDocNo (max+1, self-healing)
//     with insertWithDocNoRetry on the header insert.
//   * FX: the currencies master landed with migration 0082, so a PV carries a real
//     currency + exchange_rate (MYR per 1 unit of it); MYR still defaults to rate 1,
//     a strict no-op.
//
// THE PAYMENT DEFINES THE FX RATE (owner-approved, 2026-07-30). Houzs pays its
// China suppliers BEFORE the goods and the invoice arrive, so the rate is a fact
// about the payment, not a field to maintain. When this voucher's knock-off settles
// a foreign PI that carries no real rate (stored 1 — audit finding R2), the
// voucher's rate is written onto that invoice and recostFromGrn re-costs the GRN
// behind it. An invoice that already carries a DIFFERENT deliberate rate is left
// alone and the disagreement reported. The whole decision lives in
// lib/pv-rate-adoption.ts, pure and unit-tested; see docs/modules/payment-voucher.md.
//
// Idempotent: a post guards on an existing ACTIVE (non-reversed) JE for
// source_type='PV' + the pv_number; a cancel reverses that JE (contra) keyed on
// the original JE's reversed flag — re-cancels / retries no-op.

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { dateOrNull } from '../lib/date-coerce';
import { postJournal, reverseJournal } from '../../acc/engine';
import { pvLines } from '../../acc/rules';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { normalizeCurrency, normalizeExchangeRate, masterRateForCurrency } from '../lib/fx';
import { todayMyt } from '../lib/my-time';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange, assertAuditWritable, auditUnavailableBody } from '../lib/entity-audit';
import { settlePiPaidCenti } from '../lib/pi-settlement';
import { planPvRateAdoption, isRateRetainedFromPv, roundRate6 } from '../lib/pv-rate-adoption';
import { recostFromGrn } from '../lib/recost';

export const paymentVouchers = new Hono<{ Bindings: Env; Variables: Variables }>();
paymentVouchers.use('*', supabaseAuth);

/* The auditable header fields, camel (API) -> snake (column). Money rides as
   total_centi: the INTEGER SEN, never a formatted amount. */
const PV_AUDIT_FIELDS: Array<[string, string]> = [
  ['payeeName', 'payee_name'],
  ['creditAccountCode', 'credit_account_code'],
  ['voucherDate', 'voucher_date'],
  ['supplierId', 'supplier_id'],
  ['notes', 'notes'],
  ['purpose', 'purpose'],
  ['currency', 'currency'],
  ['exchangeRate', 'exchange_rate'],
  ['totalCenti', 'total_centi'],
];

const HEADER =
  'id, pv_number, voucher_date, payee_name, supplier_id, credit_account_code, currency, exchange_rate, purpose, notes, total_centi, status, posted_at, created_at, created_by, updated_at, company_id';

const LINE = 'id, pv_id, line_no, description, debit_account_code, amount_centi, created_at';

/* Migration 0202 — the PV purpose. Only SUPPLIER_PAYMENT settles AP (its
   allocations decrement the linked PIs' paid_centi); FREIGHT / OTHER post the GL
   but touch no PI. Default SUPPLIER_PAYMENT. */
const normalizePurpose = (raw: unknown): 'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER' => {
  const v = String(raw ?? '').trim().toUpperCase();
  return v === 'FREIGHT' || v === 'OTHER' ? v : 'SUPPLIER_PAYMENT';
};

/* FX (migration 0082) — exchange_rate = MYR per 1 unit of the PV currency, and
   the currency auto-fills its rate from the currency MASTER. normalizeCurrency /
   normalizeExchangeRate now come from the shared lib/fx (identical behaviour:
   MYR ⇒ rate 1, a foreign rate must be finite > 0 else 1 — the GL post can never
   be zeroed). */

/* Next PV-YYMM-NNN (company-prefixed). Mirrors the sibling scm minters —
   max(suffix)+1 via mintMonthlyDocNo (self-healing; never count+1). */
const nextPvNo = async (sb: any, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'payment_vouchers', 'pv_number', `${p}PV-${yymm}`);
};

/* ── Money in, from the wire ─────────────────────────────────────────────────
   Returns the integer sen, or null when the caller sent something that is not a
   payable amount.

   The previous shape was `Math.max(0, Math.round(Number(x ?? 0)) || 0)`, which
   is a CLAMP, not a validation: `-500000` and `"abc"` both became a silent `0`.
   The voucher then saved with a header total short by exactly the rejected
   line, returned 200, and told the operator it was fine — the same
   swallow-the-bad-input class HOOKKA hit on its payments route
   (BUG-2026-05-20-002, negative amount accepted). A supplier payment that is
   quietly RM 0 is worse than one that is refused, because nobody goes looking
   for it.

   Sen is an INTEGER by contract, so a fractional input is a unit mistake (RM
   posted into a sen field) and is refused rather than rounded into a number
   nobody meant. Rejecting at the boundary matches the house rule the credit /
   debit-note routes already follow. */
export function parseAmountCenti(raw: unknown): number | null {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return null; // NaN / Infinity — never a payment
  if (!Number.isInteger(n)) return null; // sen is integer; a decimal means RM
  if (n < 0) return null;                // a refund is a different document
  return n;
}

/* ── Normalise + validate the incoming lines, recompute the header total ──── */
export function buildLines(
  raw: unknown,
): { rows: Array<{ line_no: number; description: string | null; debit_account_code: string; amount_centi: number }>; total: number } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'lines_required' };
  const rows: Array<{ line_no: number; description: string | null; debit_account_code: string; amount_centi: number }> = [];
  let total = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] as Record<string, unknown>;
    const debit = (line.debitAccountCode as string | undefined)?.trim();
    const amount = parseAmountCenti(line.amountCenti);
    if (amount === null) return { error: 'line_amount_invalid' };
    rows.push({
      line_no: i + 1,
      description: (line.description as string | undefined)?.trim() || null,
      debit_account_code: debit ?? '',
      amount_centi: amount,
    });
    total += amount;
  }
  if (rows.some((r) => !r.debit_account_code)) return { error: 'debit_account_required' };
  return { rows, total };
}

/* ── Normalise + validate the incoming PV→PI allocations (migration 0202) ──── */
export function buildAllocations(
  raw: unknown,
): { rows: Array<{ pi_id: string; amount_centi: number }>; total: number } | { error: string } {
  if (raw === undefined || raw === null) return { rows: [], total: 0 };
  if (!Array.isArray(raw)) return { error: 'allocations_invalid' };
  const rows: Array<{ pi_id: string; amount_centi: number }> = [];
  let total = 0;
  for (const a of raw) {
    const row = a as Record<string, unknown>;
    const piId = (row.piId as string | undefined)?.trim();
    /* Same reason as buildLines: a negative allocation used to clamp to 0 and
       then get skipped by the `<= 0` continue below, so "apply -RM 500 to this
       PI" silently applied nothing while the voucher still posted. */
    const amount = parseAmountCenti(row.amountCenti);
    if (!piId) return { error: 'allocation_pi_required' };
    if (amount === null) return { error: 'allocation_amount_invalid' };
    if (amount === 0) continue; // an explicit zero settles nothing — drop the row
    rows.push({ pi_id: piId, amount_centi: amount });
    total += amount;
  }
  return { rows, total };
}

/* settlePiPaidCenti moved to lib/pi-settlement, where the clamp that stops two
   vouchers over-paying one invoice lives next to the SQL function that enforces
   it. It used to live here as an optimistic loop whose cap (total − paid) was
   read in the CALLER, one round trip before the write — see the header of
   src/db/migrations-pg/0147_scm_settle_pi_paid_centi.sql for how that
   over-pays. */

/* ── The allocation's pi_id is CALLER-SUPPLIED, so it is checked here ────────
   An allocation row is stamped with the ACTIVE company (stampCompany, below),
   but `piId` arrives in the request body and nothing verified that the invoice
   it names is this company's. Post the voucher and settlePiPaidCenti moves that
   invoice's paid_centi and status by id alone — the service-role client bypasses
   RLS (mig 0061 enabled it with NO policies) — so a company-A voucher marked a
   company-B supplier invoice PARTIALLY_PAID / PAID, and the FX-adoption branch
   further down POST /:id/post could then rewrite that invoice's exchange_rate
   and re-cost the GRN behind it. Company B sees an invoice settle with no
   voucher of its own to explain it.

   Checked where the id ENTERS, not at post time: nothing has been written yet,
   so the operator gets a straight refusal instead of a voucher that silently
   settles nothing. scm.purchase_invoices.company_id is NOT NULL (mig 0083), so
   this filter is exact — an invoice of this company can never fail it.

   FAILS CLOSED on a read error: absence is what REFUSES here, so folding a blip
   into "all present" would authorise exactly the write this guard exists to
   stop. Returns the offending ids. */
async function allocationPisOutsideCompany(
  sb: any,
  c: any,
  piIds: string[],
): Promise<string[]> {
  const ids = [...new Set(piIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const { data, error } = await scopeToCompany(
    sb.from('purchase_invoices').select('id').in('id', ids), c,
  );
  if (error) return ids;
  const seen = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  return ids.filter((id) => !seen.has(id));
}

const ALLOCATION_NOT_THIS_COMPANY = (ids: string[]) => ({
  error: 'allocation_not_in_company',
  message: 'One of the invoices this voucher applies to is not available in the company you are working in.',
  purchaseInvoiceIds: ids.slice(0, 20),
});

/* ────────────────────────────────────────────────────────────────────────
   List / get
   ──────────────────────────────────────────────────────────────────────── */

paymentVouchers.get('/', async (c) => {
  const sb = c.get('supabase');
  let q = sb.from('payment_vouchers')
    .select(`${HEADER}, supplier:suppliers(id, code, name)`)
    .order('voucher_date', { ascending: false })
    // Bound the result so PostgREST's default 1000-row cap can't silently
    // truncate the list — matches the PI/SI/DO list convention.
    .limit(500);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ paymentVouchers: data ?? [] });
});

paymentVouchers.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i, a] = await Promise.all([
    scopeToCompany(sb.from('payment_vouchers').select(`${HEADER}, supplier:suppliers(id, code, name)`).eq('id', id), c).maybeSingle(),
    scopeToCompany(sb.from('payment_voucher_lines').select(LINE).eq('pv_id', id), c).order('line_no'),
    /* PV→PI settlement (0202) — the PIs this PV applies to, joined for the PI
       number + the live total/paid so the detail page can show "Apply to PI". */
    scopeToCompany(sb.from('pv_allocations')
      .select('id, amount_centi, pi:purchase_invoices(id, invoice_number, supplier_invoice_ref, currency, total_centi, paid_centi, status)')
      .eq('pv_id', id), c),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Flatten the joined PI (Supabase returns a to-one FK as an array). */
  const allocations = ((a.data ?? []) as Array<{
    id: string; amount_centi: number;
    pi: { id: string; invoice_number: string; supplier_invoice_ref: string | null; currency: string | null; total_centi: number; paid_centi: number; status: string }
      | Array<{ id: string; invoice_number: string; supplier_invoice_ref: string | null; currency: string | null; total_centi: number; paid_centi: number; status: string }> | null;
  }>).map((row) => {
    const pi = Array.isArray(row.pi) ? row.pi[0] : row.pi;
    return {
      id: row.id,
      amountCenti: Number(row.amount_centi ?? 0),
      piId: pi?.id ?? null,
      invoiceNumber: pi?.invoice_number ?? null,
      supplierInvoiceRef: pi?.supplier_invoice_ref ?? null,
      currency: pi?.currency ?? null,
      totalCenti: pi ? Number(pi.total_centi ?? 0) : null,
      paidCenti: pi ? Number(pi.paid_centi ?? 0) : null,
      status: pi?.status ?? null,
    };
  });
  return c.json({ paymentVoucher: h.data, lines: i.data ?? [], allocations });
});

/* ────────────────────────────────────────────────────────────────────────
   Create (DRAFT)
   ──────────────────────────────────────────────────────────────────────── */

/* Exported for the same reason postPaymentVoucherHandler and
   cancelPaymentVoucherHandler are: the supabaseAuth bridge cannot run in the
   vitest harness, so the scope test mounts the handler on a bare Hono app. */
export const createPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const payeeName = (body.payeeName as string | undefined)?.trim();
  if (!payeeName) return c.json({ error: 'payee_required' }, 400);
  const creditAccountCode = (body.creditAccountCode as string | undefined)?.trim();
  if (!creditAccountCode) return c.json({ error: 'credit_account_required' }, 400);

  const built = buildLines(body.lines);
  if ('error' in built) return c.json({ error: built.error }, 400);

  // PV→PI settlement (migration 0202) — optional allocations + purpose.
  const allocBuilt = buildAllocations(body.allocations);
  if ('error' in allocBuilt) return c.json({ error: allocBuilt.error }, 400);
  const purpose = normalizePurpose(body.purpose);
  // Guard: Σ allocations ≤ PV total (you can't apply more than the voucher pays).
  if (allocBuilt.total > built.total) {
    return c.json({ error: 'allocations_exceed_total', allocated: allocBuilt.total, total: built.total }, 400);
  }

  const sb = c.get('supabase'); const user = c.get('user');

  // Every applied-to invoice must be THIS company's — see allocationPisOutsideCompany.
  {
    const outside = await allocationPisOutsideCompany(sb, c, allocBuilt.rows.map((r) => r.pi_id));
    if (outside.length > 0) return c.json(ALLOCATION_NOT_THIS_COMPANY(outside), 404);
  }
  const currency = normalizeCurrency(body.currency);
  /* Migration 0082 — the rate auto-fills from the currency MASTER (rate_to_myr)
     unless the body sends an explicit one; MYR ⇒ 1, a strict no-op. */
  const pvRateRaw = body.exchangeRate !== undefined && body.exchangeRate !== null
    ? body.exchangeRate
    : await masterRateForCurrency(sb, currency);
  const exchangeRate = normalizeExchangeRate(pvRateRaw, currency);

  /* Asked BEFORE the first write, not at the recordEntityAudit call below: that
     one runs after the voucher exists, where "please try again" would be a lie
     the operator acts on. Refusing here is the only point at which nothing has
     yet moved. */
  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; pv_number: string }>(
    () => nextPvNo(sb, c),
    (pvNumber) => sb.from('payment_vouchers').insert({
      company_id:          activeCompanyId(c), // multi-company: stamp the active company
      pv_number:           pvNumber,
      voucher_date:        dateOrNull(body.voucherDate) ?? todayMyt(),
      payee_name:          payeeName,
      supplier_id:         (body.supplierId as string | undefined) ?? null,
      credit_account_code: creditAccountCode,
      currency,
      exchange_rate:       exchangeRate,
      purpose,
      notes:               (body.notes as string | undefined) ?? null,
      total_centi:         built.total,
      status:              'DRAFT',
      created_by:          user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; pv_number: string };
  const auditActor = c.get('houzsUser');

  const rowsWithId = built.rows.map((r) => ({ ...r, pv_id: h.id }));
  const { error: lErr } = await sb.from('payment_voucher_lines').insert(stampCompany(rowsWithId, c));
  if (lErr) { await sb.from('payment_vouchers').delete().eq('id', h.id); return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500); }

  // PV→PI settlement links (0202) — persist the allocations (compensating-delete
  // the whole PV on failure). They settle paid_centi only on POST, not here.
  if (allocBuilt.rows.length > 0) {
    const allocRows = allocBuilt.rows.map((r) => ({ ...r, pv_id: h.id }));
    const { error: aErr } = await sb.from('pv_allocations').insert(stampCompany(allocRows, c));
    if (aErr) { await sb.from('payment_vouchers').delete().eq('id', h.id); return c.json({ error: 'allocations_insert_failed', reason: aErr.message }, 500); }
  }

  /* Recorded only after every compensating-delete path above is behind us, so
     the log never claims a voucher that was rolled back. */
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER',
    entityId: h.id,
    entityDocNo: h.pv_number,
    action: 'CREATE',
    actor: auditActor,
    companyId: activeCompanyId(c),
    statusSnapshot: 'DRAFT',
    fieldChanges: compactChanges([
      fieldChange('payeeName', null, payeeName),
      fieldChange('creditAccountCode', null, creditAccountCode),
      fieldChange('purpose', null, purpose),
      fieldChange('currency', null, currency),
      fieldChange('exchangeRate', null, exchangeRate),
      fieldChange('totalCenti', null, built.total),
      fieldChange('lineCount', null, built.rows.length),
      fieldChange('allocatedCenti', null, allocBuilt.total),
    ]),
  });

  return c.json({ id: h.id, pvNumber: h.pv_number }, 201);
};
paymentVouchers.post('/', createPaymentVoucherHandler);

/* ────────────────────────────────────────────────────────────────────────
   Update — DRAFT only (a POSTED / CANCELLED voucher is read-only)
   ──────────────────────────────────────────────────────────────────────── */

paymentVouchers.patch('/:id', async (c) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

  /* The FULL header, not just status: this row is the BEFORE half of every
     from->to pair recorded at the end of the handler. Reading it here also
     removes the second round-trip the currency branch used to make. */
  /* Company scope. This was an unscoped `.eq('id', id)`, so a holder of the
     cross-company `scm.payment_voucher.write` permission could edit ANOTHER
     company's DRAFT voucher - payee, amount, currency, lines. The sibling
     cancel handler in this same file already does exactly this and its comment
     names the class ('an unscoped load let one company cancel another's
     voucher'); the PATCH was never aligned. Found 2026-08-13 by a scanner over
     all 632 SCM handlers, then read here before changing anything. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(
    sb.from('payment_vouchers').select(HEADER).eq('id', id), co.companyId,
  ).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const before = cur as unknown as Record<string, unknown>;
  if ((before as { status: string }).status !== 'DRAFT') {
    return c.json({ error: 'not_editable', message: 'Only a DRAFT voucher can be edited' }, 409);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.payeeName !== undefined) {
    const v = String(body.payeeName).trim();
    if (!v) return c.json({ error: 'payee_required' }, 400);
    updates.payee_name = v;
  }
  if (body.creditAccountCode !== undefined) {
    const v = String(body.creditAccountCode).trim();
    if (!v) return c.json({ error: 'credit_account_required' }, 400);
    updates.credit_account_code = v;
  }
  if (body.voucherDate !== undefined) updates.voucher_date = body.voucherDate;
  if (body.supplierId !== undefined) updates.supplier_id = (body.supplierId as string | null) || null;
  if (body.notes !== undefined) updates.notes = (body.notes as string | null) ?? null;
  // PV→PI settlement (0202) — purpose is editable while DRAFT.
  if (body.purpose !== undefined) updates.purpose = normalizePurpose(body.purpose);

  // Effective currency = the new currency if set, else the stored one — so the
  // exchange_rate stays consistent (MYR-only today → 1).
  let effectiveCurrency: string | undefined = body.currency !== undefined ? normalizeCurrency(body.currency) : undefined;
  if (body.currency !== undefined) updates.currency = effectiveCurrency;
  if (body.exchangeRate !== undefined || updates.currency !== undefined) {
    if (effectiveCurrency === undefined) {
      effectiveCurrency = (before.currency as string | null) ?? 'MYR';
    }
    if (body.exchangeRate !== undefined) {
      updates.exchange_rate = normalizeExchangeRate(body.exchangeRate, effectiveCurrency);
    } else if (String(effectiveCurrency).toUpperCase() === 'MYR') {
      updates.exchange_rate = 1;
    }
  }

  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', entityId: id, action: 'UPDATE', companyId: (before.company_id as number | null) ?? null });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  // Lines (optional) — full replace + recompute total when supplied.
  let newTotal: number | undefined;
  if (body.lines !== undefined) {
    const built = buildLines(body.lines);
    if ('error' in built) return c.json({ error: built.error }, 400);
    await sb.from('payment_voucher_lines').delete().eq('pv_id', id);
    const { error: lErr } = await sb.from('payment_voucher_lines').insert(stampCompany(built.rows.map((r) => ({ ...r, pv_id: id })), c));
    if (lErr) return c.json({ error: 'lines_update_failed', reason: lErr.message }, 500);
    updates.total_centi = built.total;
    newTotal = built.total;
  }

  // Allocations (optional, 0202) — full replace. Σ ≤ the effective PV total.
  if (body.allocations !== undefined) {
    const allocBuilt = buildAllocations(body.allocations);
    if ('error' in allocBuilt) return c.json({ error: allocBuilt.error }, 400);
    /* total_centi is NOT NULL on a row we have already read, so this is the real
       stored total — not a `?? 0` standing in for an unknown one. */
    const total = newTotal ?? Number(before.total_centi);
    if (allocBuilt.total > total) {
      return c.json({ error: 'allocations_exceed_total', allocated: allocBuilt.total, total }, 400);
    }
    /* Same check as the create path, and it has to be here too: a DRAFT edit is
       the other door the caller-supplied pi_id comes through, and it REPLACES
       the whole allocation set. Refused before the delete, so a rejected edit
       cannot leave the voucher with no allocations at all. */
    {
      const outside = await allocationPisOutsideCompany(sb, c, allocBuilt.rows.map((r) => r.pi_id));
      if (outside.length > 0) return c.json(ALLOCATION_NOT_THIS_COMPANY(outside), 404);
    }
    await sb.from('pv_allocations').delete().eq('pv_id', id);
    if (allocBuilt.rows.length > 0) {
      const { error: aErr } = await sb.from('pv_allocations').insert(stampCompany(allocBuilt.rows.map((r) => ({ ...r, pv_id: id })), c));
      if (aErr) return c.json({ error: 'allocations_update_failed', reason: aErr.message }, 500);
    }
  }

  const { data, error } = await sb.from('payment_vouchers').update(updates).eq('id', id).select(HEADER).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  /* Diff the NORMALISED values actually written (updates), not the raw body:
     purpose/currency/exchangeRate are all coerced above, and a log of what the
     client asked for rather than what was stored is a log of the wrong thing. */
  const auditPatch: Record<string, unknown> = {};
  for (const [camel, snake] of PV_AUDIT_FIELDS) {
    if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
  }
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER',
    entityId: id,
    entityDocNo: (before.pv_number as string | null) ?? null,
    action: 'UPDATE',
    actor: c.get('houzsUser'),
    companyId: (before.company_id as number | null) ?? null,
    statusSnapshot: (before.status as string | null) ?? null,
    fieldChanges: diffFields(before, auditPatch, PV_AUDIT_FIELDS),
  });

  return c.json({ paymentVoucher: data });
});

/* ────────────────────────────────────────────────────────────────────────
   POST /:id/post — write the balanced GL entry, flip DRAFT → POSTED
   ──────────────────────────────────────────────────────────────────────── */

/* Exported for the same reason cancelPaymentVoucherHandler is: the supabaseAuth
   bridge cannot run in the vitest harness, so the tests mount the handler on a bare
   Hono app with a fake PostgREST client (precedent: tests/companyScopeHardening.test.ts). */
export const postPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const sb = c.get('supabase'); const id = c.req.param('id');

  /* Scoped before the load. POSTING is a write, and the service-role client
     bypasses RLS (mig 0061 enabled it with NO policies), so an app-level
     predicate is the ONLY isolation there is. Everything downstream keys off
     this row — the GL entry is written from pv.pv_number, pv.credit_account_code
     and pv.company_id — so an unscoped load let one company POST another
     company's voucher and stamp a journal entry into that company's ledger. The
     GET at :208 and cancelPaymentVoucherHandler both already scoped it; post is
     the same door and was the one left unlocked.

     Found twice independently — by this audit and by #2086 — which is why the
     merge of the two kept the shared NOT_THIS_COMPANY refusal rather than a
     second bespoke `not_found` shape. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: pvRaw } = await scopeToCompanyId(sb.from('payment_vouchers')
    .select(`${HEADER}, supplier:suppliers(code, name)`).eq('id', id), co.companyId).maybeSingle();
  if (!pvRaw) return c.json(NOT_THIS_COMPANY, 404);
  const pv = pvRaw as unknown as {
    id: string; pv_number: string; voucher_date: string; payee_name: string;
    credit_account_code: string; total_centi: number; currency: string | null;
    exchange_rate: string | number | null; status: string; purpose: string | null;
    company_id: number | null;
    supplier: { code: string | null; name: string | null } | null;
  };
  if (pv.status === 'CANCELLED') return c.json({ error: 'cannot_post', message: 'Voucher is cancelled' }, 409);

  // Idempotency — an ACTIVE (non-reversed) PV JE already exists? (mirror
  // postPiAccounting). Flip POSTED + echo without re-writing the GL.
  /* The error is READ, not dropped. This is the idempotency check: if the
     query fails, `existingRows` is undefined, `?? []` turns that into "no
     journal entry exists", and the handler goes on to post a SECOND one
     against the same voucher. A failed read must never read as an absence
     when the absence is what authorises the write.

     Scoped as well — a pv_number is unique per company, so an unscoped lookup
     could match the other company's JE and skip a posting that never happened
     here. */
  const { data: existingRows, error: existingErr } = await scopeToCompanyId(sb.from('journal_entries')
    .select('id, je_no, reversed').eq('source_type', 'PV').eq('source_doc_no', pv.pv_number), co.companyId);
  if (existingErr) {
    return c.json({ error: 'post_failed', message: `Could not check whether this voucher is already posted: ${existingErr.message}` }, 500);
  }
  const active = ((existingRows ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>).find((r) => !r.reversed);
  if (active) {
    if (pv.status !== 'POSTED') {
      await scopeToCompanyId(sb.from('payment_vouchers')
        .update({ status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id), co.companyId);
    }
    return c.json({ ok: true, alreadyPosted: true, jeNo: active.je_no, jeId: active.id });
  }

  const { data: linesRaw } = await sb.from('payment_voucher_lines')
    .select('line_no, description, debit_account_code, amount_centi').eq('pv_id', id).order('line_no');
  const lines = (linesRaw ?? []) as Array<{ line_no: number; description: string | null; debit_account_code: string; amount_centi: number }>;
  if (lines.length === 0) return c.json({ error: 'no_lines', message: 'Voucher has no lines to post' }, 400);

  /* FX conversion AT POST TIME (MYR-only today → rate 1). Each Dr leg =
     round(line.amount * rate); the single Cr leg = Σ of those rounded Dr legs,
     so the JE balances exactly regardless of per-line rounding. */
  const rawRate = Number(pv.exchange_rate ?? 1);
  const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
  const debitLegs = lines.map((l) => ({ ...l, myrSen: Math.round(Number(l.amount_centi) * rate) }));
  const totalSen = debitLegs.reduce((s, l) => s + l.myrSen, 0);  // MYR amount posted to the GL
  if (totalSen <= 0) return c.json({ error: 'zero_total', message: 'Voucher total is zero' }, 400);

  const supplier = pv.supplier ?? { code: null, name: null };
  // Multi-company (mig 0061/0081): the JE + its lines belong to the PV's company.
  const companyId = pv.company_id ?? null;

  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', entityId: id, action: 'POST', companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  /* Through the ONE gate (acc/engine). rules.pvLines builds the entry — Dr
     each expense/charge line, Cr the header's bank/cash/AP account, payee
     stamped on the credit leg — and the engine owns numbering, validation and
     the write sequence. The scoped already-posted check above stays as the
     handler's own guard (it also heals the PV status flag); the engine's
     internal guard is the second net, and the acc_je_one_active_source index
     is the third. */
  const r = await postJournal(sb, {
    companyId,
    entryDate: pv.voucher_date,
    sourceType: 'PV',
    sourceDocNo: pv.pv_number,
    narration: `Payment voucher ${pv.pv_number} — ${pv.payee_name}`,
    lines: pvLines(pv, debitLegs, supplier),
  });
  if (!r.ok) {
    if (r.status === 'je_insert_failed') return c.json({ error: 'je_insert_failed', reason: r.reason }, 500);
    if (r.status === 'lines_insert_failed') return c.json({ error: 'lines_insert_failed', reason: r.reason }, 500);
    return c.json({ error: 'post_failed', reason: r.reason ?? r.status }, 500);
  }
  const je = { id: r.jeId, je_no: r.jeNo };

  await sb.from('payment_vouchers').update({
    status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id);

  /* The money-out event. Recorded here rather than after the PI settlement loop
     below so a settlement hiccup cannot cost us the record that the GL was
     posted — the JE exists from this point regardless. totalSen is the INTEGER
     SEN posted to the ledger. */
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER',
    entityId: id,
    entityDocNo: pv.pv_number,
    action: 'POST',
    actor: c.get('houzsUser'),
    companyId,
    statusSnapshot: 'POSTED',
    note: `GL entry ${je.je_no}`,
    fieldChanges: compactChanges([
      ...statusChange(pv.status, 'POSTED'),
      fieldChange('jeNo', null, je.je_no),
      fieldChange('creditAccountCode', null, pv.credit_account_code),
      fieldChange('postedTotalSen', null, totalSen),
    ]),
  });

  /* PV→PI settlement (migration 0202) — a SUPPLIER_PAYMENT PV decrements each
     linked PI's paid_centi at FACE VALUE. Runs EXACTLY ONCE (the active-JE
     idempotency guard above early-returns on a re-post). Cap each allocation at
     the PI's remaining outstanding. Best-effort. FREIGHT / OTHER settle nothing. */
  const overAllocated: string[] = [];
  /* "The payment defines the FX rate" (owner, 2026-07-30) — see lib/pv-rate-adoption.
     rateAdopted names the invoices whose un-rated foreign rate this payment filled
     in (and whose GRN was therefore re-costed); rateMismatch names the ones that
     already carried a DIFFERENT deliberate rate and were LEFT ALONE. Both are
     handed back to the caller for the same reason overAllocated is: they are money
     facts an operator has to be able to see, not implementation detail. */
  const rateAdopted: string[] = [];
  const rateMismatch: string[] = [];
  if (normalizePurpose(pv.purpose) === 'SUPPLIER_PAYMENT') {
    const { data: allocs } = await sb.from('pv_allocations')
      .select('id, pi_id, amount_centi').eq('pv_id', id);
    for (const a of (allocs ?? []) as Array<{ id: string; pi_id: string; amount_centi: number }>) {
      const want = Math.max(0, Number(a.amount_centi ?? 0));
      if (want <= 0) continue;
      /* The full allocation goes to settlePiPaidCenti and the CAP is applied by
         the database, at write time, against the row as it then stands. This
         used to read the PI here, compute `outstanding = total - paid`, and cap
         the allocation itself — a cap that a second voucher settling the same
         invoice made stale before this one wrote, so both applied their full
         share and the invoice ended up paid twice over. The DRAFT/CANCELLED
         skip moved into the same call for the same reason: it was a separate
         read of a value that could change underneath it. */
      const settled = await settlePiPaidCenti(sb, a.pi_id, want);
      /* Record EXACTLY what was applied — not what was asked for. A later
         cancel reverses this figure, so recording the request after the
         database clamped it smaller would un-apply money that never moved,
         swapping an over-payment for an under-payment. */
      await sb.from('pv_allocations').update({ applied_centi: settled.appliedCenti }).eq('id', a.id);

      /* A clamp is a real event, not an implementation detail: somebody tried
         to pay a supplier more than the invoice asks for, and the difference
         did NOT go onto the invoice. Absorbing that silently would replace the
         over-payment lie with a "your voucher settled in full" lie, so it is
         logged and handed back to the caller. The voucher itself stays POSTED —
         the GL entry above is correct and already committed, and the money did
         leave; what is in question is only how much of it this invoice
         absorbed. */
      if (settled.clampedCenti > 0) {
        /* eslint-disable-next-line no-console */
        console.error('[pv-settle-pi] allocation exceeded the invoice outstanding — clamped:',
          pv.pv_number, 'pi', a.pi_id, 'requested', want, 'applied', settled.appliedCenti);
        overAllocated.push(`${a.pi_id}: asked ${want} sen, applied ${settled.appliedCenti} sen`);
      }
      if (!settled.ok) {
        /* eslint-disable-next-line no-console */
        console.error('[pv-settle-pi] settlement failed — PI left unsettled:', pv.pv_number, 'pi', a.pi_id, settled.reason);
      }

      /* ── THE PAYMENT DEFINES THE FX RATE (owner-approved, 2026-07-30) ────────
         The knock-off is the moment the true MYR-per-foreign-unit figure becomes
         known, so it is the moment an un-rated foreign invoice gets its rate and
         its GRN gets re-costed. The whole decision is in planPvRateAdoption, which
         is pure — see lib/pv-rate-adoption.ts for the table and the reasoning.

         BEST-EFFORT BY CONTRACT, and this is not a preference. By the time we are
         here the journal entry is committed and the money has left the bank; there
         is no transaction to roll back into and nothing about a costing refresh
         justifies 500-ing a payment that already happened. So every failure below
         is logged and stepped over, exactly as the settle failure above is. */
      if (settled.appliedCenti > 0) {
        try {
          const { data: piRaw } = await sb.from('purchase_invoices')
            .select('id, invoice_number, currency, exchange_rate, grn_id').eq('id', a.pi_id).maybeSingle();
          const piRow = piRaw as {
            id: string; invoice_number: string | null; currency: string | null;
            exchange_rate: string | number | null; grn_id: string | null;
          } | null;
          if (piRow) {
            const plan = planPvRateAdoption({
              appliedCenti: settled.appliedCenti,
              pvCurrency: pv.currency,
              pvExchangeRate: pv.exchange_rate,
              pi: {
                piId: piRow.id,
                docNo: piRow.invoice_number,
                currency: piRow.currency,
                exchangeRate: piRow.exchange_rate,
                grnId: piRow.grn_id,
              },
            });
            const piLabel = piRow.invoice_number ?? a.pi_id;

            if (plan.action === 'adopt') {
              const { error: rateErr } = await sb.from('purchase_invoices')
                .update({ exchange_rate: plan.rate, updated_at: new Date().toISOString() })
                .eq('id', a.pi_id);
              if (rateErr) {
                /* eslint-disable-next-line no-console */
                console.error('[pv-fx-rate] rate adoption write failed — invoice left un-rated:',
                  pv.pv_number, 'pi', piLabel, rateErr.message);
              } else {
                rateAdopted.push(`${piLabel}: rate ${plan.oldRate} -> ${plan.rate} (from ${pv.pv_number})`);
                /* Audited against the PURCHASE INVOICE, not the voucher: the invoice
                   is the row that changed, so this is where "who changed this PI's
                   rate and on what evidence" belongs. The note carries the voucher
                   number — the evidence itself. NOTE: the PI detail page does not
                   mount EntityHistoryPanel yet (only GRN / PV / stock take / stock
                   transfer do), so this row is correct by data model but not yet
                   READABLE — which is why the voucher-side summary row below exists
                   as well. A PI History drawer is the obvious follow-up. */
                await recordEntityAudit(sb, {
                  entityType: 'PURCHASE_INVOICE',
                  entityId: a.pi_id,
                  entityDocNo: piRow.invoice_number ?? null,
                  action: 'UPDATE',
                  actor: c.get('houzsUser'),
                  companyId,
                  note: `Exchange rate adopted from payment voucher ${pv.pv_number}`,
                  fieldChanges: compactChanges([
                    fieldChange('exchangeRate', plan.oldRate, plan.rate),
                    fieldChange('currency', null, normalizeCurrency(piRow.currency)),
                    fieldChange('rateSourcePv', null, pv.pv_number),
                    fieldChange('appliedCenti', null, settled.appliedCenti),
                  ]),
                });
                /* Re-cost the GRN this invoice bills so the corrected rate reaches
                   the FIFO lot and cascades to consumptions / DO lines / SI lines.
                   Its own try/catch: recostFromGrn is best-effort internally, but a
                   throw here must not escape into the payment's response. */
                if (plan.grnId) {
                  try {
                    await recostFromGrn(sb, plan.grnId);
                  } catch (e) {
                    /* eslint-disable-next-line no-console */
                    console.error('[pv-fx-rate] recost after rate adoption failed — rate stored, lots stale:',
                      pv.pv_number, 'pi', piLabel, 'grn', plan.grnId, e);
                  }
                }
              }
            } else if (plan.action === 'report_mismatch') {
              /* The invoice carries a rate somebody entered on purpose that
                 disagrees with what was actually paid. Overwriting it is a policy
                 call the owner has not made, and a partial payment at a second rate
                 is legitimate — so the invoice is left exactly as it is, and the
                 disagreement is surfaced instead of resolved. */
              /* eslint-disable-next-line no-console */
              console.error('[pv-fx-rate] invoice rate differs from the payment rate — invoice LEFT UNCHANGED:',
                pv.pv_number, 'pi', piLabel, 'invoice rate', plan.piRate, 'payment rate', plan.pvRate);
              rateMismatch.push(`${piLabel}: invoice rate ${plan.piRate}, payment rate ${plan.pvRate} — invoice rate kept`);
            }
          }
        } catch (e) {
          /* eslint-disable-next-line no-console */
          console.error('[pv-fx-rate] rate adoption skipped after an unexpected failure — payment stands:',
            pv.pv_number, 'pi', a.pi_id, e);
        }
      }
    }
  }

  /* A SECOND audit row, on the VOUCHER this time, summarising the rate work.
     Not a duplicate of the per-invoice rows above, and needed for a practical
     reason: the Purchase Invoice detail page has no History drawer yet (only GRN,
     PV, stock take and stock transfer mount EntityHistoryPanel), so the invoice-side
     rows are recorded correctly but not yet READABLE. The voucher's own History is
     where the owner will look, and "this payment set the rate on PI-x" belongs there
     regardless — the voucher is the evidence. Written after the loop because it
     summarises it; the POST row above is untouched so a settlement hiccup can still
     never cost us the record that the GL posted. */
  if (rateAdopted.length > 0 || rateMismatch.length > 0) {
    await recordEntityAudit(sb, {
      entityType: 'PAYMENT_VOUCHER',
      entityId: id,
      entityDocNo: pv.pv_number,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId,
      statusSnapshot: 'POSTED',
      note: 'Exchange rate propagated from this payment to the invoices it settled',
      fieldChanges: compactChanges([
        fieldChange('currency', null, normalizeCurrency(pv.currency)),
        fieldChange('exchangeRate', null, roundRate6(pv.exchange_rate)),
        fieldChange('fxRateAdoptedOnPi', null, rateAdopted.length > 0 ? rateAdopted.join('; ') : null),
        fieldChange('fxRateMismatchOnPi', null, rateMismatch.length > 0 ? rateMismatch.join('; ') : null),
      ]),
    });
  }

  return c.json({
    ok: true, jeNo: je.je_no, jeId: je.id, totalSen,
    ...(overAllocated.length > 0 ? { overAllocated } : {}),
    ...(rateAdopted.length > 0 ? { rateAdopted } : {}),
    ...(rateMismatch.length > 0 ? { rateMismatch } : {}),
  });
};
paymentVouchers.post('/:id/post', postPaymentVoucherHandler);

/* ────────────────────────────────────────────────────────────────────────
   POST /:id/cancel — reverse the JE (if posted), flip → CANCELLED.
   ──────────────────────────────────────────────────────────────────────── */

export const cancelPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const sb = c.get('supabase'); const id = c.req.param('id');

  /* Scoped before the load: everything downstream keys off what this returns —
     the GL reversal (by pv_number) and the PV→PI settlement unwind (by pv_id) —
     so an unscoped load let one company cancel another's voucher AND reverse
     its ledger entry. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(
    /* currency + exchange_rate join the select for the FX-rate retention notice at
       the end of this handler — the voucher's own rate is what identifies the
       invoices whose rate it established. */
    sb.from('payment_vouchers').select('id, status, pv_number, purpose, currency, exchange_rate, company_id').eq('id', id), co.companyId,
  ).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const head = cur as {
    id: string; status: string; pv_number: string; purpose: string | null;
    currency: string | null; exchange_rate: string | number | null; company_id: number | null;
  };
  // Idempotent — already cancelled, echo back.
  if (head.status === 'CANCELLED') return c.json({ paymentVoucher: { id, status: 'CANCELLED' } });

  /* One probe covers BOTH history rows this handler writes (the CANCEL and the
     REVERSE): they share a sink, and past this point the flip has happened, so a
     second check further down could only report a failure it can no longer undo. */
  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', entityId: id, action: 'CANCEL' });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  /* ATOMIC ACTIVE→CANCELLED — the conditional UPDATE excludes CANCELLED, so two
     concurrent cancels race and only ONE flips it (the other gets no row back →
     idempotent no-op). Guarantees the reversal below runs at most once. */
  const { data, error } = await scopeToCompanyId(sb.from('payment_vouchers').update({
    status: 'CANCELLED', updated_at: new Date().toISOString(),
  }).eq('id', id), co.companyId).neq('status', 'CANCELLED').select('id, status, pv_number').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) {
    const { data: now } = await scopeToCompanyId(
      sb.from('payment_vouchers').select('id, status').eq('id', id), co.companyId,
    ).maybeSingle();
    if ((now as { status: string } | null)?.status === 'CANCELLED') return c.json({ paymentVoucher: now });
    return c.json({ error: 'cannot_cancel' }, 409);
  }
  const cancelled = data as { id: string; status: string; pv_number: string };

  /* Recorded immediately after the ATOMIC flip won the race, so exactly one
     CANCEL row is ever written for a voucher — the losing concurrent call
     early-returned above and never reaches here. */
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER',
    entityId: id,
    entityDocNo: cancelled.pv_number,
    action: 'CANCEL',
    actor: c.get('houzsUser'),
    statusSnapshot: 'CANCELLED',
    fieldChanges: statusChange(head.status, 'CANCELLED'),
  });

  // Reverse the GL post if one exists. Best-effort (audit-DLQ): a reversal
  // failure never un-cancels the voucher; the contra is idempotent.
  const rev = await reversePvAccounting(sb, cancelled.pv_number);
  if (!rev.ok) {
    // eslint-disable-next-line no-console
    console.error(`[pv-accounting] reversal failed for ${cancelled.pv_number}:`, rev.status, rev.reason);
  }
  /* A SEPARATE row from the CANCEL above, not a duplicate of it: the cancel is a
     document-status event, this is a LEDGER event with its own JE number, and a
     cancel whose reversal failed must be distinguishable from one whose
     reversal landed. `rev.status` carries which of the two happened. */
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER',
    entityId: id,
    entityDocNo: cancelled.pv_number,
    action: 'REVERSE',
    actor: c.get('houzsUser'),
    statusSnapshot: 'CANCELLED',
    note: rev.ok ? `GL reversal: ${rev.status}` : `GL reversal FAILED: ${rev.status} — ${rev.reason ?? 'no reason given'}`,
    fieldChanges: compactChanges([
      fieldChange('reversalJeNo', null, rev.jeNo ?? null),
      fieldChange('reversalOk', null, rev.ok),
    ]),
  });

  /* PV→PI settlement reversal (0202) — un-apply what this PV settled. Decrement
     each linked PI's paid_centi by the EXACT applied_centi recorded at post.
     Only a SUPPLIER_PAYMENT PV ever moved paid_centi. Best-effort. */
  /* FX-RATE RETENTION on cancel (2026-07-30) — the invoices still carrying the rate
     this voucher established, named so the History panel says so out loud. See
     lib/pv-rate-adoption.ts (isRateRetainedFromPv) for WHY the rate and the re-cost
     are deliberately NOT reverted: the only value to revert to is 1, which is the
     R2 mis-cost itself, so "undoing" it would knowingly push a 1:1 foreign basis
     back through every lot, DO and SI the recost had corrected. */
  const fxRateRetained: string[] = [];
  if (normalizePurpose(head.purpose) === 'SUPPLIER_PAYMENT') {
    const { data: allocs } = await sb.from('pv_allocations')
      .select('id, pi_id, applied_centi').eq('pv_id', id);
    for (const a of (allocs ?? []) as Array<{ id: string; pi_id: string; applied_centi: number }>) {
      const applied = Math.max(0, Number(a.applied_centi ?? 0));
      if (applied <= 0) continue;

      /* Read BEFORE the reversal: the settle moves paid_centi and status, never the
         rate, but reading first keeps this notice about the state the operator was
         looking at when they pressed Cancel. */
      try {
        const { data: piRaw } = await sb.from('purchase_invoices')
          .select('invoice_number, currency, exchange_rate').eq('id', a.pi_id).maybeSingle();
        const piRow = piRaw as { invoice_number: string | null; currency: string | null; exchange_rate: string | number | null } | null;
        if (piRow && isRateRetainedFromPv({
          pvCurrency: head.currency,
          pvExchangeRate: head.exchange_rate,
          piCurrency: piRow.currency,
          piExchangeRate: piRow.exchange_rate,
        })) {
          const piLabel = piRow.invoice_number ?? a.pi_id;
          fxRateRetained.push(`${piLabel}: rate ${roundRate6(piRow.exchange_rate)} kept`);
          /* On the INVOICE's own history, because that is where a reader who saw
             "rate adopted from PV-xxxx" will go looking when the voucher is
             cancelled. Silence there reads as "the rate went back". */
          await recordEntityAudit(sb, {
            entityType: 'PURCHASE_INVOICE',
            entityId: a.pi_id,
            entityDocNo: piRow.invoice_number ?? null,
            action: 'UPDATE',
            actor: c.get('houzsUser'),
            companyId: head.company_id ?? null,
            note: `Payment voucher ${cancelled.pv_number} cancelled — the exchange rate it established is RETAINED and inventory is not re-costed back`,
            /* NOT recorded as an exchangeRate from->to pair: nothing moved, and
               fieldChange collapses an equal pair to null anyway. The point of this
               row is that the value STAYED, so it is recorded as its own field. */
            fieldChanges: compactChanges([
              fieldChange('exchangeRateRetained', null, roundRate6(piRow.exchange_rate)),
              fieldChange('fxRateRetainedFromPv', null, cancelled.pv_number),
            ]),
          });
        }
      } catch (e) {
        /* eslint-disable-next-line no-console */
        console.error('[pv-fx-rate] retention notice skipped — cancel continues:', cancelled.pv_number, 'pi', a.pi_id, e);
      }

      const reversed = await settlePiPaidCenti(sb, a.pi_id, -applied);
      /* Only zero the allocation when the reversal actually landed. Clearing it
         after a failed settle would erase the one record of how much is still
         sitting on the PI, and no later run could put it back. */
      if (reversed.ok) {
        /* A negative clamp means the floor bit: this allocation claimed more had
           been applied to the PI than the PI was actually carrying, so part of
           the reversal had nothing to take off. That is a standing disagreement
           between the allocation and the invoice — the kind of thing the old
           silent Math.max(0, ...) is why nobody ever noticed. */
        if (reversed.clampedCenti < 0) {
          /* eslint-disable-next-line no-console */
          console.error('[pv-settle-pi] reversal exceeded what the invoice was carrying:',
            cancelled.pv_number, 'pi', a.pi_id, 'recorded', applied, 'reversed', -reversed.appliedCenti);
        }
        await sb.from('pv_allocations').update({ applied_centi: 0 }).eq('id', a.id);
      } else {
        /* eslint-disable-next-line no-console */
        console.error('[pv-settle-pi] reversal failed — PI still carries this payment:',
          cancelled.pv_number, 'pi', a.pi_id, 'applied', applied, reversed.reason);
      }
    }
  }

  return c.json({
    paymentVoucher: { id: cancelled.id, status: cancelled.status },
    ...(fxRateRetained.length > 0 ? { fxRateRetained } : {}),
  });
};
paymentVouchers.post('/:id/cancel', cancelPaymentVoucherHandler);

/* ── reversePvAccounting — contra the active PV JE (mirror reversePiAccounting).
   Loads the original lines + swaps Dr/Cr so the reversal nets the original to
   zero, flags the original reversed=true. Idempotent. */
async function reversePvAccounting(
  sb: any,
  pvNumber: string,
): Promise<{ ok: boolean; status: string; jeNo?: string; jeId?: string; reason?: string }> {
  /* Through the ONE gate (acc/engine). A PV entry's legs are DYNAMIC (the
     voucher's own debit accounts + chosen credit account), so there is NO
     canonical fallback: an original with no lines now aborts loudly instead
     of posting a reversal header with zero lines — which is exactly the
     defect the previous copy documented against itself. */
  return reverseJournal(sb, {
    sourceType: 'PV',
    sourceDocNo: pvNumber,
    narration: (orig) => `Reversal of ${orig.je_no} — Payment voucher ${pvNumber} cancelled`,
    // Workers run in UTC: the raw date slice is YESTERDAY before 08:00 MYT —
    // the engine defaults the contra to todayMyt(), same as SI/PI.
  });
}
