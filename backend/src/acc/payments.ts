// ----------------------------------------------------------------------------
// acc/payments — customer payments into the ledger, through the one gate.
//
// The sales side already records payments well (2,703 rows, RM 9.34M at the
// time this module landed) — what it never did is book them. This module owns
// that booking: Dr cash/bank/acquirer-transit, Cr AR, per the rules table.
//
// Idempotent per payment ROW: source_type 'SOPAY'/'SIPAY', source_doc_no = the
// payment row's uuid. The engine's guard fails closed and the database's
// acc_je_one_active_source index refuses a duplicate ACTIVE posting outright,
// so the insert hook, the backfill endpoint and any retry can all run against
// the same row without double-booking a sen.
//
// What is deliberately NOT posted:
//   • method = 'imported' — migration-era rows; AutoCount's book already
//     carries that money (the same seam as migrated_no_stock documents).
//   • zero/negative amounts — a refund is a different document, not a
//     negative receipt.
// ----------------------------------------------------------------------------

import { postJournal, reverseJournal } from './engine';
import { resolveRoles, customerPaymentLines } from './rules';

export type SoPaymentRow = {
  id: string;
  so_doc_no: string;
  paid_at: string | null;
  method: string;
  merchant_provider: string | null;
  amount_sen: number;
  company_id: number | null;
};

export type PostPaymentResult =
  | { ok: true; status: 'posted' | 'already_posted'; jeNo: string; jeId: string }
  | { ok: true; status: 'skipped_imported' | 'skipped_zero' }
  | { ok: false; status: string; reason?: string };

/** Resolve the acquirer's transit account by the DISPLAY name the sales panel
    stores (brief §2.13: same row for screen and ledger). Unmapped or unreadable
    → null, and the caller books to the generic EDC transit LOUDLY. */
async function transitFor(
  sb: any,
  companyId: number | null,
  merchantProvider: string | null,
): Promise<string | null> {
  if (!merchantProvider) return null;
  const { data, error } = await sb
    .from('acc_acquirers')
    .select('transit_account_code, is_active')
    .eq('company_id', companyId == null ? 1 : Number(companyId))
    .eq('display_name', merchantProvider.trim())
    .maybeSingle();
  if (error) {
    /* eslint-disable-next-line no-console */
    console.error('[acc/payments] acquirer lookup failed — using generic EDC transit:', merchantProvider, error.message);
    return null;
  }
  if (!data) {
    /* eslint-disable-next-line no-console */
    console.error(`[acc/payments] UNMAPPED ACQUIRER "${merchantProvider}" — booked to generic EDC transit; add it to scm.acc_acquirers`);
    return null;
  }
  return (data as { transit_account_code: string }).transit_account_code;
}

/** The date the money moved (§2.5: document date drives reports), falling back
    to nothing — a payment with no paid_at is refused rather than dated today. */
const paymentDate = (paidAt: string | null): string | null => {
  const d = (paidAt ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

export async function postSoPayment(sb: any, p: SoPaymentRow): Promise<PostPaymentResult> {
  if (p.method === 'imported') return { ok: true, status: 'skipped_imported' };
  const amountSen = Number(p.amount_sen);
  if (!Number.isInteger(amountSen) || amountSen <= 0) return { ok: true, status: 'skipped_zero' };
  const entryDate = paymentDate(p.paid_at);
  if (!entryDate) return { ok: false, status: 'bad_paid_at', reason: `payment ${p.id} has no usable paid_at` };

  // The SO carries the company and the customer identity for the AR leg.
  const { data: so, error: soErr } = await sb
    .from('mfg_sales_orders')
    .select('company_id, customer_name, customer_phone')
    .eq('doc_no', p.so_doc_no)
    .maybeSingle();
  if (soErr) return { ok: false, status: 'so_read_failed', reason: soErr.message };
  const companyId = (so as { company_id?: number | null } | null)?.company_id ?? p.company_id ?? null;
  const customerName = (so as { customer_name?: string | null } | null)?.customer_name ?? null;

  const roles = await resolveRoles(sb, companyId);
  const transit = p.method === 'merchant' || p.method === 'installment'
    ? await transitFor(sb, companyId, p.merchant_provider)
    : null;

  const r = await postJournal(sb, {
    companyId,
    entryDate,
    sourceType: 'SOPAY',
    sourceDocNo: p.id,
    narration: `Payment ${p.method} on ${p.so_doc_no}${customerName ? ` — ${customerName}` : ''}`,
    lines: customerPaymentLines(roles, {
      method: p.method,
      docNo: p.so_doc_no,
      transitAccountCode: transit,
      customerCode: null,
      customerName,
    }, amountSen),
  });
  if (r.ok) {
    if (r.status === 'already_posted') return { ok: true, status: 'already_posted', jeNo: r.jeNo, jeId: r.jeId };
    return { ok: true, status: 'posted', jeNo: r.jeNo, jeId: r.jeId };
  }
  return { ok: false, status: r.status, reason: r.reason };
}

/** Void the ledger entry for a DELETED payment row. Idempotent; nothing to
    reverse (an imported/never-posted row) is a success. */
export async function reverseSoPayment(
  sb: any,
  paymentId: string,
  soDocNo: string,
): Promise<{ ok: boolean; status: string; reason?: string }> {
  return reverseJournal(sb, {
    sourceType: 'SOPAY',
    sourceDocNo: paymentId,
    narration: (orig) => `Reversal of ${orig.je_no} — payment on ${soDocNo} deleted`,
  });
}

export type SiPaymentRow = {
  id: string;
  sales_invoice_id: string;
  paid_at: string | null;
  method: string;
  merchant_provider: string | null;
  amount_sen: number;
  company_id: number | null;
};

export async function postSiPayment(sb: any, p: SiPaymentRow): Promise<PostPaymentResult> {
  if (p.method === 'imported') return { ok: true, status: 'skipped_imported' };
  const amountSen = Number(p.amount_sen);
  if (!Number.isInteger(amountSen) || amountSen <= 0) return { ok: true, status: 'skipped_zero' };
  const entryDate = paymentDate(p.paid_at);
  if (!entryDate) return { ok: false, status: 'bad_paid_at', reason: `payment ${p.id} has no usable paid_at` };

  const { data: si, error: siErr } = await sb
    .from('sales_invoices')
    .select('invoice_number, company_id, debtor_code, debtor_name, migrated_no_stock')
    .eq('id', p.sales_invoice_id)
    .maybeSingle();
  if (siErr) return { ok: false, status: 'si_read_failed', reason: siErr.message };
  const inv = si as { invoice_number?: string; company_id?: number | null; debtor_code?: string | null; debtor_name?: string | null; migrated_no_stock?: boolean | null } | null;
  if (!inv) return { ok: false, status: 'si_not_found', reason: p.sales_invoice_id };
  /* A migrated invoice booked NO receivable here (AutoCount carries it), so
     its payment must not relieve an AR this ledger never recorded. */
  if (inv.migrated_no_stock === true) return { ok: true, status: 'skipped_imported' };

  const companyId = inv.company_id ?? p.company_id ?? null;
  const roles = await resolveRoles(sb, companyId);
  const transit = p.method === 'merchant' || p.method === 'installment'
    ? await transitFor(sb, companyId, p.merchant_provider)
    : null;

  const r = await postJournal(sb, {
    companyId,
    entryDate,
    sourceType: 'SIPAY',
    sourceDocNo: p.id,
    narration: `Payment ${p.method} on ${inv.invoice_number ?? p.sales_invoice_id}${inv.debtor_name ? ` — ${inv.debtor_name}` : ''}`,
    lines: customerPaymentLines(roles, {
      method: p.method,
      docNo: inv.invoice_number ?? p.sales_invoice_id,
      transitAccountCode: transit,
      customerCode: inv.debtor_code ?? null,
      customerName: inv.debtor_name ?? null,
    }, amountSen),
  });
  if (r.ok) {
    if (r.status === 'already_posted') return { ok: true, status: 'already_posted', jeNo: r.jeNo, jeId: r.jeId };
    return { ok: true, status: 'posted', jeNo: r.jeNo, jeId: r.jeId };
  }
  return { ok: false, status: r.status, reason: r.reason };
}

/* ── Backfill — walk every SO payment row that has no ACTIVE ledger entry and
   post it. Batched and idempotent: safe to call repeatedly until `remaining`
   is zero; a row that fails is reported, not retried in-loop, and does not
   stop the batch (§2.14: the failure list IS the output). */
export async function backfillSoPayments(
  sb: any,
  batchLimit = 200,
): Promise<{ ok: boolean; scanned: number; posted: number; skipped: number; failed: Array<{ id: string; status: string; reason?: string }>; remaining: number; reason?: string }> {
  // Every payment id that already carries an ACTIVE entry.
  const postedIds = new Set<string>();
  {
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await sb
        .from('journal_entries')
        .select('source_doc_no, reversed')
        .eq('source_type', 'SOPAY')
        .order('id')
        .range(from, from + page - 1);
      if (error) return { ok: false, scanned: 0, posted: 0, skipped: 0, failed: [], remaining: -1, reason: `journal scan: ${error.message}` };
      const rows = (data ?? []) as Array<{ source_doc_no: string | null; reversed: boolean | null }>;
      for (const r of rows) if (r.source_doc_no && !r.reversed) postedIds.add(r.source_doc_no);
      if (rows.length < page) break;
      from += page;
    }
  }

  // Candidate payment rows, oldest first — a deterministic, resumable order.
  const candidates: SoPaymentRow[] = [];
  {
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await sb
        .from('mfg_sales_order_payments')
        .select('id, so_doc_no, paid_at, method, merchant_provider, amount_sen, company_id')
        .neq('method', 'imported')
        .order('paid_at')
        .order('id')
        .range(from, from + page - 1);
      if (error) return { ok: false, scanned: 0, posted: 0, skipped: 0, failed: [], remaining: -1, reason: `payments scan: ${error.message}` };
      const rows = (data ?? []) as SoPaymentRow[];
      for (const r of rows) if (!postedIds.has(r.id)) candidates.push(r);
      if (rows.length < page) break;
      from += page;
    }
  }

  const batch = candidates.slice(0, batchLimit);
  let posted = 0;
  let skipped = 0;
  const failed: Array<{ id: string; status: string; reason?: string }> = [];
  for (const p of batch) {
    const r = await postSoPayment(sb, p);
    if (r.ok && (r.status === 'posted' || r.status === 'already_posted')) posted += 1;
    else if (r.ok) skipped += 1;
    else failed.push({ id: p.id, status: r.status, reason: r.reason });
  }

  return {
    ok: true,
    scanned: candidates.length,
    posted,
    skipped,
    failed,
    remaining: Math.max(0, candidates.length - batch.length) + failed.length,
  };
}

/** Void the ledger entry for a DELETED SI payment row. Idempotent. */
export async function reverseSiPayment(
  sb: any,
  paymentId: string,
  invoiceNo: string | null,
): Promise<{ ok: boolean; status: string; reason?: string }> {
  return reverseJournal(sb, {
    sourceType: 'SIPAY',
    sourceDocNo: paymentId,
    narration: (orig) => `Reversal of ${orig.je_no} — payment on ${invoiceNo ?? 'invoice'} deleted`,
  });
}

/** Book every not-yet-booked payment of ONE invoice. The quick-pay route's
    insert does not return the new row, so its hook (and the normal route's)
    posts by convergence instead: the engine's idempotency makes already-booked
    rows no-op, so this is also a per-invoice self-heal. */
export async function postUnpostedSiPayments(
  sb: any,
  salesInvoiceId: string,
): Promise<{ ok: boolean; posted: number; failed: number; reason?: string }> {
  const { data, error } = await sb
    .from('sales_invoice_payments')
    .select('id, sales_invoice_id, paid_at, method, merchant_provider, amount_sen, company_id')
    .eq('sales_invoice_id', salesInvoiceId);
  if (error) return { ok: false, posted: 0, failed: 0, reason: error.message };
  let posted = 0;
  let failed = 0;
  for (const row of (data ?? []) as SiPaymentRow[]) {
    const r = await postSiPayment(sb, row);
    if (r.ok) {
      if (r.status === 'posted') posted += 1;
    } else {
      failed += 1;
      /* eslint-disable-next-line no-console */
      console.error('[acc/payments] SI payment not booked:', row.id, r.status, r.reason);
    }
  }
  return { ok: true, posted, failed };
}

/* ── Payments that never reached the ledger ────────────────────────────────
   A booking failure does NOT fail the operator's save: sales must be able to
   record money whatever the accounting module is doing (so-payment-row.ts logs
   and carries on). The cost of that choice is that a failure is INVISIBLE —
   the money is on the order and not in the books, and only a server log knows.

   Owner, asked whether the accounting page should say so: 要.

   THE CUTOFF IS THE WHOLE PROBLEM. About 2,700 historical payments are
   deliberately unbooked — the owner's decision during the trial period, no
   backfill until he names an official start date — so a list of "everything
   unbooked" would open on 2,700 rows and be read as noise on day one. A panel
   nobody reads is worse than no panel: it is a silenced alarm.

   So the cutoff is DERIVED: the earliest date this company ever booked a
   payment. Before that date the module was not running here, and unbooked is
   the expected state; on or after it, unbooked means something failed. The
   date is returned so the screen can show it — a derived boundary that nobody
   can see is its own kind of lie. When the owner sets an official start date,
   that replaces this derivation and the rest of this function is unchanged. */

export type UnbookedPayment = {
  source: 'SOPAY' | 'SIPAY';
  id: string;
  docNo: string;
  paidOn: string;
  amountSen: number;
  method: string;
};

export async function unbookedPayments(
  sb: any,
  companyId: number,
): Promise<
  | { ok: true; since: string | null; rows: UnbookedPayment[]; totalSen: number }
  | { ok: false; reason: string }
> {
  /* Every payment id that already carries an ACTIVE entry, and the earliest
     date any of them was booked on. One read serves both. */
  const booked = new Set<string>();
  let since: string | null = null;
  {
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await sb.from('journal_entries')
        .select('source_doc_no, entry_date, reversed, source_type')
        .eq('company_id', companyId)
        .in('source_type', ['SOPAY', 'SIPAY'])
        .range(from, from + page - 1);
      if (error) return { ok: false, reason: `journal scan: ${error.message}` };
      const rows = (data ?? []) as Array<{ source_doc_no: string | null; entry_date: string | null; reversed: boolean | null }>;
      for (const r of rows) {
        if (r.reversed || !r.source_doc_no) continue;
        booked.add(r.source_doc_no);
        const day = String(r.entry_date ?? '').slice(0, 10);
        if (day && (since == null || day < since)) since = day;
      }
      if (rows.length < page) break;
      from += page;
    }
  }

  /* No payment has EVER been booked here, so there is no boundary to draw and
     every payment would be listed. Report the state instead of the list. */
  if (since == null) return { ok: true, since: null, rows: [], totalSen: 0 };

  const rows: UnbookedPayment[] = [];
  const take = (
    source: 'SOPAY' | 'SIPAY',
    raw: Array<Record<string, any>>,
    docOf: (r: Record<string, any>) => string,
  ) => {
    for (const r of raw) {
      const id = String(r.id ?? '');
      if (!id || booked.has(id)) continue;
      /* The same three the poster itself skips, or the panel would report as
         failures the rows it was told to leave alone. */
      const method = String(r.method ?? '');
      if (method === 'imported') continue;
      const amountSen = Number(r.amount_sen ?? 0);
      if (!Number.isInteger(amountSen) || amountSen <= 0) continue;
      const paidOn = String(r.paid_at ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn < since!) continue;
      rows.push({ source, id, docNo: docOf(r), paidOn, amountSen, method });
    }
  };

  const { data: soRaw, error: soErr } = await sb.from('mfg_sales_order_payments')
    .select('id, so_doc_no, paid_at, amount_sen, method')
    .eq('company_id', companyId).gte('paid_at', since);
  if (soErr) return { ok: false, reason: `SO payments: ${soErr.message}` };
  take('SOPAY', (soRaw ?? []) as Array<Record<string, any>>, (r) => String(r.so_doc_no ?? ''));

  const { data: siRaw, error: siErr } = await sb.from('sales_invoice_payments')
    .select('id, sales_invoice_id, paid_at, amount_sen, method')
    .eq('company_id', companyId).gte('paid_at', since);
  if (siErr) return { ok: false, reason: `SI payments: ${siErr.message}` };
  take('SIPAY', (siRaw ?? []) as Array<Record<string, any>>, (r) => String(r.sales_invoice_id ?? ''));

  /* Oldest first: the one that has been wrong longest is the one to chase. */
  rows.sort((a, b) => a.paidOn.localeCompare(b.paidOn));
  return { ok: true, since, rows, totalSen: rows.reduce((s, r) => s + r.amountSen, 0) };
}
