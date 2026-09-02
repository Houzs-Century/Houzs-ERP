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
// Purchase Invoices at face value (pv_allocations → PI paid_sen on post).
//
// GL post (source_type 'PV', mirrors postPiAccounting's JE shape but with
// DYNAMIC legs — the PV's debit accounts + chosen credit account, not the PI's
// fixed Dr INVENTORY / Cr AP):
//   Dr each line.debit_account_code   round(amount_sen * exchange_rate)  (MYR)
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
import { isDocumentHeld } from '../lib/document-hold';
import { dateOrNull } from '../lib/date-coerce';
import { postJournal, reverseJournal } from '../../acc/engine';
import { pvLines } from '../../acc/rules';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { normalizeCurrency, normalizeExchangeRate, masterRateForCurrency } from '../lib/fx';
import { todayMyt } from '../lib/my-time';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange, assertAuditWritable, auditUnavailableBody } from '../lib/entity-audit';
import { pvCanEdit, pvCanSubmit, pvCanDecide, pvCanWithdraw, pvCanPost } from '../lib/pv-approval';
import { settlePiPaidSen } from '../lib/pi-settlement';
import { extractOneBill, matchSupplier, normalizeVendor, BILL_IMAGE_MIMES, MAX_BILLS_PER_CALL, MAX_FILES_PER_BILL, MAX_BILL_FILE_BYTES } from '../../acc/bill-extract';
import { planPvRateAdoption, isRateRetainedFromPv, roundRate6 } from '../lib/pv-rate-adoption';
import { recostFromGrn } from '../lib/recost';

export const paymentVouchers = new Hono<{ Bindings: Env; Variables: Variables }>();
paymentVouchers.use('*', supabaseAuth);

/* The auditable header fields, camel (API) -> snake (column). Money rides as
   total_sen: the INTEGER SEN, never a formatted amount. */
const PV_AUDIT_FIELDS: Array<[string, string]> = [
  ['payeeName', 'payee_name'],
  ['creditAccountCode', 'credit_account_code'],
  ['voucherDate', 'voucher_date'],
  ['supplierId', 'supplier_id'],
  ['notes', 'notes'],
  ['purpose', 'purpose'],
  ['currency', 'currency'],
  ['exchangeRate', 'exchange_rate'],
  ['totalSen', 'total_sen'],
];

const HEADER =
  'id, pv_number, voucher_date, payee_name, supplier_id, credit_account_code, currency, exchange_rate, purpose, notes, total_sen, status, posted_at, created_at, created_by, updated_at, company_id, submitted_at, submitted_by, approved_at, approved_by';

const LINE = 'id, pv_id, line_no, description, debit_account_code, amount_sen, created_at';

/* Migration 0202 — the PV purpose. Only SUPPLIER_PAYMENT settles AP (its
   allocations decrement the linked PIs' paid_sen); FREIGHT / OTHER post the GL
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
export function parseAmountSen(raw: unknown): number | null {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return null; // NaN / Infinity — never a payment
  if (!Number.isInteger(n)) return null; // sen is integer; a decimal means RM
  if (n < 0) return null;                // a refund is a different document
  return n;
}

/* ── Normalise + validate the incoming lines, recompute the header total ──── */
export function buildLines(
  raw: unknown,
): { rows: Array<{ line_no: number; description: string | null; debit_account_code: string; amount_sen: number }>; total: number } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'lines_required' };
  const rows: Array<{ line_no: number; description: string | null; debit_account_code: string; amount_sen: number }> = [];
  let total = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] as Record<string, unknown>;
    const debit = (line.debitAccountCode as string | undefined)?.trim();
    const amount = parseAmountSen(line.amountSen);
    if (amount === null) return { error: 'line_amount_invalid' };
    rows.push({
      line_no: i + 1,
      description: (line.description as string | undefined)?.trim() || null,
      debit_account_code: debit ?? '',
      amount_sen: amount,
    });
    total += amount;
  }
  if (rows.some((r) => !r.debit_account_code)) return { error: 'debit_account_required' };
  return { rows, total };
}

/* ── Normalise + validate the incoming PV→PI allocations (migration 0202) ──── */
export function buildAllocations(
  raw: unknown,
): { rows: Array<{ pi_id: string; amount_sen: number }>; total: number } | { error: string } {
  if (raw === undefined || raw === null) return { rows: [], total: 0 };
  if (!Array.isArray(raw)) return { error: 'allocations_invalid' };
  const rows: Array<{ pi_id: string; amount_sen: number }> = [];
  let total = 0;
  for (const a of raw) {
    const row = a as Record<string, unknown>;
    const piId = (row.piId as string | undefined)?.trim();
    /* Same reason as buildLines: a negative allocation used to clamp to 0 and
       then get skipped by the `<= 0` continue below, so "apply -RM 500 to this
       PI" silently applied nothing while the voucher still posted. */
    const amount = parseAmountSen(row.amountSen);
    if (!piId) return { error: 'allocation_pi_required' };
    if (amount === null) return { error: 'allocation_amount_invalid' };
    if (amount === 0) continue; // an explicit zero settles nothing — drop the row
    rows.push({ pi_id: piId, amount_sen: amount });
    total += amount;
  }
  return { rows, total };
}

/* settlePiPaidSen moved to lib/pi-settlement, where the clamp that stops two
   vouchers over-paying one invoice lives next to the SQL function that enforces
   it. It used to live here as an optimistic loop whose cap (total − paid) was
   read in the CALLER, one round trip before the write — see the header of
   src/db/migrations-pg/0147_scm_settle_pi_paid_centi.sql for how that
   over-pays. */

/* ── The allocation's pi_id is CALLER-SUPPLIED, so it is checked here ────────
   An allocation row is stamped with the ACTIVE company (stampCompany, below),
   but `piId` arrives in the request body and nothing verified that the invoice
   it names is this company's. Post the voucher and settlePiPaidSen moves that
   invoice's paid_sen and status by id alone — the service-role client bypasses
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

/* ── A HELD INVOICE IS NOT PAYABLE (owner, 2026-08-21: "PI also hold") ───────
   ON_HOLD arrived on scm.purchase_invoice_status with migration 0320, for the
   disputed supplier bill that must not go out while it is being queried.

   THIS ONE HAD TO BE WRITTEN, and the other two holds did not — worth knowing,
   because it says where to look when a fourth is added. A PO on hold is not
   receivable because grns.ts filters receivable POs through an ALLOW-list; a
   GRN on hold cannot be invoiced because the billable-GRN read is
   `.eq('status','POSTED')`. Both blocks came for free. The settle path reads
   invoices BY ID and had no status gate at all, so a held invoice would have
   been paid exactly as before.

   Checked where the id ENTERS, beside the company guard, for the same reason
   that one gives: nothing has been written yet, so the operator gets a straight
   refusal rather than a voucher that quietly pays a bill somebody stopped.

   FAILS CLOSED on a read error — absence is what refuses here, so folding a
   blip into "none are held" would authorise the write this exists to stop.

   IT READS THE MARKER SINCE MIG 0324. The hold is no longer a status, so a held
   invoice reads POSTED or PARTIALLY_PAID here and the old `status === 'ON_HOLD'`
   test would have matched nothing, for ever, while still looking like a guard.
   `isDocumentHeld` checks the flag AND the retired label, so a legacy row is
   still caught. Selecting `on_hold` is half the fix: an unselected column reads
   `undefined`, which is not held, which is the permissive answer. */
async function allocationPisOnHold(
  sb: any,
  c: any,
  piIds: string[],
): Promise<string[]> {
  const ids = [...new Set(piIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const { data, error } = await scopeToCompany(
    sb.from('purchase_invoices').select('id, status, on_hold').in('id', ids), c,
  );
  if (error) return ids;
  return ((data ?? []) as Array<{ id: string; status: string | null; on_hold: boolean | null }>)
    .filter((r) => isDocumentHeld(r))
    .map((r) => r.id);
}

const ALLOCATION_ON_HOLD = (ids: string[]) => ({
  error: 'allocation_on_hold',
  message: 'One of the invoices this voucher pays is on hold. Take it off hold first.',
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
      .select('id, amount_sen, pi:purchase_invoices(id, invoice_number, supplier_invoice_ref, currency, total_sen, paid_sen, status)')
      .eq('pv_id', id), c),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Flatten the joined PI (Supabase returns a to-one FK as an array). */
  const allocations = ((a.data ?? []) as Array<{
    id: string; amount_sen: number;
    pi: { id: string; invoice_number: string; supplier_invoice_ref: string | null; currency: string | null; total_sen: number; paid_sen: number; status: string }
      | Array<{ id: string; invoice_number: string; supplier_invoice_ref: string | null; currency: string | null; total_sen: number; paid_sen: number; status: string }> | null;
  }>).map((row) => {
    const pi = Array.isArray(row.pi) ? row.pi[0] : row.pi;
    return {
      id: row.id,
      amountSen: Number(row.amount_sen ?? 0),
      piId: pi?.id ?? null,
      invoiceNumber: pi?.invoice_number ?? null,
      supplierInvoiceRef: pi?.supplier_invoice_ref ?? null,
      currency: pi?.currency ?? null,
      totalSen: pi ? Number(pi.total_sen ?? 0) : null,
      paidSen: pi ? Number(pi.paid_sen ?? 0) : null,
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
/* Paid From must be a money account (bank / cash — the acc_money set Daily
   Bank reads). Returns a Response to send on refusal, null when fine. Fails
   CLOSED on a read error: an unverifiable account does not get to move money. */
const requireMoneyAccount = async (c: any, code: string): Promise<Response | null> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(
    sb.from('accounts').select('account_code, account_name, acc_money, is_active').eq('account_code', code),
    co.companyId,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'no_such_account', message: `${code} is not in this company's chart of accounts.` }, 400);
  const a = data as { account_name: string; acc_money: boolean | null; is_active: boolean };
  if (!a.is_active) return c.json({ error: 'account_inactive', message: `${code} ${a.account_name} is inactive.` }, 400);
  if (a.acc_money !== true) {
    return c.json({
      error: 'not_a_money_account',
      message: `${code} ${a.account_name} is not a bank / cash account. A voucher pays FROM money — pick one of the accounts Daily Bank shows.`,
    }, 400);
  }
  return null;
};

/* ── Vendor memory (mig 0341) — 我想要你要有记忆我下次submit 同个类型的invoice
   自动帮我填，选account 等等 (the owner, 2026-09-02).

   Remember what the operator ACTUALLY saved — the payee's casing, the FIRST
   line's expense account, the purpose — keyed by the same normalizeVendor()
   the supplier matcher uses, so the OCR's reading of the next same-vendor
   bill finds it. NOT learned: AP payments (their one line debits the AP
   control, fixed by role — nothing to remember) and model guesses (only a
   human's save teaches). last-saved-wins; times_seen only grows.

   BEST-EFFORT ON PURPOSE: this rides a voucher save that already succeeded,
   and a habit cache must never turn a saved voucher into an error — both
   legs bind their failure and simply skip; the habit is relearned on the
   next save. */
export async function learnVendorMemory(
  sb: any,
  c: any,
  input: {
    payeeName: string | null | undefined;
    purpose: string | null;
    lines: Array<{ line_no: number; debit_account_code: string }>;
  },
): Promise<void> {
  const coId = activeCompanyId(c);
  if (coId == null) return;
  if (normalizePurpose(input.purpose) === 'SUPPLIER_PAYMENT') return;
  const payee = (input.payeeName ?? '').trim();
  if (!payee) return;
  const key = normalizeVendor(payee);
  if (!key) return;
  const first = [...input.lines].sort((a, b) => a.line_no - b.line_no)[0];
  if (!first?.debit_account_code) return;

  /* try/catch around BOTH legs, not just bound errors: a client that THROWS
     (a rejected fetch, a harness without upsert) must be as skippable as one
     that answers { error } — the voucher this rides on has already saved. */
  try {
    const { data: existing, error: readErr } = await sb
      .from('acc_vendor_memory')
      .select('times_seen')
      .eq('company_id', coId)
      .eq('vendor_key', key)
      .maybeSingle();
    if (readErr) return; // best-effort: an unreadable habit is skipped, not raised

    const { error: writeErr } = await sb.from('acc_vendor_memory').upsert({
      company_id: coId,
      vendor_key: key,
      payee_name: payee,
      debit_account_code: first.debit_account_code,
      purpose: normalizePurpose(input.purpose),
      times_seen: ((existing as { times_seen?: number } | null)?.times_seen ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,vendor_key' });
    if (writeErr) return; // best-effort: the voucher saved; next save teaches again
  } catch {
    /* best-effort: same rule as the bound errors above. */
  }
}

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
  {
    /* Paid From must BE money (owner, 2026-08-30: paid from 应该只能选cash 和
       银行). Guarded here, not just in the picker: a voucher crediting an
       expense account would "pay" without any money leaving. */
    const moneyErr = await requireMoneyAccount(c, creditAccountCode);
    if (moneyErr) return moneyErr;
  }

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
    const held = await allocationPisOnHold(sb, c, allocBuilt.rows.map((r) => r.pi_id));
    if (held.length > 0) return c.json(ALLOCATION_ON_HOLD(held), 409);
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
      total_sen:         built.total,
      status:              'DRAFT',
      created_by:          user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; pv_number: string };
  const auditActor = c.get('houzsUser');
  /* Compensating delete for the failure paths below — scoped like every other
     PV write when the company is known (it stamped the row one insert ago);
     the fresh unique id carries the delete either way. */
  const rollbackHeader = () => {
    const del = sb.from('payment_vouchers').delete().eq('id', h.id);
    const coId = activeCompanyId(c);
    return coId == null ? del : scopeToCompanyId(del, coId);
  };

  const rowsWithId = built.rows.map((r) => ({ ...r, pv_id: h.id }));
  const { error: lErr } = await sb.from('payment_voucher_lines').insert(stampCompany(rowsWithId, c));
  if (lErr) { await rollbackHeader(); return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500); }

  // PV→PI settlement links (0202) — persist the allocations (compensating-delete
  // the whole PV on failure). They settle paid_sen only on POST, not here.
  if (allocBuilt.rows.length > 0) {
    const allocRows = allocBuilt.rows.map((r) => ({ ...r, pv_id: h.id }));
    const { error: aErr } = await sb.from('pv_allocations').insert(stampCompany(allocRows, c));
    if (aErr) { await rollbackHeader(); return c.json({ error: 'allocations_insert_failed', reason: aErr.message }, 500); }
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
      fieldChange('totalSen', null, built.total),
      fieldChange('lineCount', null, built.rows.length),
      fieldChange('allocatedSen', null, allocBuilt.total),
    ]),
  });

  /* Vendor memory (0341) — after every rollback path, so only a voucher that
     actually stands teaches. */
  await learnVendorMemory(sb, c, { payeeName, purpose, lines: built.rows });

  return c.json({ id: h.id, pvNumber: h.pv_number }, 201);
};
paymentVouchers.post('/', createPaymentVoucherHandler);

/* ────────────────────────────────────────────────────────────────────────
   Update — DRAFT only (a POSTED / CANCELLED voucher is read-only)
   ──────────────────────────────────────────────────────────────────────── */

/* Exported like post/cancel: the vitest harness mounts it on a bare Hono app
   (the phase-3 edit gate is proved in tests/pvApproval.test.ts). */
export const updatePaymentVoucherHandler = async (c: any) => {
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
  /* Phase 3: a voucher in the approval cycle is frozen — what was approved is
     what gets paid. Withdraw first; it then needs approval again. */
  const editable = pvCanEdit(before as { status: string; submitted_at?: string | null; approved_at?: string | null });
  if (!editable.ok) return c.json({ error: editable.error, message: editable.message }, 409);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.payeeName !== undefined) {
    const v = String(body.payeeName).trim();
    if (!v) return c.json({ error: 'payee_required' }, 400);
    updates.payee_name = v;
  }
  if (body.creditAccountCode !== undefined) {
    const v = String(body.creditAccountCode).trim();
    if (!v) return c.json({ error: 'credit_account_required' }, 400);
    const moneyErr = await requireMoneyAccount(c, v);
    if (moneyErr) return moneyErr;
    updates.credit_account_code = v;
  }
  /* voucher_date is `date NOT NULL DEFAULT current_date` (mig 0081), and the
     detail form sends this key on every save — cleared, DateField emits "".
     NULL would trade one 500 for another, so a blank is refused by NAME here,
     exactly as payeeName and creditAccountCode above are. */
  if (body.voucherDate !== undefined) {
    const d = dateOrNull(body.voucherDate);
    if (!d) return c.json({ error: 'voucher_date_required' }, 400);
    updates.voucher_date = d;
  }
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
  let newLines: Array<{ line_no: number; debit_account_code: string }> | undefined;
  if (body.lines !== undefined) {
    const built = buildLines(body.lines);
    if ('error' in built) return c.json({ error: built.error }, 400);
    await sb.from('payment_voucher_lines').delete().eq('pv_id', id);
    const { error: lErr } = await sb.from('payment_voucher_lines').insert(stampCompany(built.rows.map((r) => ({ ...r, pv_id: id })), c));
    if (lErr) return c.json({ error: 'lines_update_failed', reason: lErr.message }, 500);
    updates.total_sen = built.total;
    newTotal = built.total;
    newLines = built.rows;
  }

  // Allocations (optional, 0202) — full replace. Σ ≤ the effective PV total.
  if (body.allocations !== undefined) {
    const allocBuilt = buildAllocations(body.allocations);
    if ('error' in allocBuilt) return c.json({ error: allocBuilt.error }, 400);
    /* total_sen is NOT NULL on a row we have already read, so this is the real
       stored total — not a `?? 0` standing in for an unknown one. */
    const total = newTotal ?? Number(before.total_sen);
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
      const held = await allocationPisOnHold(sb, c, allocBuilt.rows.map((r) => r.pi_id));
      if (held.length > 0) return c.json(ALLOCATION_ON_HOLD(held), 409);
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

  /* Vendor memory (0341) — an edit that replaced the lines is the operator
     CORRECTING the answer (often the account the last prefill got wrong), the
     strongest signal there is. Effective values, not just the patch: the
     payee/purpose may be unchanged while the account moved. */
  if (newLines !== undefined) {
    await learnVendorMemory(sb, c, {
      payeeName: (updates.payee_name as string | undefined) ?? ((before.payee_name as string | null) ?? null),
      purpose: (updates.purpose as string | undefined) ?? ((before.purpose as string | null) ?? null),
      lines: newLines,
    });
  }

  return c.json({ paymentVoucher: data });
};
paymentVouchers.patch('/:id', updatePaymentVoucherHandler);

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
    credit_account_code: string; total_sen: number; currency: string | null;
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

  /* PHASE 3 GATE — the one door money leaves through. Placed AFTER the
     idempotency echo above: a voucher whose ACTIVE journal entry already
     exists has already paid, and re-posting it must stay an echo whatever
     its approval marks say. A fresh post, though, does not start without a
     recorded yes. */
  const gate = pvCanPost(pv as unknown as { status: string; submitted_at?: string | null; approved_at?: string | null });
  if (!gate.ok) return c.json({ error: gate.error, message: gate.message }, 409);

  const { data: linesRaw } = await sb.from('payment_voucher_lines')
    .select('line_no, description, debit_account_code, amount_sen').eq('pv_id', id).order('line_no');
  const lines = (linesRaw ?? []) as Array<{ line_no: number; description: string | null; debit_account_code: string; amount_sen: number }>;
  if (lines.length === 0) return c.json({ error: 'no_lines', message: 'Voucher has no lines to post' }, 400);

  /* FX conversion AT POST TIME (MYR-only today → rate 1). Each Dr leg =
     round(line.amount * rate); the single Cr leg = Σ of those rounded Dr legs,
     so the JE balances exactly regardless of per-line rounding. */
  const rawRate = Number(pv.exchange_rate ?? 1);
  const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
  const debitLegs = lines.map((l) => ({ ...l, myrSen: Math.round(Number(l.amount_sen) * rate) }));
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
     linked PI's paid_sen at FACE VALUE. Runs EXACTLY ONCE (the active-JE
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
      .select('id, pi_id, amount_sen').eq('pv_id', id);
    for (const a of (allocs ?? []) as Array<{ id: string; pi_id: string; amount_sen: number }>) {
      const want = Math.max(0, Number(a.amount_sen ?? 0));
      if (want <= 0) continue;
      /* The full allocation goes to settlePiPaidSen and the CAP is applied by
         the database, at write time, against the row as it then stands. This
         used to read the PI here, compute `outstanding = total - paid`, and cap
         the allocation itself — a cap that a second voucher settling the same
         invoice made stale before this one wrote, so both applied their full
         share and the invoice ended up paid twice over. The DRAFT/CANCELLED
         skip moved into the same call for the same reason: it was a separate
         read of a value that could change underneath it. */
      const settled = await settlePiPaidSen(sb, a.pi_id, want);
      /* Record EXACTLY what was applied — not what was asked for. A later
         cancel reverses this figure, so recording the request after the
         database clamped it smaller would un-apply money that never moved,
         swapping an over-payment for an under-payment. */
      await sb.from('pv_allocations').update({ applied_sen: settled.appliedSen }).eq('id', a.id);

      /* A clamp is a real event, not an implementation detail: somebody tried
         to pay a supplier more than the invoice asks for, and the difference
         did NOT go onto the invoice. Absorbing that silently would replace the
         over-payment lie with a "your voucher settled in full" lie, so it is
         logged and handed back to the caller. The voucher itself stays POSTED —
         the GL entry above is correct and already committed, and the money did
         leave; what is in question is only how much of it this invoice
         absorbed. */
      if (settled.clampedSen > 0) {
        /* eslint-disable-next-line no-console */
        console.error('[pv-settle-pi] allocation exceeded the invoice outstanding — clamped:',
          pv.pv_number, 'pi', a.pi_id, 'requested', want, 'applied', settled.appliedSen);
        overAllocated.push(`${a.pi_id}: asked ${want} sen, applied ${settled.appliedSen} sen`);
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
      if (settled.appliedSen > 0) {
        try {
          const { data: piRaw } = await sb.from('purchase_invoices')
            .select('id, invoice_number, currency, exchange_rate, grn_id').eq('id', a.pi_id).maybeSingle();
          const piRow = piRaw as {
            id: string; invoice_number: string | null; currency: string | null;
            exchange_rate: string | number | null; grn_id: string | null;
          } | null;
          if (piRow) {
            const plan = planPvRateAdoption({
              appliedSen: settled.appliedSen,
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
                    fieldChange('appliedSen', null, settled.appliedSen),
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

  /* ── 预付挂在 supplier (the owner, 2026-08-30) ─────────────────────────────
     Whatever this supplier voucher paid BEYOND its allocations is an advance:
     the GL already debited the whole amount into AP, so the supplier's ledger
     runs ahead — record by how much, on the voucher that did it. Written
     AFTER the GL and the settles because it is bookkeeping about them; the
     UNIQUE(pv_id) makes a re-post echo harmless. */
  let advanceSen = 0;
  {
    const supplierId = (pvRaw as { supplier_id?: string | null }).supplier_id ?? null;
    if (normalizePurpose(pv.purpose) === 'SUPPLIER_PAYMENT' && supplierId) {
      const { data: allocRows, error: alErr } = await sb.from('pv_allocations')
        .select('amount_sen').eq('pv_id', id).eq('from_advance', false);
      if (alErr) {
        /* eslint-disable-next-line no-console */
        console.error('[pv-advance] allocation read failed — advance NOT recorded:', pv.pv_number, alErr.message);
      } else {
        const allocatedSen = ((allocRows ?? []) as Array<{ amount_sen: number }>)
          .reduce((s, r) => s + Number(r.amount_sen || 0), 0);
        advanceSen = Math.max(0, Number(pv.total_sen) - allocatedSen);
        if (advanceSen > 0) {
          const { error: advErr } = await sb.from('acc_supplier_advances').insert({
            company_id: companyId, supplier_id: supplierId,
            pv_id: id, pv_number: pv.pv_number, amount_sen: advanceSen, applied_sen: 0,
          });
          const dup = advErr && (String(advErr.code ?? '') === '23505' || /duplicate key/i.test(String(advErr.message ?? '')));
          if (advErr && !dup) {
            /* eslint-disable-next-line no-console */
            console.error('[pv-advance] advance NOT recorded:', pv.pv_number, advErr.message);
            advanceSen = 0;
          } else if (!dup) {
            await recordEntityAudit(sb, {
              entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: pv.pv_number,
              action: 'UPDATE', actor: c.get('houzsUser'), companyId,
              statusSnapshot: 'POSTED',
              note: `Paid ${(advanceSen / 100).toFixed(2)} ahead of any invoice — recorded as this supplier's advance, to knock off against invoices to come`,
              fieldChanges: compactChanges([fieldChange('supplierAdvanceSen', null, advanceSen)]),
            });
          }
        }
      }
    }
  }

  return c.json({
    ok: true, jeNo: je.je_no, jeId: je.id, totalSen,
    ...(advanceSen > 0 ? { advanceSen } : {}),
    ...(overAllocated.length > 0 ? { overAllocated } : {}),
    ...(rateAdopted.length > 0 ? { rateAdopted } : {}),
    ...(rateMismatch.length > 0 ? { rateMismatch } : {}),
  });
};
paymentVouchers.post('/:id/post', postPaymentVoucherHandler);

/* ────────────────────────────────────────────────────────────────────────
   Phase 3 — the approval cycle. Markers on the DRAFT, never new statuses
   (the 0324 lesson); the rules live in lib/pv-approval.ts as a pure table.
   submit / withdraw need write permission; approve / reject need
   scm.payment_voucher.approve — a key nobody holds by default except '*'
   (the owner and IT admin), grantable per position like every other key.
   ──────────────────────────────────────────────────────────────────────── */

const loadPvForApproval = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { refusal: c.json(co.refusal, 409) };
  const { data, error } = await scopeToCompanyId(
    sb.from('payment_vouchers').select(HEADER).eq('id', id), co.companyId,
  ).maybeSingle();
  if (error) return { refusal: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { refusal: c.json(NOT_THIS_COMPANY, 404) };
  return { sb, id, pv: data as Record<string, any>, companyId: co.companyId };
};

const approvalActor = (c: any): string =>
  String((c.get('houzsUser') as { name?: string } | undefined)?.name ?? 'unknown');

export const submitPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const loaded = await loadPvForApproval(c);
  if ('refusal' in loaded) return loaded.refusal;
  const { sb, id, pv, companyId } = loaded;
  const v = pvCanSubmit(pv as { status: string; submitted_at?: string | null; approved_at?: string | null });
  if (!v.ok) return c.json({ error: v.error, message: v.message }, 409);
  const who = approvalActor(c);
  const at = new Date().toISOString();
  const { error } = await scopeToCompanyId(sb.from('payment_vouchers')
    .update({ submitted_at: at, submitted_by: who, updated_at: at }).eq('id', id), companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: pv.pv_number,
    action: 'SUBMIT_FOR_APPROVAL', actor: c.get('houzsUser'), statusSnapshot: 'DRAFT',
    fieldChanges: compactChanges([fieldChange('submitted_by', null, who)]),
  });
  return c.json({ id, submittedAt: at, submittedBy: who });
};
paymentVouchers.post('/:id/submit', submitPaymentVoucherHandler);

export const withdrawPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const loaded = await loadPvForApproval(c);
  if ('refusal' in loaded) return loaded.refusal;
  const { sb, id, pv, companyId } = loaded;
  const v = pvCanWithdraw(pv as { status: string; submitted_at?: string | null; approved_at?: string | null });
  if (!v.ok) return c.json({ error: v.error, message: v.message }, 409);
  const { error } = await scopeToCompanyId(sb.from('payment_vouchers')
    .update({ submitted_at: null, submitted_by: null, approved_at: null, approved_by: null, updated_at: new Date().toISOString() })
    .eq('id', id), companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: pv.pv_number,
    action: 'WITHDRAW_FROM_APPROVAL', actor: c.get('houzsUser'), statusSnapshot: 'DRAFT',
    fieldChanges: compactChanges([fieldChange('submitted_by', pv.submitted_by ?? null, null)]),
  });
  return c.json({ id, withdrawn: true });
};
paymentVouchers.post('/:id/withdraw', withdrawPaymentVoucherHandler);

export const approvePaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.approve')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const loaded = await loadPvForApproval(c);
  if ('refusal' in loaded) return loaded.refusal;
  const { sb, id, pv, companyId } = loaded;
  const v = pvCanDecide(pv as { status: string; submitted_at?: string | null; approved_at?: string | null });
  if (!v.ok) return c.json({ error: v.error, message: v.message }, 409);
  const who = approvalActor(c);
  const at = new Date().toISOString();
  const { error } = await scopeToCompanyId(sb.from('payment_vouchers')
    .update({ approved_at: at, approved_by: who, updated_at: at }).eq('id', id), companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: pv.pv_number,
    action: 'APPROVE', actor: c.get('houzsUser'), statusSnapshot: 'DRAFT',
    fieldChanges: compactChanges([fieldChange('approved_by', null, who)]),
  });
  return c.json({ id, approvedAt: at, approvedBy: who });
};
paymentVouchers.post('/:id/approve', approvePaymentVoucherHandler);

export const rejectPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.approve')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const loaded = await loadPvForApproval(c);
  if ('refusal' in loaded) return loaded.refusal;
  const { sb, id, pv, companyId } = loaded;
  const v = pvCanDecide(pv as { status: string; submitted_at?: string | null; approved_at?: string | null });
  if (!v.ok) return c.json({ error: v.error, message: v.message }, 409);
  let note = '';
  try { note = String(((await c.req.json()) as { note?: unknown })?.note ?? '').trim(); } catch { /* empty body is a valid no-note reject */ }
  const { error } = await scopeToCompanyId(sb.from('payment_vouchers')
    .update({ submitted_at: null, submitted_by: null, approved_at: null, approved_by: null, updated_at: new Date().toISOString() })
    .eq('id', id), companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  /* The reason lives on the audit trail, where the submitter reads it — a
     rejected voucher goes back to editable with the WHY on its history. */
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: pv.pv_number,
    action: 'REJECT', actor: c.get('houzsUser'), statusSnapshot: 'DRAFT',
    fieldChanges: compactChanges([fieldChange('rejection_note', null, note || '(no note)')]),
  });
  return c.json({ id, rejected: true });
};
paymentVouchers.post('/:id/reject', rejectPaymentVoucherHandler);

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

  /* An advance that has been SPENT pins its voucher: the knock-offs settled
     real invoices with this voucher's money, and cancelling would reverse a
     payment whose value is now inside other documents. Un-apply first (not
     built yet — deliberately: it has not been needed), or leave the voucher
     standing. An UNSPENT advance cancels fine — the row is removed with it. */
  {
    const { data: adv, error: advErr } = await sb.from('acc_supplier_advances')
      .select('id, applied_sen').eq('pv_id', id).maybeSingle();
    if (advErr) return c.json({ error: 'load_failed', reason: advErr.message }, 500);
    const a = adv as { applied_sen: number } | null;
    if (a && Number(a.applied_sen) > 0) {
      return c.json({
        error: 'advance_applied',
        message: `This voucher's advance has already knocked off ${(Number(a.applied_sen) / 100).toFixed(2)} of invoices. A payment whose value now lives inside other documents cannot be cancelled.`,
      }, 409);
    }
  }

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

  /* The (unspent — the guard above) advance goes with its voucher. */
  await sb.from('acc_supplier_advances').delete().eq('pv_id', id).eq('applied_sen', 0);

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
     each linked PI's paid_sen by the EXACT applied_sen recorded at post.
     Only a SUPPLIER_PAYMENT PV ever moved paid_sen. Best-effort. */
  /* FX-RATE RETENTION on cancel (2026-07-30) — the invoices still carrying the rate
     this voucher established, named so the History panel says so out loud. See
     lib/pv-rate-adoption.ts (isRateRetainedFromPv) for WHY the rate and the re-cost
     are deliberately NOT reverted: the only value to revert to is 1, which is the
     R2 mis-cost itself, so "undoing" it would knowingly push a 1:1 foreign basis
     back through every lot, DO and SI the recost had corrected. */
  const fxRateRetained: string[] = [];
  if (normalizePurpose(head.purpose) === 'SUPPLIER_PAYMENT') {
    const { data: allocs } = await sb.from('pv_allocations')
      .select('id, pi_id, applied_sen').eq('pv_id', id);
    for (const a of (allocs ?? []) as Array<{ id: string; pi_id: string; applied_sen: number }>) {
      const applied = Math.max(0, Number(a.applied_sen ?? 0));
      if (applied <= 0) continue;

      /* Read BEFORE the reversal: the settle moves paid_sen and status, never the
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

      const reversed = await settlePiPaidSen(sb, a.pi_id, -applied);
      /* Only zero the allocation when the reversal actually landed. Clearing it
         after a failed settle would erase the one record of how much is still
         sitting on the PI, and no later run could put it back. */
      if (reversed.ok) {
        /* A negative clamp means the floor bit: this allocation claimed more had
           been applied to the PI than the PI was actually carrying, so part of
           the reversal had nothing to take off. That is a standing disagreement
           between the allocation and the invoice — the kind of thing the old
           silent Math.max(0, ...) is why nobody ever noticed. */
        if (reversed.clampedSen < 0) {
          /* eslint-disable-next-line no-console */
          console.error('[pv-settle-pi] reversal exceeded what the invoice was carrying:',
            cancelled.pv_number, 'pi', a.pi_id, 'recorded', applied, 'reversed', -reversed.appliedSen);
        }
        await sb.from('pv_allocations').update({ applied_sen: 0 }).eq('id', a.id);
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

/* ── Supplier advances — 预付挂在 supplier (owner, 2026-08-30) ────────────────
   The ledger of vouchers that paid AHEAD of any invoice, and the knock-off
   that spends them. Applying an advance posts NOTHING: the money already
   debited AP when the voucher posted, the invoice already credited AP when it
   posted — this only settles the invoice's paid_sen and burns the advance. */

/* GET /advances/list?supplierId=… — the open advances (remaining > 0),
   newest first, plus the total still unspent. No supplierId = the company's
   whole list (the screen's per-supplier ask filters). */
export const supplierAdvancesHandler = async (c: any) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let q = sb.from('acc_supplier_advances')
    .select('id, supplier_id, pv_id, pv_number, amount_sen, applied_sen, created_at')
    .order('created_at', { ascending: false });
  const supplierId = c.req.query('supplierId');
  if (supplierId) q = q.eq('supplier_id', supplierId);
  const { data, error } = await scopeToCompanyId(q, co.companyId);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ id: number; supplier_id: string; pv_id: string; pv_number: string; amount_sen: number; applied_sen: number; created_at: string }>)
    .map((r) => ({ ...r, remaining_sen: Number(r.amount_sen) - Number(r.applied_sen) }))
    .filter((r) => r.remaining_sen > 0);
  return c.json({
    advances: rows,
    totalRemainingSen: rows.reduce((s, r) => s + r.remaining_sen, 0),
  });
};
paymentVouchers.get('/advances/list', supplierAdvancesHandler);

/* POST /:id/apply-advance { allocations: [{ piId, amountSen }] } — knock the
   voucher's remaining advance off real invoices. Gated like posting (it
   settles invoices); refuses another company's or a held invoice by name;
   Σ may not exceed what remains; each settle is DB-clamped exactly like a
   payment's, and what is recorded is what was APPLIED, never what was asked. */
export const applyAdvanceHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id');

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const wants = (Array.isArray(body.allocations) ? body.allocations : [])
    .map((a: any) => ({ piId: String(a.piId ?? ''), amountSen: Math.round(Number(a.amountSen ?? 0)) }))
    .filter((a: { piId: string; amountSen: number }) => a.piId && Number.isFinite(a.amountSen) && a.amountSen > 0);
  if (wants.length === 0) return c.json({ error: 'nothing_to_apply', message: 'Name at least one invoice and a positive amount.' }, 400);

  const { data: advRaw, error: advErr } = await scopeToCompanyId(
    sb.from('acc_supplier_advances').select('id, supplier_id, pv_number, amount_sen, applied_sen').eq('pv_id', id), co.companyId,
  ).maybeSingle();
  if (advErr) return c.json({ error: 'load_failed', reason: advErr.message }, 500);
  if (!advRaw) return c.json({ error: 'no_advance', message: 'This voucher holds no advance — nothing was paid ahead on it.' }, 404);
  const adv = advRaw as { id: number; supplier_id: string; pv_number: string; amount_sen: number; applied_sen: number };
  const remaining = Number(adv.amount_sen) - Number(adv.applied_sen);
  const askedSen = wants.reduce((s: number, w: { amountSen: number }) => s + w.amountSen, 0);
  if (askedSen > remaining) {
    return c.json({
      error: 'exceeds_advance',
      message: `That applies ${(askedSen / 100).toFixed(2)} but only ${(remaining / 100).toFixed(2)} of this advance remains.`,
    }, 409);
  }

  const piIds = wants.map((w: { piId: string }) => w.piId);
  const outside = await allocationPisOutsideCompany(sb, c, piIds);
  if (outside.length > 0) return c.json(ALLOCATION_NOT_THIS_COMPANY(outside), 404);
  const held = await allocationPisOnHold(sb, c, piIds);
  if (held.length > 0) return c.json(ALLOCATION_ON_HOLD(held), 409);

  let appliedSen = 0;
  const results: Array<{ piId: string; askedSen: number; appliedSen: number }> = [];
  for (const w of wants as Array<{ piId: string; amountSen: number }>) {
    const settled = await settlePiPaidSen(sb, w.piId, w.amountSen);
    const got = settled.ok ? settled.appliedSen : 0;
    appliedSen += got;
    results.push({ piId: w.piId, askedSen: w.amountSen, appliedSen: got });
    if (got > 0) {
      await sb.from('pv_allocations').insert({
        company_id: co.companyId, pv_id: id, pi_id: w.piId,
        amount_sen: got, applied_sen: got, from_advance: true,
      });
    }
  }

  /* Burn the advance by what actually landed — optimistic, so two concurrent
     applies cannot both spend the same ringgit: the second one's guard misses
     and it reports instead of overdrawing. */
  if (appliedSen > 0) {
    const { data: burned, error: burnErr } = await sb.from('acc_supplier_advances')
      .update({ applied_sen: Number(adv.applied_sen) + appliedSen, updated_at: new Date().toISOString() })
      .eq('id', adv.id).eq('applied_sen', adv.applied_sen)
      .select('id').maybeSingle();
    if (burnErr || !burned) {
      /* eslint-disable-next-line no-console */
      console.error('[pv-advance] burn write missed (concurrent apply?) — invoices settled, advance NOT decremented:', adv.pv_number, burnErr?.message ?? 'row moved');
      return c.json({
        error: 'burn_conflict',
        message: 'The invoices were settled but the advance record was updated by someone else at the same moment — refresh and check the remaining figure before applying more.',
      }, 409);
    }
    await recordEntityAudit(sb, {
      entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: adv.pv_number,
      action: 'UPDATE', actor: c.get('houzsUser'), companyId: co.companyId,
      note: `Advance knocked off ${(appliedSen / 100).toFixed(2)} against ${results.filter((r) => r.appliedSen > 0).length} invoice(s) — no money moved, both legs were already in AP`,
      fieldChanges: compactChanges([
        fieldChange('advanceAppliedSen', adv.applied_sen, Number(adv.applied_sen) + appliedSen),
      ]),
    });
  }

  return c.json({
    ok: true,
    appliedSen,
    remainingSen: remaining - appliedSen,
    results,
  });
};
paymentVouchers.post('/:id/apply-advance', applyAdvanceHandler);

/* ── Bill OCR — read incoming bills into voucher pre-fills (2026-09-02) ──────
   我想要把ocr 功能放去payment 那边. Each `bills` entry is ONE document (its
   files are its pages — the human said so at upload; the server never guesses
   whether two files are one bill). One vision call per bill, supplier matched
   server-side, and NOTHING written: the answer pre-fills a form a person
   still checks, saves, and sends through the untouched approval cycle. */
export const extractBillsHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const apiKey = c.env?.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'anthropic_key_missing', reason: 'Run: npx wrangler secret put ANTHROPIC_API_KEY' }, 503);
  }

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const bills = Array.isArray(body.bills) ? body.bills : [];
  if (bills.length === 0) return c.json({ error: 'no_bills', message: 'Send at least one bill.' }, 400);
  if (bills.length > MAX_BILLS_PER_CALL) {
    return c.json({ error: 'too_many_bills', message: `At most ${MAX_BILLS_PER_CALL} bills per batch — split the pile.` }, 400);
  }
  for (const [i, b] of bills.entries()) {
    const files = Array.isArray(b?.files) ? b.files : [];
    if (files.length === 0) return c.json({ error: 'empty_bill', message: `Bill ${i + 1} has no files.` }, 400);
    if (files.length > MAX_FILES_PER_BILL) {
      return c.json({ error: 'too_many_pages', message: `Bill ${i + 1} has more than ${MAX_FILES_PER_BILL} pages.` }, 400);
    }
    for (const f of files) {
      const mime = String(f?.mime ?? '');
      if (!BILL_IMAGE_MIMES.has(mime) && mime !== 'application/pdf') {
        return c.json({ error: 'bad_file_type', message: `Bill ${i + 1}: ${mime || 'unknown type'} — JPEG / PNG / WebP / PDF only.` }, 400);
      }
      const size = Math.floor(String(f?.dataBase64 ?? '').length * 0.75);
      if (size > MAX_BILL_FILE_BYTES) {
        return c.json({ error: 'file_too_big', message: `Bill ${i + 1}: a file is over ${Math.round(MAX_BILL_FILE_BYTES / 1024 / 1024)}MB.` }, 400);
      }
    }
  }

  /* Suppliers once for the whole batch — matching is per bill, in code. */
  const sb = c.get('supabase');
  const { data: supRaw, error: supErr } = await scopeToCompany(
    sb.from('suppliers').select('id, code, name').eq('status', 'ACTIVE'), c,
  );
  if (supErr) return c.json({ error: 'load_failed', reason: supErr.message }, 500);
  const suppliers = (supRaw ?? []) as Array<{ id: string; code: string | null; name: string }>;

  /* Vendor memory (0341), once for the batch — what the operator saved the
     last time each vendor was paid. Small by construction: one row per
     distinct vendor per company. */
  const { data: memRaw, error: memErr } = await scopeToCompany(
    sb.from('acc_vendor_memory').select('vendor_key, payee_name, debit_account_code, purpose, times_seen'), c,
  );
  if (memErr) return c.json({ error: 'load_failed', reason: memErr.message }, 500);
  type MemRow = { vendor_key: string; payee_name: string | null; debit_account_code: string | null; purpose: string | null; times_seen: number };
  const memByKey = new Map(((memRaw ?? []) as MemRow[]).map((m) => [m.vendor_key, m]));
  /* The printed name first; the MATCHED supplier's name second — a bill
     reading "TENAGA NASIONAL" still finds the habit saved under "TNB" when
     both normalize onto the supplier the matcher agreed on. */
  const memoryFor = (vendorName: string | null, matchedName: string | null): MemRow | null => {
    for (const raw of [vendorName, matchedName]) {
      if (!raw) continue;
      const hit = memByKey.get(normalizeVendor(raw));
      if (hit) return hit;
    }
    return null;
  };

  const out = [] as Array<Record<string, unknown>>;
  for (const [i, b] of bills.entries()) {
    const files = (b.files as Array<{ name?: unknown; mime?: unknown; dataBase64?: unknown }>).map((f) => ({
      name: String(f.name ?? `file-${i}`), mime: String(f.mime ?? ''), dataBase64: String(f.dataBase64 ?? ''),
    }));
    const r = await extractOneBill(apiKey, files);
    if (!r.ok) {
      out.push({ index: i, ok: false, reason: r.reason });
      continue;
    }
    const match = matchSupplier(r.extraction.vendorName, suppliers);
    const mem = memoryFor(r.extraction.vendorName, match?.supplier.name ?? null);
    out.push({
      index: i, ok: true, extraction: r.extraction,
      supplierMatch: match ? { id: match.supplier.id, code: match.supplier.code, name: match.supplier.name, confidence: match.confidence } : null,
      memory: mem ? { payeeName: mem.payee_name, debitAccountCode: mem.debit_account_code, purpose: mem.purpose, timesSeen: mem.times_seen } : null,
    });
  }
  return c.json({ bills: out });
};
paymentVouchers.post('/extract', extractBillsHandler);

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
