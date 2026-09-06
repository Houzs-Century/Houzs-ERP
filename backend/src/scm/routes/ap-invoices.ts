// ----------------------------------------------------------------------------
// AP Invoices — the non-stock supplier bill (AutoCount's A/P Invoice).
//
// The owner's design (2026-09-06, AutoCount in hand): 可以不可以像 autocount
// 这样 purchase invoice 一边,然后再多一个 AP invoice,这样我就可以把 other
// creditor 的 invoice 放过去,也不会影响 operation 那边的 purchase invoice —
// and, confirmed line by line: 我想要两个都看到, 现有的 purchase invoice remain.
//
//   · the Finance list shows BOTH kinds — the operational purchase invoices as
//     a read-only MIRROR (raised on the Procurement side, untouched here) and
//     the AP invoices raised HERE — one table, a `kind` column;
//   · an AP invoice is Draft → Post → (paid down by AP Payments) → Paid, or
//     Cancelled; posting books Dr each line's OWN account / Cr the supplier's
//     AP control — 400 or 405 by the supplier's code, the same split the PI
//     and the PV use (source API; cancel = the engine's contra);
//   · it is paid by the SAME AP Payment that pays purchase invoices: an
//     allocation names a PI or an AP invoice, and the paid_sen clamp has an
//     identical twin (lib/ap-invoice-settlement.ts).
//
// MYR only in this first cut — an other creditor's rent or service bill —
// foreign bills stay on the purchase-invoice side, which carries the rate
// machinery. Permission keys are the PV family's on purpose: the same people
// raise, post and cancel money documents.
// Numbering: {co}API-YYMM-NNN — a NEW series (flagged to the owner; his prefix).
//
// Evidence and memory (owner 2026-09-06: 做,附件也一起做,bundle 也带上): the
// bill's files live beside it (/:id/files — routes/ap-invoice-files.ts, the
// PV's own factory) and ride the AP Payment's print bundle; a save teaches
// vendor memory (mig 0341) the supplier → first-line account, so the OCR
// (POST /payment-vouchers/extract, shared) pre-fills the next same-vendor
// bill here as it does on a voucher.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId, companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { mintMonthlyDocNo } from '../lib/doc-no';
import { dateOrNull } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { postJournal, reverseJournal } from '../../acc/engine';
import { apInvoiceLines, resolveRoles } from '../../acc/rules';
import { requireLeafAccount } from './accounting-chart';
import { learnVendorMemory } from './payment-vouchers';
import {
  uploadApInvoiceFileHandler, listApInvoiceFilesHandler, streamApInvoiceFileHandler, deleteApInvoiceFileHandler,
} from './ap-invoice-files';
import { supabaseAuth } from '../middleware/auth';

type Row = Record<string, any>;

const PV_KEYS = [
  'scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.check',
  'scm.payment_voucher.approve', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel',
] as const;
const canSee = (c: any): boolean => PV_KEYS.some((k) => hasHouzsPerm(c, k));
const NO_PERM = (what: string) => ({ error: `You don't have permission to ${what}.` });

const yymm = (): string => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const HEADER = 'id, company_id, invoice_number, supplier_id, supplier_invoice_ref, invoice_date, due_date, currency, exchange_rate, total_sen, paid_sen, status, notes, created_at, created_by, posted_at, posted_by, cancelled_at, cancelled_by';
const LINE = 'id, line_no, description, debit_account_code, amount_sen';

type CleanLine = { description: string | null; code: string; amountSen: number };

/** 1–50 lines, each with a leaf account and a positive integer sen. */
function buildLines(raw: unknown): { lines: CleanLine[]; total: number } | { error: string; message: string } {
  const arr = Array.isArray(raw) ? raw : [];
  if (arr.length === 0 || arr.length > 50) return { error: 'lines_required', message: 'An AP invoice takes 1 to 50 lines.' };
  const lines: CleanLine[] = [];
  for (const [i, l] of arr.entries()) {
    const code = String(l?.debitAccountCode ?? '').trim();
    const amount = Number(l?.amountSen);
    if (!code) return { error: 'bad_line', message: `Line ${i + 1} has no account.` };
    if (!Number.isInteger(amount) || amount <= 0) {
      return { error: 'bad_line', message: `Line ${i + 1}: amountSen must be a positive integer (got ${String(l?.amountSen)}).` };
    }
    lines.push({ description: l?.description ? String(l.description).trim() : null, code, amountSen: amount });
  }
  return { lines, total: lines.reduce((s, l) => s + l.amountSen, 0) };
}

async function loadInvoice(c: any, id: string): Promise<{ inv: Row } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('ap_invoices').select(HEADER).eq('id', id), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found', message: 'That AP invoice is not in the company you are working in.' }, 404) };
  return { inv: data as Row };
}

async function loadSupplier(c: any, supplierId: string): Promise<{ supplier: { id: string; code: string | null; name: string | null } } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('suppliers').select('id, code, name').eq('id', supplierId), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'supplier_unknown', message: 'That supplier is not in the company you are working in.' }, 400) };
  return { supplier: data as { id: string; code: string | null; name: string | null } };
}

/* ── GET / — both kinds, one list ─────────────────────────────────────────── */
export const listApInvoicesHandler = async (c: any): Promise<Response> => {
  if (!canSee(c)) return c.json(NO_PERM('see supplier invoices'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const kind = String(c.req.query('kind') ?? 'ALL').toUpperCase();

  const rows: Row[] = [];
  if (kind === 'ALL' || kind === 'API') {
    const { data, error } = await scopeToCompany(
      sb.from('ap_invoices').select(`${HEADER}, supplier:suppliers(id, code, name)`), c,
    ).order('invoice_date', { ascending: false }).limit(500);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    for (const r of (data ?? []) as Row[]) rows.push(shape('API', r));
  }
  if (kind === 'ALL' || kind === 'PI') {
    /* The operational invoices, read-only here: the Procurement page raises
       and edits them; this list only SHOWS them beside the AP invoices so
       the Finance side sees a supplier's whole debt. */
    const { data, error } = await scopeToCompany(
      sb.from('purchase_invoices')
        .select('id, invoice_number, supplier_invoice_ref, supplier_id, invoice_date, due_date, currency, total_sen, paid_sen, status, supplier:suppliers(id, code, name)')
        .in('status', ['POSTED', 'PARTIALLY_PAID', 'PAID', 'ON_HOLD']), c,
    ).order('invoice_date', { ascending: false }).limit(500);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    for (const r of (data ?? []) as Row[]) rows.push(shape('PI', r));
  }
  rows.sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? '')) || String(b.invoiceNumber).localeCompare(String(a.invoiceNumber)));
  return c.json({ rows });
};

function shape(kind: 'API' | 'PI', r: Row): Row {
  const sup = Array.isArray(r.supplier) ? r.supplier[0] : r.supplier;
  const total = Number(r.total_sen ?? 0);
  const paid = Number(r.paid_sen ?? 0);
  return {
    kind,
    id: r.id,
    invoiceNumber: r.invoice_number,
    supplierId: r.supplier_id ?? null,
    supplierCode: sup?.code ?? null,
    supplierName: sup?.name ?? null,
    supplierInvoiceRef: r.supplier_invoice_ref ?? null,
    invoiceDate: r.invoice_date ?? null,
    dueDate: r.due_date ?? null,
    currency: r.currency ?? 'MYR',
    totalSen: total,
    paidSen: paid,
    outstandingSen: Math.max(0, total - paid),
    status: String(r.status ?? ''),
  };
}

/* ── GET /:id — an AP invoice with its lines ─────────────────────────────── */
export const apInvoiceDetailHandler = async (c: any): Promise<Response> => {
  if (!canSee(c)) return c.json(NO_PERM('see supplier invoices'), 403);
  const found = await loadInvoice(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const sb = c.get('supabase');
  const [lines, sup] = await Promise.all([
    scopeToCompany(sb.from('ap_invoice_lines').select(LINE).eq('invoice_id', found.inv.id), c).order('line_no'),
    scopeToCompany(sb.from('suppliers').select('id, code, name').eq('id', found.inv.supplier_id), c).maybeSingle(),
  ]);
  if (lines.error) return c.json({ error: 'load_failed', reason: lines.error.message }, 500);
  if (sup.error) return c.json({ error: 'load_failed', reason: sup.error.message }, 500);
  return c.json({ invoice: found.inv, lines: lines.data ?? [], supplier: sup.data ?? null });
};

/* ── POST / — raise a DRAFT ──────────────────────────────────────────────── */
export const createApInvoiceHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create') && !hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json(NO_PERM('raise an AP invoice'), 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const supplierId = String(body.supplierId ?? '').trim();
  if (!supplierId) return c.json({ error: 'supplier_required', message: 'Pick the supplier this bill is from.' }, 400);
  const currency = String(body.currency ?? 'MYR').trim().toUpperCase() || 'MYR';
  if (currency !== 'MYR') {
    return c.json({ error: 'currency_unsupported', message: 'AP invoices are MYR in this first cut — a foreign bill goes through a purchase invoice, which carries the rate.' }, 400);
  }
  const built = buildLines(body.lines);
  if ('error' in built) return c.json({ error: built.error, message: built.message }, 400);
  const invoiceDate = dateOrNull(body.invoiceDate) ?? todayMyt();
  const dueDate = dateOrNull(body.dueDate);

  const sup = await loadSupplier(c, supplierId);
  if ('resp' in sup) return sup.resp;
  /* Each debit line takes only ordinary LEAVES — the same door the PV's
     lines walk: headers refuse (父户不记账), controls refuse (由模块过账). */
  for (const code of [...new Set(built.lines.map((l) => l.code))]) {
    const leafErr = await requireLeafAccount(c, co.companyId, code);
    if (leafErr) return leafErr;
  }

  const sb = c.get('supabase');
  const invoiceNumber = await mintMonthlyDocNo(sb, 'ap_invoices', 'invoice_number', `${companyDocPrefix(c)}API-${yymm()}`);
  const { data: inv, error: insErr } = await sb.from('ap_invoices').insert({
    company_id: co.companyId,
    invoice_number: invoiceNumber,
    supplier_id: sup.supplier.id,
    supplier_invoice_ref: body.supplierInvoiceRef ? String(body.supplierInvoiceRef).trim() : null,
    invoice_date: invoiceDate,
    due_date: dueDate,
    currency: 'MYR',
    exchange_rate: 1,
    total_sen: built.total,
    paid_sen: 0,
    status: 'DRAFT',
    notes: body.notes ? String(body.notes).trim() : null,
    created_by: String(c.get('user')?.id ?? ''),
  }).select(HEADER).single();
  if (insErr || !inv) return c.json({ error: 'save_failed', reason: insErr?.message ?? 'insert returned nothing' }, 500);

  const { error: lineErr } = await sb.from('ap_invoice_lines').insert(built.lines.map((l, i) => ({
    company_id: co.companyId,
    invoice_id: (inv as Row).id,
    line_no: i + 1,
    description: l.description,
    debit_account_code: l.code,
    amount_sen: l.amountSen,
  })));
  if (lineErr) {
    await sb.from('ap_invoices').delete().eq('company_id', co.companyId).eq('id', (inv as Row).id);
    return c.json({ error: 'save_failed', reason: lineErr.message }, 500);
  }
  /* The habit this bill teaches: the supplier's name → the first line's
     account, so the OCR's next reading of the same vendor's bill pre-fills
     it. A voucher paying a supplier has nothing to teach (its line is the AP
     control); the BILL is where the expense account is chosen — hence the
     source flag, which lifts memory's supplier-payment skip for this call. */
  await learnVendorMemory(sb, c, {
    payeeName: sup.supplier.name, purpose: 'SUPPLIER_PAYMENT', source: 'AP_INVOICE',
    lines: built.lines.map((l, i) => ({ line_no: i + 1, debit_account_code: l.code })),
  });
  return c.json({ ok: true, invoice: inv }, 201);
};

/* ── PATCH /:id — a DRAFT may still change; lines replace whole ──────────── */
export const updateApInvoiceHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create') && !hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json(NO_PERM('edit an AP invoice'), 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const found = await loadInvoice(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  if (found.inv.status !== 'DRAFT') {
    return c.json({ error: 'not_draft', message: `${found.inv.invoice_number} is ${found.inv.status} — a posted bill is corrected by cancelling it and raising it again.` }, 409);
  }
  const sb = c.get('supabase');
  const patch: Row = { updated_at: new Date().toISOString() };
  if (body.supplierId !== undefined) {
    const sup = await loadSupplier(c, String(body.supplierId ?? '').trim());
    if ('resp' in sup) return sup.resp;
    patch.supplier_id = sup.supplier.id;
  }
  if (body.supplierInvoiceRef !== undefined) patch.supplier_invoice_ref = body.supplierInvoiceRef ? String(body.supplierInvoiceRef).trim() : null;
  if (body.invoiceDate !== undefined) patch.invoice_date = dateOrNull(body.invoiceDate) ?? found.inv.invoice_date;
  if (body.dueDate !== undefined) patch.due_date = dateOrNull(body.dueDate);
  if (body.notes !== undefined) patch.notes = body.notes ? String(body.notes).trim() : null;
  if (body.lines !== undefined) {
    const built = buildLines(body.lines);
    if ('error' in built) return c.json({ error: built.error, message: built.message }, 400);
    for (const code of [...new Set(built.lines.map((l) => l.code))]) {
      const leafErr = await requireLeafAccount(c, co.companyId, code);
      if (leafErr) return leafErr;
    }
    await sb.from('ap_invoice_lines').delete().eq('company_id', co.companyId).eq('invoice_id', found.inv.id);
    const { error: lineErr } = await sb.from('ap_invoice_lines').insert(built.lines.map((l, i) => ({
      company_id: co.companyId, invoice_id: found.inv.id, line_no: i + 1,
      description: l.description, debit_account_code: l.code, amount_sen: l.amountSen,
    })));
    if (lineErr) return c.json({ error: 'save_failed', reason: lineErr.message }, 500);
    patch.total_sen = built.total;
  }
  const { data, error } = await sb.from('ap_invoices').update(patch).eq('company_id', co.companyId).eq('id', found.inv.id).select(HEADER).maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, invoice: data });
};

/* ── POST /:id/post — into the ledger, once ──────────────────────────────── */
export const postApInvoiceHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM('post to the general ledger'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadInvoice(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const inv = found.inv;
  if (inv.status === 'CANCELLED') return c.json({ error: 'cancelled', message: `${inv.invoice_number} is cancelled.` }, 409);
  const sb = c.get('supabase');
  const { data: lineRows, error: lErr } = await scopeToCompany(sb.from('ap_invoice_lines').select(LINE).eq('invoice_id', inv.id), c).order('line_no');
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const lines = (lineRows ?? []) as Array<{ description: string | null; debit_account_code: string; amount_sen: number }>;
  if (lines.length === 0) return c.json({ error: 'lines_required', message: 'This bill has no lines to post.' }, 400);
  const sup = await loadSupplier(c, String(inv.supplier_id));
  if ('resp' in sup) return sup.resp;

  const roles = await resolveRoles(sb, co.companyId);
  const je = await postJournal(sb, {
    companyId: co.companyId,
    entryDate: String(inv.invoice_date),
    sourceType: 'API',
    sourceDocNo: String(inv.invoice_number),
    narration: `AP invoice ${inv.invoice_number} — ${sup.supplier.name ?? sup.supplier.code ?? 'supplier'}${inv.supplier_invoice_ref ? ` (${inv.supplier_invoice_ref})` : ''}`,
    lines: apInvoiceLines(roles, { invoice_number: String(inv.invoice_number) }, sup.supplier,
      lines.map((l) => ({ accountCode: l.debit_account_code, myrSen: Number(l.amount_sen), description: l.description }))),
  });
  if (!je.ok) return c.json({ error: 'post_failed', status: je.status, reason: (je as { reason?: string }).reason ?? je.status }, 500);

  if (inv.status === 'DRAFT') {
    const { error: upErr } = await sb.from('ap_invoices').update({
      status: 'POSTED', posted_at: new Date().toISOString(), posted_by: String(c.get('houzsUser')?.name ?? c.get('user')?.id ?? ''), updated_at: new Date().toISOString(),
    }).eq('company_id', co.companyId).eq('id', inv.id);
    if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  }
  return c.json({ ok: true, jeNo: je.jeNo, status: je.status });
};

/* ── POST /:id/cancel — a draft dies quietly; a posted bill gets its contra ─ */
export const cancelApInvoiceHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) return c.json(NO_PERM('cancel an AP invoice'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadInvoice(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const inv = found.inv;
  if (inv.status === 'CANCELLED') return c.json({ ok: true, already: true });
  if (Number(inv.paid_sen ?? 0) > 0) {
    return c.json({ error: 'has_payments', message: `${inv.invoice_number} has ${(Number(inv.paid_sen) / 100).toFixed(2)} paid against it — cancel the payment first.` }, 409);
  }
  const sb = c.get('supabase');
  if (inv.status !== 'DRAFT') {
    const rev = await reverseJournal(sb, {
      sourceType: 'API',
      sourceDocNo: String(inv.invoice_number),
      companyId: co.companyId,
      narration: (orig) => `Reversal of ${orig.je_no} — AP invoice ${inv.invoice_number} cancelled`,
      entryDate: todayMyt(),
    });
    if (!rev.ok) return c.json({ error: 'reverse_failed', status: rev.status, reason: (rev as { reason?: string }).reason ?? rev.status }, 500);
  }
  const { error: upErr } = await sb.from('ap_invoices').update({
    status: 'CANCELLED', cancelled_at: new Date().toISOString(), cancelled_by: String(c.get('houzsUser')?.name ?? c.get('user')?.id ?? ''), updated_at: new Date().toISOString(),
  }).eq('company_id', co.companyId).eq('id', inv.id);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true });
};

export const apInvoices = new Hono();
/* The SCM bridge is PER ROUTER (scm/index.ts mounts no global one): it stashes
   the real caller as houzsUser — what hasHouzsPerm reads — and hands out the
   service client. Without it every read here answered 403 and every write crashed. See docs/bugs/0648; tests/scmRouterBridge.test.ts pins it. */
apInvoices.use('*', supabaseAuth);
apInvoices.get('/', listApInvoicesHandler);
apInvoices.post('/', createApInvoiceHandler);
/* Files before /:id, as the PV mounts them — the evidence paths never fall
   into the detail matcher. */
apInvoices.post('/:id/files', uploadApInvoiceFileHandler);
apInvoices.get('/:id/files', listApInvoiceFilesHandler);
apInvoices.get('/:id/files/:fileId', streamApInvoiceFileHandler);
apInvoices.delete('/:id/files/:fileId', deleteApInvoiceFileHandler);
apInvoices.get('/:id', apInvoiceDetailHandler);
apInvoices.patch('/:id', updateApInvoiceHandler);
apInvoices.post('/:id/post', postApInvoiceHandler);
apInvoices.post('/:id/cancel', cancelApInvoiceHandler);

/* Referenced so a stale import never hides that the active company is the
   scope on every write above. */
void activeCompanyId;
