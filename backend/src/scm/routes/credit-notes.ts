// ----------------------------------------------------------------------------
// Credit and debit notes — /scm/credit-notes (owner 2026-09-05: CN/DN approved,
// sales CN + supplier CN first, DN second, prefixes CN / DN / SCN; 2026-09-12:
// 这个要做). Three documents on one table (migration 20260912T0100):
//   CN  — to a customer: Dr each line's account (RETURN INWARDS by default)
//         / Cr AR, party the customer.
//   DN  — to a customer: Dr AR, party the customer / Cr each line's account.
//   SCN — from a supplier: Dr the supplier's AP control / Cr each line's
//         account (PURCHASES RETURN by default).
// A note is DRAFT until posted; posting writes ONE journal through the engine,
// keyed (source_type = kind, source_doc_no = note number), so a second post
// echoes; cancel writes the contra. The customer comes from the sales order
// or the invoice the note answers (the same party code a payment carries —
// docs/bugs/0788, one customer one code), else the name typed.
//
// Numbering: {co}-CN-YYMM-NNN / {co}-DN-YYMM-NNN / {co}-SCN-YYMM-NNN — NEW
// series (flagged to the owner 2026-09-12).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { docMonthTag, mintMonthlyDocNo } from '../lib/doc-no';
import { dateOrNull } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { postJournal, reverseJournal } from '../../acc/engine';
import { creditNoteLines, debitNoteLines, supplierCreditNoteLines, resolveRoles, type NoteLine, type NoteParty } from '../../acc/rules';
import { customerPartyCode } from '../../acc/payments';
import { requireLeafAccount } from './accounting-chart';
import { supabaseAuth } from '../middleware/auth';

type Row = Record<string, any>;
type Kind = 'CN' | 'DN' | 'SCN';
const KINDS = new Set<string>(['CN', 'DN', 'SCN']);
const NO_PERM = (what: string) => ({ error: `You don't have permission to ${what}.` });
const KIND_WORD: Record<Kind, string> = { CN: 'Credit note', DN: 'Debit note', SCN: 'Supplier credit note' };

const HEADER = 'id, company_id, note_number, kind, party_type, party_code, party_name, supplier_id, so_doc_no, sales_invoice_id, ap_invoice_id, purchase_invoice_id, source_doc_no, note_date, total_sen, reason, notes, status, je_no, created_at, created_by, updated_at, posted_at, posted_by, cancelled_at, cancelled_by';
const LINE = 'id, line_no, description, account_code, amount_sen';

type CleanLine = { description: string | null; code: string | null; amountSen: number };

function buildLines(raw: unknown): { lines: CleanLine[]; total: number } | { error: string; message: string } {
  const arr = Array.isArray(raw) ? raw : [];
  if (arr.length === 0 || arr.length > 50) return { error: 'lines_required', message: 'A note takes 1 to 50 lines.' };
  const lines: CleanLine[] = [];
  for (const [i, l] of arr.entries()) {
    const code = String(l?.accountCode ?? '').trim() || null;
    const amount = Number(l?.amountSen);
    if (!Number.isInteger(amount) || amount <= 0) {
      return { error: 'bad_line', message: `Line ${i + 1}: amountSen must be a positive integer (got ${String(l?.amountSen)}).` };
    }
    lines.push({ description: l?.description ? String(l.description).trim() : null, code, amountSen: amount });
  }
  return { lines, total: lines.reduce((s, l) => s + l.amountSen, 0) };
}

const who = (c: any): string => String(c.get('houzsUser')?.name ?? c.get('user')?.id ?? '');

async function loadNote(c: any, id: string): Promise<{ note: Row } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('acc_credit_notes').select(HEADER).eq('id', id), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found', message: 'That note is not in the company you are working in.' }, 404) };
  return { note: data as Row };
}

async function loadSupplier(c: any, supplierId: string): Promise<{ supplier: { id: string; code: string | null; name: string | null } } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('suppliers').select('id, code, name').eq('id', supplierId), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'supplier_unknown', message: 'That supplier is not in the company you are working in.' }, 400) };
  return { supplier: data as { id: string; code: string | null; name: string | null } };
}

/* WHO THE CUSTOMER IS. The sales order first (2990's every order carries a
   customer_id; the party code is the one a payment on it carries), the sales
   invoice next, the typed name last — a note must name somebody. */
async function resolveCustomer(c: any, body: any): Promise<
  | { party: NoteParty; soDocNo: string | null; salesInvoiceId: string | null }
  | { resp: Response }
> {
  const sb = c.get('supabase');
  const soDocNo = String(body.soDocNo ?? '').trim() || null;
  const salesInvoiceId = String(body.salesInvoiceId ?? '').trim() || null;
  if (soDocNo) {
    const { data, error } = await scopeToCompany(sb.from('mfg_sales_orders').select('doc_no, debtor_code, debtor_name, customer_id').eq('doc_no', soDocNo), c).maybeSingle();
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    if (!data) return { resp: c.json({ error: 'so_unknown', message: `${soDocNo} is not a sales order of the company you are working in.` }, 400) };
    const so = data as { doc_no: string; debtor_code: string | null; debtor_name: string | null; customer_id: string | null };
    return { party: { code: customerPartyCode(so.debtor_code, so.customer_id), name: so.debtor_name ?? null }, soDocNo: so.doc_no, salesInvoiceId };
  }
  if (salesInvoiceId) {
    const { data, error } = await scopeToCompany(sb.from('sales_invoices').select('id, invoice_number, so_doc_no, debtor_code, debtor_name').eq('id', salesInvoiceId), c).maybeSingle();
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    if (!data) return { resp: c.json({ error: 'si_unknown', message: 'That sales invoice is not in the company you are working in.' }, 400) };
    const si = data as { id: string; so_doc_no: string | null; debtor_code: string | null; debtor_name: string | null };
    return { party: { code: si.debtor_code ?? null, name: si.debtor_name ?? null }, soDocNo: si.so_doc_no ?? null, salesInvoiceId: si.id };
  }
  const name = String(body.partyName ?? '').trim();
  if (!name) return { resp: c.json({ error: 'party_required', message: 'Name the customer — the sales order, the invoice, or the name itself.' }, 400) };
  return { party: { code: String(body.partyCode ?? '').trim() || null, name }, soDocNo: null, salesInvoiceId: null };
}

export const listCreditNotesHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const kind = String(c.req.query('kind') ?? '').trim().toUpperCase();
  const status = String(c.req.query('status') ?? '').trim().toUpperCase();
  const sb = c.get('supabase');
  let q = sb.from('acc_credit_notes').select(HEADER).eq('company_id', co.companyId);
  if (KINDS.has(kind)) q = q.eq('kind', kind);
  if (status === 'DRAFT' || status === 'POSTED' || status === 'CANCELLED') q = q.eq('status', status);
  const { data, error } = await q.order('note_date', { ascending: false }).order('note_number', { ascending: false }).limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ rows: (Array.isArray(data) ? data : []) as Row[] });
};

export const creditNoteDetailHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const sb = c.get('supabase');
  const { data: lines, error } = await scopeToCompany(sb.from('acc_credit_note_lines').select(LINE).eq('note_id', found.note.id), c).order('line_no');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ note: found.note, lines: (Array.isArray(lines) ? lines : []) as Row[] });
};

export const createCreditNoteHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create') && !hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json(NO_PERM('raise a credit or debit note'), 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const kind = String(body.kind ?? '').trim().toUpperCase();
  if (!KINDS.has(kind)) return c.json({ error: 'kind_required', message: 'Say which note this is: CN (to a customer), DN (to a customer) or SCN (from a supplier).' }, 400);
  const built = buildLines(body.lines);
  if ('error' in built) return c.json({ error: built.error, message: built.message }, 400);
  const noteDate = dateOrNull(body.noteDate) ?? todayMyt();
  const sb = c.get('supabase');
  const roles = await resolveRoles(sb, co.companyId);

  /* The party, by kind. */
  let party: NoteParty;
  let supplierId: string | null = null;
  let soDocNo: string | null = null;
  let salesInvoiceId: string | null = null;
  if (kind === 'SCN') {
    const supplierIdRaw = String(body.supplierId ?? '').trim();
    if (!supplierIdRaw) return c.json({ error: 'supplier_required', message: 'Pick the supplier this credit note is from.' }, 400);
    const sup = await loadSupplier(c, supplierIdRaw);
    if ('resp' in sup) return sup.resp;
    party = { code: sup.supplier.code, name: sup.supplier.name };
    supplierId = sup.supplier.id;
  } else {
    const cust = await resolveCustomer(c, body);
    if ('resp' in cust) return cust.resp;
    party = cust.party; soDocNo = cust.soDocNo; salesInvoiceId = cust.salesInvoiceId;
  }

  /* A line with no account lands on the kind's default (the owner's own
     RETURN INWARDS / PURCHASES RETURN); every line must be a leaf and never a
     control (父户不记账, 由模块过账). */
  const fallback = kind === 'SCN' ? roles.PURCHASE_RETURNS : roles.SALES_RETURNS;
  const lines = built.lines.map((l) => ({ ...l, code: l.code ?? fallback }));
  for (const code of [...new Set(lines.map((l) => l.code))]) {
    const leafErr = await requireLeafAccount(c, co.companyId, code);
    if (leafErr) return leafErr;
  }

  const noteNumber = await mintMonthlyDocNo(sb, 'acc_credit_notes', 'note_number', `${companyDocPrefix(c)}${kind}-${docMonthTag(noteDate)}`);
  const { data: note, error: insErr } = await sb.from('acc_credit_notes').insert({
    company_id: co.companyId,
    note_number: noteNumber,
    kind,
    party_type: kind === 'SCN' ? 'SUPPLIER' : 'CUSTOMER',
    party_code: party.code,
    party_name: party.name,
    supplier_id: supplierId,
    so_doc_no: soDocNo,
    sales_invoice_id: salesInvoiceId,
    ap_invoice_id: String(body.apInvoiceId ?? '').trim() || null,
    purchase_invoice_id: String(body.purchaseInvoiceId ?? '').trim() || null,
    source_doc_no: String(body.sourceDocNo ?? '').trim() || null,
    note_date: noteDate,
    total_sen: built.total,
    reason: String(body.reason ?? '').trim() || null,
    notes: String(body.notes ?? '').trim() || null,
    status: 'DRAFT',
    je_no: null,
    created_by: who(c),
  }).select(HEADER).single();
  if (insErr || !note) return c.json({ error: 'save_failed', reason: insErr?.message ?? 'insert returned nothing' }, 500);

  const { error: lineErr } = await sb.from('acc_credit_note_lines').insert(lines.map((l, i) => ({
    company_id: co.companyId, note_id: (note as Row).id, line_no: i + 1, description: l.description, account_code: l.code, amount_sen: l.amountSen,
  })));
  if (lineErr) {
    await sb.from('acc_credit_notes').delete().eq('company_id', co.companyId).eq('id', (note as Row).id);
    return c.json({ error: 'save_failed', reason: lineErr.message }, 500);
  }
  return c.json({ ok: true, note }, 201);
};

/* A DRAFT changes; a posted note is cancelled and raised again — the ledger
   keeps the trail. */
export const updateCreditNoteHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create') && !hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json(NO_PERM('edit a credit or debit note'), 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const note = found.note;
  if (note.status !== 'DRAFT') {
    return c.json({ error: 'not_editable', message: `${note.note_number} is ${String(note.status).toLowerCase()} — cancel it and raise it again.` }, 409);
  }
  const sb = c.get('supabase');
  const roles = await resolveRoles(sb, co.companyId);
  const patch: Row = { updated_at: new Date().toISOString() };
  if (body.noteDate !== undefined) patch.note_date = dateOrNull(body.noteDate) ?? note.note_date;
  if (body.reason !== undefined) patch.reason = String(body.reason ?? '').trim() || null;
  if (body.notes !== undefined) patch.notes = String(body.notes ?? '').trim() || null;
  if (body.sourceDocNo !== undefined) patch.source_doc_no = String(body.sourceDocNo ?? '').trim() || null;
  if (body.lines !== undefined) {
    const built = buildLines(body.lines);
    if ('error' in built) return c.json({ error: built.error, message: built.message }, 400);
    const fallback = note.kind === 'SCN' ? roles.PURCHASE_RETURNS : roles.SALES_RETURNS;
    const lines = built.lines.map((l) => ({ ...l, code: l.code ?? fallback }));
    for (const code of [...new Set(lines.map((l) => l.code))]) {
      const leafErr = await requireLeafAccount(c, co.companyId, code);
      if (leafErr) return leafErr;
    }
    const { error: delErr } = await sb.from('acc_credit_note_lines').delete().eq('company_id', co.companyId).eq('note_id', note.id);
    if (delErr) return c.json({ error: 'save_failed', reason: delErr.message }, 500);
    const { error: insErr } = await sb.from('acc_credit_note_lines').insert(lines.map((l, i) => ({
      company_id: co.companyId, note_id: note.id, line_no: i + 1, description: l.description, account_code: l.code, amount_sen: l.amountSen,
    })));
    if (insErr) return c.json({ error: 'save_failed', reason: insErr.message }, 500);
    patch.total_sen = built.total;
  }
  const { data: saved, error: upErr } = await sb.from('acc_credit_notes').update(patch).eq('company_id', co.companyId).eq('id', note.id).select(HEADER).single();
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true, note: saved });
};

export const postCreditNoteHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM('post to the general ledger'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const note = found.note;
  if (note.status === 'CANCELLED') return c.json({ error: 'cancelled', message: `${note.note_number} is cancelled.` }, 409);
  const sb = c.get('supabase');
  const { data: lineRows, error: lErr } = await scopeToCompany(sb.from('acc_credit_note_lines').select(LINE).eq('note_id', note.id), c).order('line_no');
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const lines: NoteLine[] = ((Array.isArray(lineRows) ? lineRows : []) as Array<{ description: string | null; account_code: string; amount_sen: number }>)
    .map((l) => ({ accountCode: l.account_code, amountSen: Number(l.amount_sen), description: l.description }));
  if (lines.length === 0) return c.json({ error: 'lines_required', message: 'This note has no lines to post.' }, 400);

  const kind = String(note.kind) as Kind;
  const party: NoteParty = { code: note.party_code ?? null, name: note.party_name ?? null };
  const roles = await resolveRoles(sb, co.companyId);
  const ruleLines = kind === 'CN' ? creditNoteLines(roles, { note_number: String(note.note_number) }, party, lines)
    : kind === 'DN' ? debitNoteLines(roles, { note_number: String(note.note_number) }, party, lines)
    : supplierCreditNoteLines(roles, { note_number: String(note.note_number) }, party, lines);
  const je = await postJournal(sb, {
    companyId: co.companyId,
    entryDate: String(note.note_date),
    sourceType: kind,
    sourceDocNo: String(note.note_number),
    narration: `${KIND_WORD[kind]} ${note.note_number} — ${party.name ?? party.code ?? 'party'}${note.reason ? ` (${note.reason})` : ''}`,
    lines: ruleLines,
  });
  if (!je.ok) return c.json({ error: 'post_failed', status: je.status, reason: (je as { reason?: string }).reason ?? je.status }, 500);

  if (note.status === 'DRAFT') {
    const { error: upErr } = await sb.from('acc_credit_notes').update({
      status: 'POSTED', je_no: je.jeNo, posted_at: new Date().toISOString(), posted_by: who(c), updated_at: new Date().toISOString(),
    }).eq('company_id', co.companyId).eq('id', note.id);
    if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  }
  return c.json({ ok: true, jeNo: je.jeNo, status: je.status });
};

export const cancelCreditNoteHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) return c.json(NO_PERM('cancel a credit or debit note'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const note = found.note;
  if (note.status === 'CANCELLED') return c.json({ ok: true, already: true });
  const sb = c.get('supabase');
  if (note.status === 'POSTED') {
    const rev = await reverseJournal(sb, {
      sourceType: String(note.kind),
      sourceDocNo: String(note.note_number),
      companyId: co.companyId,
      narration: (orig) => `Reversal of ${orig.je_no} — ${KIND_WORD[String(note.kind) as Kind].toLowerCase()} ${note.note_number} cancelled`,
      entryDate: todayMyt(),
    });
    if (!rev.ok) return c.json({ error: 'reverse_failed', status: rev.status, reason: (rev as { reason?: string }).reason ?? rev.status }, 500);
  }
  const { error: upErr } = await sb.from('acc_credit_notes').update({
    status: 'CANCELLED', cancelled_at: new Date().toISOString(), cancelled_by: who(c), updated_at: new Date().toISOString(),
  }).eq('company_id', co.companyId).eq('id', note.id);
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true });
};

export const creditNotes = new Hono();
/* EVERY SCM router carries the bridge (docs/bugs/0648): it turns the JWT into
   the real caller as houzsUser — what hasHouzsPerm reads — and hands out the
   scoped client. */
creditNotes.use('*', supabaseAuth);
creditNotes.get('/', listCreditNotesHandler);
creditNotes.post('/', createCreditNoteHandler);
creditNotes.get('/:id', creditNoteDetailHandler);
creditNotes.patch('/:id', updateCreditNoteHandler);
creditNotes.post('/:id/post', postCreditNoteHandler);
creditNotes.post('/:id/cancel', cancelCreditNoteHandler);
