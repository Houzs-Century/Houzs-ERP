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
import { docMonthTag, mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { isDocumentHeld } from '../lib/document-hold';
import { dateOrNull } from '../lib/date-coerce';
import { postJournal, reverseJournal } from '../../acc/engine';
import { apControlRole, pvLines, pvBankChargeLines, customerRefundLines, resolveRoles, PV_BANK_CHARGE_ACCOUNT } from '../../acc/rules';
import { checkExpenseLeaf } from '../../acc/charge-account';
import { customerPartyCode } from '../../acc/payments';
import { refundSourceHandler, refundCreateGuard, refundOwnControl } from '../lib/pv-refund';
import { CASH_SERIES_LETTER } from '../../acc/receipts';
import { matchBankLinesNamingVoucher } from './accounting-bank';
import { allocationHeadroomBreach, pendingReservationsHandler } from '../lib/pv-reservations';
import { uploadPvFileHandler, listPvFilesHandler, streamPvFileHandler, deletePvFileHandler, printPvBundleHandler } from './pv-files';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { normalizeCurrency, normalizeExchangeRate, masterRateForCurrency } from '../lib/fx';
import { todayMyt } from '../lib/my-time';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange, assertAuditWritable, auditUnavailableBody } from '../lib/entity-audit';
import { pvCanEdit, pvCanPrepare, pvCanCheck, pvCanApprove, pvCanReject, pvCanWithdraw, pvCanPost, type PvApprovalShape } from '../lib/pv-approval';
import { finishPostedVoucher, finishCancelledVoucher } from './payment-vouchers-finish';
import { normalizeVendor } from '../../acc/bill-extract';
import { extractBillsHandler, splitPdfHandler, enqueueBillReadsHandler, pollBillReadsHandler } from './pv-extract';
import { HEADER, SUPPLIER_EMBED, journalNumbers, listPaymentVouchersHandler } from './payment-vouchers-list';
import { describeVouchers, payToFields, payToUpdates, PAY_TO_AUDIT_FIELDS } from './payment-vouchers-describe';
import { paymentListingHandler } from './payment-vouchers-listing';
import { remindApproverHandler } from './payment-vouchers-remind';
import { updatePaymentVoucherTextHandler } from './payment-vouchers-text';
export { listPaymentVouchersHandler };
import { parseEventId, pvLineEventRefusal } from '../lib/event-tags';
import { paymentRequestsLinkGuard, linkPaymentRequests } from '../lib/payment-request';
import { pvBillFields, pvBillUpdates } from '../lib/bill-matches';
import { officialActor, officialOwedFields, officialOwedUpdates } from '../lib/official-doc';
import { pvEventAccountRefusal } from '../lib/event-accounts';
import { requireLeafAccount } from './accounting-chart';
import { fmtSen } from '../shared/format';

export const paymentVouchers = new Hono<{ Bindings: Env; Variables: Variables }>();
paymentVouchers.use('*', supabaseAuth);

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
  ['billRef', 'bill_ref'],
  ['billDate', 'bill_date'],
  ['bankChargeSen', 'bank_charge_sen'],
  ...PAY_TO_AUDIT_FIELDS,
];


const LINE = 'id, pv_id, line_no, description, debit_account_code, amount_sen, created_at, project_id';

const normalizePurpose = (raw: unknown): 'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER' | 'CUSTOMER_REFUND' => {
  const v = String(raw ?? '').trim().toUpperCase();
  return v === 'FREIGHT' || v === 'OTHER' || v === 'CUSTOMER_REFUND' ? v : 'SUPPLIER_PAYMENT';
};
const isRefund = (purpose: unknown): boolean => normalizePurpose(purpose) === 'CUSTOMER_REFUND';


/* A NEW voucher is born on the Draft series — {co}Draft-YYMM-NNN — and only
   earns a formal number at CHECKED (GL redesign item 8b, the owner's
   numbering rule: draft 不占正式号,checked 才有 numbering; the formal series
   is per BANK, so the sequence = the sequence of real vouchers, with no holes
   from deleted drafts). Mirrors the sibling scm minters — max(suffix)+1 via
   mintMonthlyDocNo (self-healing; never count+1). */
/* YYMM is the VOUCHER's own date, never the day the row was keyed (owner
   2026-09-07: 要根据文件日期) — a July voucher typed in September sits in July's
   series, Draft and formal alike (docMonthTag, doc-no.ts). */
const nextPvDraftNo = async (sb: any, c: any, voucherDate: string): Promise<string> =>
  mintMonthlyDocNo(sb, 'payment_vouchers', 'pv_number', `${companyDocPrefix(c)}Draft-${docMonthTag(voucherDate)}`);

const isDraftNumber = (no: string | null | undefined): boolean => /-Draft-/.test(String(no ?? ''));

const mintFormalPvNo = async (
  sb: any,
  c: any,
  companyId: number,
  creditAccountCode: string,
  voucherDate: string,
  kind: 'PV' | 'RF' = 'PV', // a Customer Refund mints {letter}RF (owner 2026-09-07: 用 rf)
): Promise<{ ok: true; pvNo: string } | { ok: false; status: number; body: Record<string, unknown> }> => {
  /* The cash drawer is not a configured bank: paying from roles.CASH mints on
     the FIXED cash letter — {co}CPV — the same CASH_SERIES_LETTER the receipt
     channel prints as COR (owner 2026-09-05: 我payment 出去by cash 时就会是
     cpv啊). One letter, both papers; the letters table never holds C. */
  const roles = await resolveRoles(sb, companyId);
  const isCash = creditAccountCode === roles.CASH;
  const [letterRes, digitsRes] = await Promise.all([
    isCash
      ? Promise.resolve({ data: { letter: CASH_SERIES_LETTER }, error: null as { message: string } | null })
      : sb.from('acc_bank_letters').select('letter').eq('company_id', companyId).eq('account_code', creditAccountCode).maybeSingle(),
    sb.from('acc_numbering').select('doc_digits').eq('company_id', companyId).maybeSingle(),
  ]);
  if (letterRes.error) return { ok: false, status: 500, body: { error: 'load_failed', reason: letterRes.error.message } };
  if (digitsRes.error) return { ok: false, status: 500, body: { error: 'load_failed', reason: digitsRes.error.message } };
  const letter = (letterRes.data as { letter?: string } | null)?.letter;
  if (!letter) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'bank_letter_missing',
        message: `${creditAccountCode} has no series letter yet — set one on the Voucher numbering card (Reconciliation setup), then check again.`,
      },
    };
  }
  const digits = Number((digitsRes.data as { doc_digits?: number } | null)?.doc_digits ?? 3);
  const pvNo = await mintMonthlyDocNo(sb, 'payment_vouchers', 'pv_number', `${companyDocPrefix(c)}${letter}${kind}-${docMonthTag(voucherDate)}`, digits);
  return { ok: true, pvNo };
};

export function parseAmountSen(raw: unknown): number | null {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0) return null;
  return n;
}

export function buildLines(
  raw: unknown,
): { rows: Array<{ line_no: number; description: string | null; debit_account_code: string; amount_sen: number; project_id: number | null }>; total: number } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'lines_required' };
  const rows: Array<{ line_no: number; description: string | null; debit_account_code: string; amount_sen: number; project_id: number | null }> = [];
  let total = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] as Record<string, unknown>;
    const debit = (line.debitAccountCode as string | undefined)?.trim();
    const amount = parseAmountSen(line.amountSen);
    if (amount === null) return { error: 'line_amount_invalid' };
    const event = parseEventId(line.projectId); // the event this line is for (owner 2026-09-30, 5a)
    if (event === 'invalid') return { error: 'line_event_invalid' };
    rows.push({
      line_no: i + 1,
      description: (line.description as string | undefined)?.trim() || null,
      debit_account_code: debit ?? '',
      amount_sen: amount,
      project_id: event,
    });
    total += amount;
  }
  if (rows.some((r) => !r.debit_account_code)) return { error: 'debit_account_required' };
  return { rows, total };
}

export type AllocationRow = { pi_id: string | null; ap_invoice_id: string | null; amount_sen: number };
export function buildAllocations(
  raw: unknown,
): { rows: AllocationRow[]; total: number } | { error: string } {
  if (raw === undefined || raw === null) return { rows: [], total: 0 };
  if (!Array.isArray(raw)) return { error: 'allocations_invalid' };
  const rows: AllocationRow[] = [];
  let total = 0;
  for (const a of raw) {
    const row = a as Record<string, unknown>;
    /* One target per row: a purchase invoice (stock) OR an AP invoice (the
       non-stock supplier bill — owner 2026-09-06, both listed side by side on
       the AP Payment). Naming both, or neither, is refused. */
    const piId = (row.piId as string | undefined)?.trim() || null;
    const apInvoiceId = (row.apInvoiceId as string | undefined)?.trim() || null;
    const amount = parseAmountSen(row.amountSen);
    if (!piId && !apInvoiceId) return { error: 'allocation_pi_required' };
    if (piId && apInvoiceId) return { error: 'allocation_two_targets' };
    if (amount === null) return { error: 'allocation_amount_invalid' };
    if (amount === 0) continue;
    rows.push({ pi_id: piId, ap_invoice_id: apInvoiceId, amount_sen: amount });
    total += amount;
  }
  return { rows, total };
}

const piIdsOf = (rows: AllocationRow[]): string[] => rows.flatMap((r) => (r.pi_id ? [r.pi_id] : []));
const apInvoiceIdsOf = (rows: AllocationRow[]): string[] => rows.flatMap((r) => (r.ap_invoice_id ? [r.ap_invoice_id] : []));


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

async function allocationApInvoicesOutsideCompany(
  sb: any,
  c: any,
  ids0: string[],
): Promise<string[]> {
  const ids = [...new Set(ids0.filter(Boolean))];
  if (ids.length === 0) return [];
  const { data, error } = await scopeToCompany(
    sb.from('ap_invoices').select('id, status').in('id', ids), c,
  );
  if (error) return ids;
  const live = new Set(((data ?? []) as Array<{ id: string; status: string }>)
    .filter((r) => r.status !== 'DRAFT' && r.status !== 'CANCELLED')
    .map((r) => r.id));
  return ids.filter((id) => !live.has(id));
}

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



paymentVouchers.get('/', listPaymentVouchersHandler);

paymentVouchers.post('/print-bundle', printPvBundleHandler);
paymentVouchers.get('/listing', paymentListingHandler);
paymentVouchers.get('/refund-source', refundSourceHandler);
paymentVouchers.post('/remind', remindApproverHandler);
paymentVouchers.post('/:id/files', uploadPvFileHandler);
paymentVouchers.get('/:id/files', listPvFilesHandler);
paymentVouchers.get('/:id/files/:fileId', streamPvFileHandler);
paymentVouchers.delete('/:id/files/:fileId', deletePvFileHandler);

paymentVouchers.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i, a] = await Promise.all([
    scopeToCompany(sb.from('payment_vouchers').select(`${HEADER}, ${SUPPLIER_EMBED}`).eq('id', id), c).maybeSingle(),
    scopeToCompany(sb.from('payment_voucher_lines').select(LINE).eq('pv_id', id), c).order('line_no'),
    scopeToCompany(sb.from('pv_allocations')
      .select('id, amount_sen, applied_sen, settled_at, pi:purchase_invoices(id, invoice_number, supplier_invoice_ref, currency, total_sen, paid_sen, status), api:ap_invoices(id, invoice_number, supplier_invoice_ref, currency, total_sen, paid_sen, status)')
      .eq('pv_id', id), c),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  type Inv = { id: string; invoice_number: string; supplier_invoice_ref: string | null; currency: string | null; total_sen: number; paid_sen: number; status: string };
  const allocations = ((a.data ?? []) as Array<{
    id: string; amount_sen: number; applied_sen?: number | null; settled_at?: string | null;
    pi: Inv | Inv[] | null;
    api?: Inv | Inv[] | null;
  }>).map((row) => {
    const pi = Array.isArray(row.pi) ? row.pi[0] : row.pi;
    const api = Array.isArray(row.api) ? row.api[0] : row.api;
    const inv = pi ?? api ?? null;
    return {
      id: row.id,
      amountSen: Number(row.amount_sen ?? 0),
      appliedSen: row.settled_at ? Number(row.applied_sen ?? 0) : null,
      kind: pi ? 'PI' : api ? 'API' : null,
      piId: pi?.id ?? null,
      apInvoiceId: api?.id ?? null,
      invoiceNumber: inv?.invoice_number ?? null,
      supplierInvoiceRef: inv?.supplier_invoice_ref ?? null,
      currency: inv?.currency ?? null,
      totalSen: inv ? Number(inv.total_sen ?? 0) : null,
      paidSen: inv ? Number(inv.paid_sen ?? 0) : null,
      status: inv?.status ?? null,
    };
  });
  const jn = await journalNumbers(sb, c, [String((h.data as { pv_number: string }).pv_number)]);
  if (!jn.ok) return c.json({ error: 'load_failed', reason: jn.reason }, 500);
  const described = await describeVouchers(sb, c, [h.data as Record<string, unknown> & { id: string }]);
  if (!described.ok) return c.json({ error: 'load_failed', reason: described.reason }, 500);
  const head = h.data as { status?: string; purpose?: string | null; pv_number?: string };
  const rawAllocs = (a.data ?? []) as Array<{ applied_sen?: number | null; settled_at?: string | null }>;
  let unfinished: 'post' | 'cancel' | null = null;
  if (head.status === 'POSTED' && normalizePurpose(head.purpose ?? null) === 'SUPPLIER_PAYMENT' && rawAllocs.some((r) => !r.settled_at)) unfinished = 'post';
  if (head.status === 'CANCELLED') {
    if (rawAllocs.some((r) => Number(r.applied_sen ?? 0) > 0)) unfinished = 'cancel';
    else if (head.pv_number) {
      const { data: liveJe, error: liveErr } = await scopeToCompany(sb.from('journal_entries')
        .select('id').eq('source_type', 'PV').eq('source_doc_no', head.pv_number).or('reversed.is.null,reversed.eq.false'), c).limit(1);
      if (liveErr) return c.json({ error: 'load_failed', reason: liveErr.message }, 500);
      if (((liveJe ?? []) as unknown[]).length > 0) unfinished = 'cancel';
    }
  }
  return c.json({ paymentVoucher: { ...h.data, ...described.byId.get(id), je_no: jn.byPv.get(String((h.data as { pv_number: string }).pv_number)) ?? null }, lines: i.data ?? [], allocations, unfinished });
});


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
    source?: 'PV' | 'AP_INVOICE';
  },
): Promise<void> {
  const coId = activeCompanyId(c);
  if (coId == null) return;
  if (input.source !== 'AP_INVOICE' && normalizePurpose(input.purpose) === 'SUPPLIER_PAYMENT') return;
  const payee = (input.payeeName ?? '').trim();
  if (!payee) return;
  const key = normalizeVendor(payee);
  if (!key) return;
  const first = [...input.lines].sort((a, b) => a.line_no - b.line_no)[0];
  if (!first?.debit_account_code) return;

  try {
    const { data: existing, error: readErr } = await sb
      .from('acc_vendor_memory')
      .select('times_seen')
      .eq('company_id', coId)
      .eq('vendor_key', key)
      .maybeSingle();
    if (readErr) return;

    const { error: writeErr } = await sb.from('acc_vendor_memory').upsert({
      company_id: coId,
      vendor_key: key,
      payee_name: payee,
      debit_account_code: first.debit_account_code,
      purpose: normalizePurpose(input.purpose),
      times_seen: ((existing as { times_seen?: number } | null)?.times_seen ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,vendor_key' });
    if (writeErr) return;
  } catch {
  }
}

async function supplierOwnControl(
  c: any, purposeRaw: unknown, supplierIdRaw: unknown,
): Promise<{ code: string | null; control: string | null; wrong: string | null } | { resp: Response }> {
  const none = { code: null, control: null, wrong: null };
  if (isRefund(purposeRaw)) return { ...none, control: await refundOwnControl(c.get('supabase'), activeCompanyId(c)) };
  if (normalizePurpose(purposeRaw) !== 'SUPPLIER_PAYMENT' || !supplierIdRaw) return none;
  const coId = activeCompanyId(c);
  if (coId == null) return none;
  const sb = c.get('supabase');
  const { data: sup, error: supErr } = await sb.from('suppliers')
    .select('code').eq('id', String(supplierIdRaw)).maybeSingle();
  if (supErr) return { resp: c.json({ error: 'load_failed', reason: supErr.message }, 500) };
  const code = (sup as { code?: string | null } | null)?.code ?? null;
  if (!code) return none;
  const roles = await resolveRoles(sb, coId);
  const role = apControlRole(code);
  return { code, control: roles[role], wrong: role === 'AP_OTHER' ? roles.AP : roles.AP_OTHER };
}

export const createPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  return createPaymentVoucherCore(c, body);
};
/** The voucher raised from a body already in hand — the door above (a refund from an order's money panel is a payment request since 2026-10-14). */
export const createPaymentVoucherCore = async (c: any, body: Record<string, unknown>) => {
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

  const refund = isRefund(body.purpose) ? await refundCreateGuard(c, body) : null;
  if (refund && !refund.ok) return refund.resp;
  const built = refund && refund.ok ? { rows: refund.rows, total: refund.total } : buildLines(body.lines);
  if ('error' in built) return c.json({ error: built.error }, 400);
  if (built.rows.some((r) => r.debit_account_code === creditAccountCode)) {
    return c.json({ error: 'same_account', message: 'A line cannot debit the Paid From account itself — pick a different destination.' }, 400);
  }
  const eventErr = await pvLineEventRefusal(c, body.purpose, built.rows);
  if (eventErr) return eventErr;
  /* 申请付款: the request(s) this voucher answers, still waiting (lib/payment-request.ts). */
  const prq = await paymentRequestsLinkGuard(c, body.paymentRequestIds ?? body.paymentRequestId, { kind: 'PV', body });
  if ('resp' in prq) return prq.resp;

  /* The AP split (owner 2026-09-03): a 405-x supplier's paper belongs to
     AP_OTHER (405-0000), everyone else's to AP (400-0000) — apControlRole in
     acc/rules.ts is the ONE home. Resolved FIRST because two doors need it:
     the control lock below must let the supplier payment's OWN control line
     through (docs/bugs/0649 — it refused every AP Payment for three days),
     and the wrong-control door refuses the OTHER control. */
  const own = await supplierOwnControl(c, body.purpose, body.supplierId);
  if ('resp' in own) return own.resp;

  if (own.control != null && own.wrong != null && built.rows.some((r) => r.debit_account_code === own.wrong)) {
    return c.json({
      error: 'wrong_ap_control',
      message: `Supplier ${own.code} books to ${own.control} (${apControlRole(own.code) === 'AP_OTHER' ? 'Other Creditors' : 'Account Payable'}) — not ${own.wrong}. Refresh the page and raise the payment again.`,
    }, 400);
  }
  /* 父户不记账 (owner 2026-09-02) at TYPING time — the GL gate (engine rule 3)
     would refuse the same header at approval, but the operator should hear it
     while the form is still open. The supplier payment's own AP-control line
     is the one line this door does not judge: the system wrote it, and the
     wrong-control door ABOVE is its check — that door runs first, so a line
     on the OTHER control is refused by name, not as a stray control. */
  {
    const coIdForLeaf = activeCompanyId(c);
    if (coIdForLeaf != null) {
      for (const dCode of [...new Set(built.rows.map((r) => r.debit_account_code))]) {
        if (own.control != null && dCode === own.control) continue;
        const leafErr = await requireLeafAccount(c, coIdForLeaf, dCode);
        if (leafErr) return leafErr;
      }
    }
  }

  const allocBuilt = buildAllocations(body.allocations);
  if ('error' in allocBuilt) return c.json({ error: allocBuilt.error }, 400);
  const purpose = normalizePurpose(body.purpose);
  if (allocBuilt.total > built.total) {
    return c.json({ error: 'allocations_exceed_total', allocated: allocBuilt.total, total: built.total }, 400);
  }

  const bankChargeSen = parseAmountSen(body.bankChargeSen);
  if (bankChargeSen === null) return c.json({ error: 'bank_charge_invalid' }, 400);

  const sb = c.get('supabase'); const user = c.get('user');

  {
    const outside = await allocationPisOutsideCompany(sb, c, piIdsOf(allocBuilt.rows));
    if (outside.length > 0) return c.json(ALLOCATION_NOT_THIS_COMPANY(outside), 404);
    const held = await allocationPisOnHold(sb, c, piIdsOf(allocBuilt.rows));
    if (held.length > 0) return c.json(ALLOCATION_ON_HOLD(held), 409);
    const outsideApi = await allocationApInvoicesOutsideCompany(sb, c, apInvoiceIdsOf(allocBuilt.rows));
    if (outsideApi.length > 0) return c.json(ALLOCATION_NOT_THIS_COMPANY(outsideApi), 404);
    /* Headroom (docs/bugs/0653): what other unposted vouchers already applied
       to these invoices is spoken for. */
    const breach = await allocationHeadroomBreach(sb, c, allocBuilt.rows, null);
    if (breach) return c.json(breach, breach.error === 'load_failed' ? 500 : 409);
  }
  const currency = normalizeCurrency(body.currency);
  const pvRateRaw = body.exchangeRate !== undefined && body.exchangeRate !== null
    ? body.exchangeRate
    : await masterRateForCurrency(sb, currency);
  const exchangeRate = normalizeExchangeRate(pvRateRaw, currency);

  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const voucherDate = dateOrNull(body.voucherDate) ?? todayMyt();
  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; pv_number: string }>(
    () => nextPvDraftNo(sb, c, voucherDate),
    (pvNumber) => sb.from('payment_vouchers').insert({
      company_id:          activeCompanyId(c),
      pv_number:           pvNumber,
      voucher_date:        voucherDate,
      payee_name:          payeeName,
      supplier_id:         (body.supplierId as string | undefined) ?? null,
      credit_account_code: creditAccountCode,
      currency,
      exchange_rate:       exchangeRate,
      purpose,
      notes:               (body.notes as string | undefined) ?? null,
      ...payToFields(body), // the bank it pays into (owner 2026-11-08)
      total_sen:         built.total,
      bank_charge_sen:     bankChargeSen,
      status:              'DRAFT',
      created_by:          user.id,
      ...(refund && refund.ok ? refund.fields : {}),
      ...pvBillFields(body, prq.requests.length === 1 ? prq.requests[0] : null),
      ...officialOwedFields(body, officialActor(c)), // 欠正式单 — paid on a proforma (lib/official-doc.ts)
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; pv_number: string };
  const auditActor = c.get('houzsUser');
  const rollbackHeader = () => {
    const del = sb.from('payment_vouchers').delete().eq('id', h.id);
    const coId = activeCompanyId(c);
    return coId == null ? del : scopeToCompanyId(del, coId);
  };

  const rowsWithId = built.rows.map((r) => ({ ...r, pv_id: h.id }));
  const { error: lErr } = await sb.from('payment_voucher_lines').insert(stampCompany(rowsWithId, c));
  if (lErr) { await rollbackHeader(); return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500); }

  if (allocBuilt.rows.length > 0) {
    const allocRows = allocBuilt.rows.map((r) => ({ ...r, pv_id: h.id }));
    const { error: aErr } = await sb.from('pv_allocations').insert(stampCompany(allocRows, c));
    if (aErr) { await rollbackHeader(); return c.json({ error: 'allocations_insert_failed', reason: aErr.message }, 500); }
  }
  if (prq.requests.length > 0) {
    const linked = await linkPaymentRequests(c, prq.requests, { kind: 'PV', id: h.id, number: h.pv_number });
    if (!linked.ok) { await rollbackHeader(); return c.json(linked.body, linked.status); }
  }

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
      ...(refund && refund.ok ? [fieldChange('refundSourceDocNo', null, String(refund.fields.refund_source_doc_no))] : []),
    ]),
  });

  await learnVendorMemory(sb, c, { payeeName, purpose, lines: built.rows });

  return c.json({ id: h.id, pvNumber: h.pv_number }, 201);
};
paymentVouchers.post('/', createPaymentVoucherHandler);


export const updatePaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

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
  const editable = pvCanEdit(before as PvApprovalShape);
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
  if (body.voucherDate !== undefined) {
    const d = dateOrNull(body.voucherDate);
    if (!d) return c.json({ error: 'voucher_date_required' }, 400);
    updates.voucher_date = d;
  }
  if (body.supplierId !== undefined) updates.supplier_id = (body.supplierId as string | null) || null;
  if (body.notes !== undefined) updates.notes = (body.notes as string | null) ?? null;
  Object.assign(updates, payToUpdates(body));
  if (body.bankChargeSen !== undefined) {
    const v = parseAmountSen(body.bankChargeSen);
    if (v === null) return c.json({ error: 'bank_charge_invalid' }, 400);
    updates.bank_charge_sen = v;
  }
  Object.assign(updates, pvBillUpdates(body), officialOwedUpdates(body, officialActor(c), before));
  if (body.purpose !== undefined) updates.purpose = normalizePurpose(body.purpose);

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

  let newTotal: number | undefined;
  let newLines: Array<{ line_no: number; debit_account_code: string }> | undefined;
  if (isRefund(before.purpose) && body.refundAmountSen !== undefined) {
    const re = await refundCreateGuard(c, { refundSourceType: before.refund_source_type, refundSourceDocNo: before.refund_source_doc_no, refundAmountSen: body.refundAmountSen }, id);
    if (!re.ok) return re.resp;
    body.lines = re.rows.map((r) => ({ description: r.description, debitAccountCode: r.debit_account_code, amountSen: r.amount_sen }));
  } else if (isRefund(before.purpose) && body.lines !== undefined) {
    return c.json({ error: 'refund_lines_fixed', message: 'A refund has one line the system writes — change the refund amount instead.' }, 400);
  }
  if (body.lines !== undefined) {
    const built = buildLines(body.lines);
    if ('error' in built) return c.json({ error: built.error }, 400);
    const effectiveCredit = updates.credit_account_code != null
      ? String(updates.credit_account_code)
      : String(before.credit_account_code ?? '');
    if (built.rows.some((r) => r.debit_account_code === effectiveCredit)) {
      return c.json({ error: 'same_account', message: 'A line cannot debit the Paid From account itself — pick a different destination.' }, 400);
    }
    const eventErr = await pvLineEventRefusal(c, body.purpose !== undefined ? body.purpose : before.purpose, built.rows);
    if (eventErr) return eventErr;
    /* 父户不记账 — the same typing-time door the create path holds, BEFORE the
       old lines are deleted, so a refused edit changes nothing — and the same
       exemption for a supplier payment's own AP-control line (docs/bugs/0649),
       against the EFFECTIVE purpose and supplier of this edit. */
    const own = await supplierOwnControl(
      c,
      body.purpose !== undefined ? body.purpose : before.purpose,
      body.supplierId !== undefined ? body.supplierId : before.supplier_id,
    );
    if ('resp' in own) return own.resp;
    for (const dCode of [...new Set(built.rows.map((r) => r.debit_account_code))]) {
      if (own.control != null && dCode === own.control) continue;
      const leafErr = await requireLeafAccount(c, co.companyId, dCode);
      if (leafErr) return leafErr;
    }
    await sb.from('payment_voucher_lines').delete().eq('pv_id', id);
    const { error: lErr } = await sb.from('payment_voucher_lines').insert(stampCompany(built.rows.map((r) => ({ ...r, pv_id: id })), c));
    if (lErr) return c.json({ error: 'lines_update_failed', reason: lErr.message }, 500);
    updates.total_sen = built.total;
    newTotal = built.total;
    newLines = built.rows;
  }

  if (body.allocations !== undefined) {
    const allocBuilt = buildAllocations(body.allocations);
    if ('error' in allocBuilt) return c.json({ error: allocBuilt.error }, 400);
    const total = newTotal ?? Number(before.total_sen);
    if (allocBuilt.total > total) {
      return c.json({ error: 'allocations_exceed_total', allocated: allocBuilt.total, total }, 400);
    }
    {
      const outside = await allocationPisOutsideCompany(sb, c, piIdsOf(allocBuilt.rows));
      if (outside.length > 0) return c.json(ALLOCATION_NOT_THIS_COMPANY(outside), 404);
      const held = await allocationPisOnHold(sb, c, piIdsOf(allocBuilt.rows));
      if (held.length > 0) return c.json(ALLOCATION_ON_HOLD(held), 409);
      const outsideApi = await allocationApInvoicesOutsideCompany(sb, c, apInvoiceIdsOf(allocBuilt.rows));
      if (outsideApi.length > 0) return c.json(ALLOCATION_NOT_THIS_COMPANY(outsideApi), 404);
      /* Headroom (docs/bugs/0653) — this voucher's own rows are excluded by id,
         so re-saving what it already applies is never a breach. */
      const breach = await allocationHeadroomBreach(sb, c, allocBuilt.rows, id);
      if (breach) return c.json(breach, breach.error === 'load_failed' ? 500 : 409);
    }
    await sb.from('pv_allocations').delete().eq('pv_id', id);
    if (allocBuilt.rows.length > 0) {
      const { error: aErr } = await sb.from('pv_allocations').insert(stampCompany(allocBuilt.rows.map((r) => ({ ...r, pv_id: id })), c));
      if (aErr) return c.json({ error: 'allocations_update_failed', reason: aErr.message }, 500);
    }
  }

  const { data, error } = await sb.from('payment_vouchers').update(updates).eq('id', id).select(HEADER).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

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

paymentVouchers.patch('/:id/text', updatePaymentVoucherTextHandler);


const matchVoucherOnBankBestEffort = async (
  sb: any, companyId: number | null, pvNumber: string | null, creditAccountCode: string | null, actor: string | null,
): Promise<void> => {
  if (companyId == null) return;
  try {
    const r = await matchBankLinesNamingVoucher(sb, companyId, { pvNumber, creditAccountCode }, actor);
    // eslint-disable-next-line no-console
    if (!r.ok) console.error('[payment-vouchers] bank line not matched after post:', pvNumber, r.reason);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payment-vouchers] bank line not matched after post:', pvNumber, err instanceof Error ? err.message : String(err));
  }
};

export const postPaymentVoucherHandler = async (c: any) => {
  /* The approve key implies the post door — approval IS the posting now
     (owner 2026-09-02: 当approved 了才会进gl), and approvePaymentVoucherHandler
     walks straight in here. The standalone post key still opens it alone. */
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post') && !hasHouzsPerm(c, 'scm.payment_voucher.approve')) {
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
    company_id: number | null; bank_charge_sen: number | null;
    supplier: { code: string | null; name: string | null } | null;
  };
  if (pv.status === 'CANCELLED') return c.json({ error: 'cannot_post', message: 'Voucher is cancelled' }, 409);

  const { data: existingRows, error: existingErr } = await scopeToCompanyId(sb.from('journal_entries')
    .select('id, je_no, reversed').eq('source_type', 'PV').eq('source_doc_no', pv.pv_number), co.companyId);
  if (existingErr) {
    return c.json({ error: 'post_failed', message: `Could not check whether this voucher is already posted: ${existingErr.message}` }, 500);
  }
  const active = ((existingRows ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>).find((r) => !r.reversed);
  if (active) {
    if (pv.status !== 'POSTED') {
      const { error: flipErr } = await scopeToCompanyId(sb.from('payment_vouchers')
        .update({ status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id), co.companyId).neq('status', 'CANCELLED');
      if (flipErr) return c.json({ error: 'post_failed', message: `The journal is in, but the voucher could not be marked posted: ${flipErr.message}. Press Post again.` }, 500);
    }
    const finished = await finishPostedVoucher(c, sb, pvRaw as Record<string, unknown>, { id, companyId: pv.company_id ?? null, postedTotalSen: null, refund: isRefund(pv.purpose), supplierPayment: normalizePurpose(pv.purpose) === 'SUPPLIER_PAYMENT', actor: approvalActor(c) });
    return c.json({ ok: true, alreadyPosted: true, jeNo: active.je_no, jeId: active.id, ...finished });
  }

  const gate = pvCanPost(pv as unknown as PvApprovalShape);
  if (!gate.ok) return c.json({ error: gate.error, message: gate.message }, 409);

  const { data: linesRaw } = await sb.from('payment_voucher_lines')
    .select('line_no, description, debit_account_code, amount_sen, project_id').eq('pv_id', id).order('line_no');
  const lines = (linesRaw ?? []) as Array<{ line_no: number; description: string | null; debit_account_code: string; amount_sen: number; project_id?: number | null }>;
  if (lines.length === 0) return c.json({ error: 'no_lines', message: 'Voucher has no lines to post' }, 400);

  const rawRate = Number(pv.exchange_rate ?? 1);
  const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
  const debitLegs = lines.map((l) => ({ ...l, myrSen: Math.round(Number(l.amount_sen) * rate) }));
  const totalSen = debitLegs.reduce((s, l) => s + l.myrSen, 0);
  if (totalSen <= 0) return c.json({ error: 'zero_total', message: 'Voucher total is zero' }, 400);

  const supplier = pv.supplier ?? { code: null, name: null };
  const companyId = pv.company_id ?? null;
  /* The supplier's own AP control, for the rule to stamp the supplier on the
     leg that IS the sub-ledger (owner 2026-09-06: Dr 405-H001 / Cr bank — the
     invoice side already stamps its Cr leg). Only a supplier payment has one. */
  const apControlCode = normalizePurpose(pv.purpose) === 'SUPPLIER_PAYMENT' && supplier.code
    ? (await resolveRoles(sb, companyId))[apControlRole(supplier.code)]
    : null;

  const feeSen = Number(pv.bank_charge_sen ?? 0);
  if (feeSen > 0) {
    const okFee = await checkExpenseLeaf(sb, co.companyId, PV_BANK_CHARGE_ACCOUNT, 'a bank charge');
    if (!okFee.ok) return c.json({ error: 'bank_charge_account', message: `Bank charges cannot post: ${okFee.reason}` }, okFee.status === 'load_failed' ? 500 : 409);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', entityId: id, action: 'POST', companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  /* The customer's party code: the debtor code when kept, else the header's
     customer_id — the same rule the payment booked with (owner 2026-09-08). */
  const refundPv = pvRaw as { refund_source_type?: string | null; refund_source_doc_no?: string | null; debtor_code?: string | null; customer_id?: string | null };
  const r = await postJournal(sb, {
    companyId,
    entryDate: pv.voucher_date,
    sourceType: 'PV',
    sourceDocNo: pv.pv_number,
    narration: isRefund(pv.purpose) ? `Customer refund ${pv.pv_number} — ${pv.payee_name} (${refundPv.refund_source_doc_no ?? '?'})` : `Payment voucher ${pv.pv_number} — ${pv.payee_name}`,
    lines: (isRefund(pv.purpose)
      ? customerRefundLines({ ...pv, refund_source_doc_no: refundPv.refund_source_doc_no ?? null }, (await resolveRoles(sb, companyId)).AR, { code: customerPartyCode(refundPv.debtor_code, refundPv.customer_id), name: pv.payee_name }, totalSen)
      : pvLines(pv, debitLegs, supplier, apControlCode)
    ).concat(pvBankChargeLines(pv, feeSen)),
  });
  if (!r.ok) {
    if (r.status === 'je_insert_failed') return c.json({ error: 'je_insert_failed', reason: r.reason }, 500);
    if (r.status === 'lines_insert_failed') return c.json({ error: 'lines_insert_failed', reason: r.reason }, 500);
    return c.json({ error: 'post_failed', reason: r.reason ?? r.status }, 500);
  }
  const je = { id: r.jeId, je_no: r.jeNo };

  const { error: flipErr } = await sb.from('payment_vouchers').update({
    status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id).neq('status', 'CANCELLED');
  if (flipErr) {
    return c.json({ error: 'post_failed', message: `Journal ${je.je_no} is in, but the voucher could not be marked posted: ${flipErr.message}. Press Post again to finish.` }, 500);
  }

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

  /* Its payment may already be on a bank statement, the line naming this
     voucher or the Draft number it went out under: matched now, as an upload
     would have (owner 2026-11-10: 直接配那张 PV，不管差几天). */
  await matchVoucherOnBankBestEffort(sb, companyId, pv.pv_number, pv.credit_account_code, approvalActor(c));

  const finished = await finishPostedVoucher(c, sb, pvRaw as Record<string, unknown>, { id, companyId, postedTotalSen: totalSen, refund: isRefund(pv.purpose), supplierPayment: normalizePurpose(pv.purpose) === 'SUPPLIER_PAYMENT', actor: approvalActor(c) });
  return c.json({ ok: true, jeNo: je.je_no, jeId: je.id, totalSen, ...finished });
};
paymentVouchers.post('/:id/post', postPaymentVoucherHandler);


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

/* PREPARE — the old /submit route keeps its path (nothing external breaks)
   but carries the owner's word: the voucher is declared ready and enters the
   checker's queue. It stays EDITABLE (owner: prepare 还可以改) — the first
   yes is what locks it. */
export const submitPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const loaded = await loadPvForApproval(c);
  if ('refusal' in loaded) return loaded.refusal;
  const { sb, id, pv, companyId } = loaded;
  const v = pvCanPrepare(pv as PvApprovalShape);
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
  const v = pvCanWithdraw(pv as PvApprovalShape);
  if (!v.ok) return c.json({ error: v.error, message: v.message }, 409);
  const { error } = await scopeToCompanyId(sb.from('payment_vouchers')
    .update({ submitted_at: null, submitted_by: null, updated_at: new Date().toISOString() })
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

/* CHECK — the first of the owner's two yeses (2026-09-02: prepare 后会多
   两层checking). Locks the voucher and puts it on Daily Bank's pending.
   Its own key; the same person MAY also hold approve (可以同一个人). */
export const checkPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.check')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const loaded = await loadPvForApproval(c);
  if ('refusal' in loaded) return loaded.refusal;
  const { sb, id, pv, companyId } = loaded;
  const v = pvCanCheck(pv as PvApprovalShape);
  if (!v.ok) return c.json({ error: v.error, message: v.message }, 409);
  const who = approvalActor(c);
  const at = new Date().toISOString();

  const oldPvNo = String(pv.pv_number ?? '');
  let newPvNo: string | null = null;
  if (isDraftNumber(oldPvNo)) {
    for (let attempt = 0; attempt < 8 && newPvNo == null; attempt += 1) {
      const minted = await mintFormalPvNo(sb, c, companyId, String(pv.credit_account_code ?? ''), String(pv.voucher_date ?? ''), isRefund(pv.purpose) ? 'RF' : 'PV');
      if (!minted.ok) return c.json(minted.body, minted.status as 409);
      const { error: numErr } = await scopeToCompanyId(sb.from('payment_vouchers')
        .update({ pv_number: minted.pvNo, updated_at: at }).eq('id', id), companyId);
      if (!numErr) { newPvNo = minted.pvNo; break; }
      const collided = String(numErr.code ?? '') === '23505' || /duplicate key/i.test(String(numErr.message ?? ''));
      if (!collided) return c.json({ error: 'save_failed', reason: numErr.message }, 500);
    }
    if (newPvNo == null) return c.json({ error: 'save_failed', reason: 'could not mint a formal voucher number after 8 attempts' }, 500);
  }

  const { error } = await scopeToCompanyId(sb.from('payment_vouchers')
    .update({ checked_at: at, checked_by: who, updated_at: at }).eq('id', id), companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: newPvNo ?? oldPvNo,
    action: 'CHECK', actor: c.get('houzsUser'), statusSnapshot: 'DRAFT',
    fieldChanges: compactChanges([
      fieldChange('checked_by', null, who),
      ...(newPvNo ? [fieldChange('pv_number', oldPvNo, newPvNo)] : []),
    ]),
  });
  return c.json({ id, checkedAt: at, checkedBy: who, ...(newPvNo ? { pvNumber: newPvNo } : {}) });
};
paymentVouchers.post('/:id/check', checkPaymentVoucherHandler);

/* APPROVE — the second yes IS the posting (owner: 当approved 了才会进gl).
   Stamps approval, then walks straight through the post door in the same
   request; the response is the post's (jeNo and all). If posting dies after
   the stamp, approving again resumes it — the stamp is not rewritten, and
   the post handler's idempotency echo makes the retry safe. */
export const approvePaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.approve')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const loaded = await loadPvForApproval(c);
  if ('refusal' in loaded) return loaded.refusal;
  const { sb, id, pv, companyId } = loaded;
  const evErr = await pvEventAccountRefusal(c, companyId, id); // 需要 Event — lib/event-accounts.ts (item 4)
  if (evErr) return evErr;
  const resume = pv.status === 'DRAFT' && pv.approved_at != null;
  if (!resume) {
    const v = pvCanApprove(pv as PvApprovalShape);
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
  }
  return postPaymentVoucherHandler(c);
};
paymentVouchers.post('/:id/approve', approvePaymentVoucherHandler);

/* REJECT — at EITHER checking layer, by either key; everything comes off
   and the voucher is a raw draft again (owner: 一律退回 Draft), the why on
   its audit trail. */
export const rejectPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.approve') && !hasHouzsPerm(c, 'scm.payment_voucher.check')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const loaded = await loadPvForApproval(c);
  if ('refusal' in loaded) return loaded.refusal;
  const { sb, id, pv, companyId } = loaded;
  const v = pvCanReject(pv as PvApprovalShape);
  if (!v.ok) return c.json({ error: v.error, message: v.message }, 409);
  let note = '';
  try { note = String(((await c.req.json()) as { note?: unknown })?.note ?? '').trim(); } catch { }
  const { error } = await scopeToCompanyId(sb.from('payment_vouchers')
    .update({ submitted_at: null, submitted_by: null, checked_at: null, checked_by: null, approved_at: null, approved_by: null, updated_at: new Date().toISOString() })
    .eq('id', id), companyId);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: pv.pv_number,
    action: 'REJECT', actor: c.get('houzsUser'), statusSnapshot: 'DRAFT',
    fieldChanges: compactChanges([fieldChange('rejection_note', null, note || '(no note)')]),
  });
  return c.json({ id, rejected: true });
};
paymentVouchers.post('/:id/reject', rejectPaymentVoucherHandler);


export const cancelPaymentVoucherHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const sb = c.get('supabase'); const id = c.req.param('id');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(
    sb.from('payment_vouchers').select('id, status, pv_number, purpose, currency, exchange_rate, company_id, total_sen, payee_name, debtor_code').eq('id', id), co.companyId,
  ).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const head = cur as {
    id: string; status: string; pv_number: string; purpose: string | null;
    currency: string | null; exchange_rate: string | number | null; company_id: number | null;
    total_sen: number; payee_name: string; debtor_code?: string | null;
  };
  if (head.status === 'CANCELLED') {
    const finished = await finishCancelledVoucher(c, sb, head, { id, companyId: co.companyId, resumed: true, refund: isRefund(head.purpose), supplierPayment: normalizePurpose(head.purpose) === 'SUPPLIER_PAYMENT', actor: approvalActor(c), reverse: reversePvAccounting });
    return c.json({ paymentVoucher: { id, status: 'CANCELLED' }, ...finished });
  }

  {
    const { data: adv, error: advErr } = await sb.from('acc_supplier_advances')
      .select('id, applied_sen').eq('pv_id', id).maybeSingle();
    if (advErr) return c.json({ error: 'load_failed', reason: advErr.message }, 500);
    const a = adv as { applied_sen: number } | null;
    if (a && Number(a.applied_sen) > 0) {
      return c.json({
        error: 'advance_applied',
        message: `This voucher's advance has already knocked off ${fmtSen(Number(a.applied_sen))} of invoices. A payment whose value now lives inside other documents cannot be cancelled.`,
      }, 409);
    }
  }

  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_VOUCHER', entityId: id, action: 'CANCEL' });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

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

  const { error: advDelErr } = await sb.from('acc_supplier_advances').delete().eq('pv_id', id).eq('applied_sen', 0);
  if (advDelErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pv-advance] cancelled voucher kept its unspent advance:', cancelled.pv_number, advDelErr.message);
  }

  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_VOUCHER',
    entityId: id,
    entityDocNo: cancelled.pv_number,
    action: 'CANCEL',
    actor: c.get('houzsUser'),
    statusSnapshot: 'CANCELLED',
    fieldChanges: statusChange(head.status, 'CANCELLED'),
  });

  const finished = await finishCancelledVoucher(c, sb, head, { id, companyId: co.companyId, resumed: false, refund: isRefund(head.purpose), supplierPayment: normalizePurpose(head.purpose) === 'SUPPLIER_PAYMENT', actor: approvalActor(c), reverse: reversePvAccounting });
  return c.json({
    paymentVoucher: { id: cancelled.id, status: cancelled.status },
    ...finished,
  });
};
paymentVouchers.post('/:id/cancel', cancelPaymentVoucherHandler);

/* ── Supplier advances — 预付挂在 supplier (owner, 2026-08-30) ────────────────
   The ledger of vouchers that paid AHEAD of any invoice, and the knock-off
   that spends them. Applying an advance posts NOTHING: the money already
   debited AP when the voucher posted, the invoice already credited AP when it
   posted — this only settles the invoice's paid_sen and burns the advance. */

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
paymentVouchers.get('/reservations/list', pendingReservationsHandler);

export const applyAdvanceHandler = async (c: any) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase'); const id = c.req.param('id');

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  type Want = { piId: string; apInvoiceId: string; amountSen: number };
  const wants: Want[] = (Array.isArray(body.allocations) ? body.allocations : [])
    .map((a: any): Want => ({ piId: String(a.piId ?? ''), apInvoiceId: String(a.apInvoiceId ?? ''), amountSen: Math.round(Number(a.amountSen ?? 0)) }))
    .filter((a: Want) => (a.piId !== '') !== (a.apInvoiceId !== '') && Number.isFinite(a.amountSen) && a.amountSen > 0);
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
      message: `That applies ${fmtSen(askedSen)} but only ${fmtSen(remaining)} of this advance remains.`,
    }, 409);
  }

  const piIds = wants.flatMap((w) => (w.piId ? [w.piId] : []));
  const apIds = wants.flatMap((w) => (w.apInvoiceId ? [w.apInvoiceId] : []));
  const outside = [
    ...await allocationPisOutsideCompany(sb, c, piIds),
    ...await allocationApInvoicesOutsideCompany(sb, c, apIds),
  ];
  if (outside.length > 0) return c.json(ALLOCATION_NOT_THIS_COMPANY(outside), 404);
  const held = await allocationPisOnHold(sb, c, piIds);
  if (held.length > 0) return c.json(ALLOCATION_ON_HOLD(held), 409);

  const { data: rows, error: applyErr } = await sb.rpc('apply_supplier_advance', {
    p_pv_id: id,
    p_company_id: co.companyId,
    p_wants: wants.map((w) => ({ pi_id: w.piId || null, ap_invoice_id: w.apInvoiceId || null, amount_sen: w.amountSen })),
  });
  if (applyErr) {
    if (String((applyErr as { code?: string }).code ?? '') === 'P0415') {
      return c.json({ error: 'exceeds_advance', message: `${applyErr.message} Refresh and check the remaining figure.` }, 409);
    }
    return c.json({ error: 'apply_failed', message: `Nothing was applied: ${applyErr.message}` }, 500);
  }
  type ApplyRow = { pi_id: string | null; ap_invoice_id: string | null; asked: number; applied: number; remaining: number | null };
  const all = (Array.isArray(rows) ? rows : []) as ApplyRow[];
  const summary = all.find((r) => r.remaining != null);
  const results = all.filter((r) => r.remaining == null).map((r) => ({
    piId: r.pi_id, apInvoiceId: r.ap_invoice_id, askedSen: Number(r.asked), appliedSen: Number(r.applied),
  }));
  const appliedSen = Number(summary?.applied ?? results.reduce((sum, r) => sum + r.appliedSen, 0));

  if (appliedSen > 0) {
    await recordEntityAudit(sb, {
      entityType: 'PAYMENT_VOUCHER', entityId: id, entityDocNo: adv.pv_number,
      action: 'UPDATE', actor: c.get('houzsUser'), companyId: co.companyId,
      note: `Advance knocked off ${fmtSen(appliedSen)} against ${results.filter((r) => r.appliedSen > 0).length} invoice(s) — no money moved, both legs were already in AP`,
      fieldChanges: compactChanges([
        fieldChange('advanceAppliedSen', adv.applied_sen, Number(adv.applied_sen) + appliedSen),
      ]),
    });
  }

  return c.json({
    ok: true,
    appliedSen,
    remainingSen: summary?.remaining != null ? Number(summary.remaining) : remaining - appliedSen,
    results,
  });
};
paymentVouchers.post('/:id/apply-advance', applyAdvanceHandler);

export { extractBillsHandler, splitPdfHandler };
paymentVouchers.post('/extract', extractBillsHandler);
paymentVouchers.post('/extract/enqueue', enqueueBillReadsHandler);
paymentVouchers.get('/extract/jobs', pollBillReadsHandler);
paymentVouchers.post('/split-pdf', splitPdfHandler);

async function reversePvAccounting(
  sb: any,
  pvNumber: string,
): Promise<{ ok: boolean; status: string; jeNo?: string; jeId?: string; reason?: string }> {
  return reverseJournal(sb, {
    sourceType: 'PV',
    sourceDocNo: pvNumber,
    narration: (orig) => `Reversal of ${orig.je_no} — Payment voucher ${pvNumber} cancelled`,
  });
}
