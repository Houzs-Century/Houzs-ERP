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
//
// 2026-10-01 (owner: supplier 给我 cn，我要做 ocr for cn；这个 cn 可能会 link 去相对应
// 的 supplier invoice): POST /scan reads a supplier's credit note into the note it
// should become (routes/credit-note-scan.ts), the note keeps its paper
// (/:id/files — routes/credit-note-files.ts), and a supplier note may name the
// purchase invoice or AP invoice it credits — one of that supplier's own.
//
// 2026-10-02 (owner: CN 的方式应该是类似 ap payment 这样 knock off；扣错了就 untick):
// a supplier note knocks off the supplier's invoices on the AP Payment's ticks —
// GET /knock-off?supplierId= and GET /:id/knock-off give the table, PUT
// /:id/allocations sets it whole. A draft carries its ticks as a plan (create
// and edit take `allocations` too) and the post carries it out.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { dateOrNull } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { resolveRoles, type NoteParty } from '../../acc/rules';
import { customerPartyCode } from '../../acc/payments';
import {
  CREDIT_NOTE_HEADER as HEADER, CREDIT_NOTE_LINE as LINE, NOTE_KINDS as KINDS, NOTE_KIND_WORD as KIND_WORD,
  apInvoiceEventLines, cancelCreditNote, eventsFromApInvoice, insertCreditNote, postCreditNote, type NoteKind as Kind,
} from '../../acc/credit-notes';
import { parseEventId, unknownEventRefusal } from '../lib/event-tags';
import { requireLeafAccount } from './accounting-chart';
import { supabaseAuth } from '../middleware/auth';
import { scanSupplierCreditNoteHandler } from './credit-note-scan';
import {
  applyCreditNote, carryOutPlan, checkKnockOff, debtorParty, knockOffRows, noteAllocations, parseTargets, partyOfNote, partyOpenDocs,
  removeAllocation, setNoteKnockOff, supplierParty, writePlan, type CreditParty, type CreditTarget,
} from '../../acc/credit-note-allocations';
import { deleteCreditNoteFileHandler, listCreditNoteFilesHandler, streamCreditNoteFileHandler, uploadCreditNoteFileHandler } from './credit-note-files';
import { fmtSen } from '../shared/format';
import { openingDocumentRefusal } from '../../acc/books-opening';

type Row = Record<string, any>;
const NO_PERM = (what: string) => ({ error: `You don't have permission to ${what}.` });
/* The document itself — number, header, lines, journal, contra — is
   acc/credit-notes.ts (docs/bugs/0831): the deposit-invoice close-out raises
   a note from inside the posting path with no request to hand, so the core
   may not live here. This file keeps the caller's half: permissions, the
   party lookup, the leaf check on a typed account, the draft edit. */

/** projectId: the event the line's money is for (owner 2026-10-22) — null = none. */
type CleanLine = { description: string | null; code: string | null; amountSen: number; projectId: number | null };

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
    const projectId = parseEventId(l?.projectId);
    if (projectId === 'invalid') return { error: 'bad_line', message: `Line ${i + 1}: projectId must be an event id (got ${String(l?.projectId)}).` };
    lines.push({ description: l?.description ? String(l.description).trim() : null, code, amountSen: amount, projectId });
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

/* An other-debtor note's debtor: one of the company's Other Debtors registry,
   still active — the registry name is the party the control line carries. */
async function loadDebtor(c: any, debtorId: string): Promise<{ debtor: { id: string; name: string } } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('acc_debtors').select('id, name, is_active').eq('id', debtorId), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'debtor_unknown', message: 'That other debtor is not in the company you are working in.' }, 400) };
  const d = data as { id: string; name: string; is_active: boolean | null };
  if (d.is_active === false) return { resp: c.json({ error: 'debtor_inactive', message: `${d.name} is deactivated.` }, 400) };
  return { debtor: { id: String(d.id), name: String(d.name) } };
}

/* The two Finance pages (owner 2026-10-28): Money in shows the customer's and
   the other debtor's notes, Money out the supplier's. */
const SIDE_KINDS: Record<string, readonly Kind[]> = { AR: ['CN', 'DN', 'OCN'], AP: ['SCN'] };

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

/** The final invoice's number for a note that answers one (docs/bugs/0834):
    the print says which invoice a close-out note follows, and the row carries
    only the id. Read once per list, the way the deposit-invoice page reads
    its note numbers. */
async function withInvoiceNumbers(c: any, rows: Row[]): Promise<{ rows: Row[] } | { resp: Response }> {
  const idsOf = (col: string) => [...new Set(rows.map((r) => r[col]).filter((x): x is string => typeof x === 'string' && x !== ''))];
  const numberOf = new Map<string, string>();
  /* The sales invoice a close-out note follows, and (2026-10-01) the purchase
     invoice or AP invoice a supplier note credits. */
  for (const [col, table] of [['sales_invoice_id', 'sales_invoices'], ['purchase_invoice_id', 'purchase_invoices'], ['ap_invoice_id', 'ap_invoices']] as const) {
    const ids = idsOf(col);
    if (ids.length === 0) continue;
    const co = requireActiveCompanyId(c);
    if (!co.ok) return { resp: c.json(co.refusal, 409) };
    const { data, error } = await c.get('supabase').from(table).select('id, invoice_number').eq('company_id', co.companyId).in('id', ids);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const s of (Array.isArray(data) ? data : []) as Array<{ id: string; invoice_number: string }>) numberOf.set(String(s.id), String(s.invoice_number));
  }
  const num = (v: unknown) => (typeof v === 'string' ? numberOf.get(v) ?? null : null);
  return { rows: rows.map((r) => ({ ...r, sales_invoice_number: num(r.sales_invoice_id), purchase_invoice_number: num(r.purchase_invoice_id), ap_invoice_number: num(r.ap_invoice_id) })) };
}

export const listCreditNotesHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const kind = String(c.req.query('kind') ?? '').trim().toUpperCase();
  const status = String(c.req.query('status') ?? '').trim().toUpperCase();
  const side = String(c.req.query('side') ?? '').trim().toUpperCase();
  const sb = c.get('supabase');
  let q = sb.from('acc_credit_notes').select(HEADER).eq('company_id', co.companyId);
  if (KINDS.has(kind)) q = q.eq('kind', kind);
  if (SIDE_KINDS[side]) q = q.in('kind', [...SIDE_KINDS[side]]);
  if (status === 'DRAFT' || status === 'POSTED' || status === 'CANCELLED') q = q.eq('status', status);
  /* The books' opening papers apart (owner 2026-10-29: 期初那 85 张放在 "Opening
     31/08" 分页 — AutoCount's payments not knocked off, kept as supplier credits):
     opening=only lists them alone, opening=exclude leaves them out, absent both. */
  const opening = String(c.req.query('opening') ?? '').trim().toLowerCase();
  if (opening === 'only') q = q.eq('opening', true);
  else if (opening === 'exclude') q = q.eq('opening', false);
  const { data, error } = await q.order('note_date', { ascending: false }).order('note_number', { ascending: false }).limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const numbered = await withInvoiceNumbers(c, (Array.isArray(data) ? data : []) as Row[]);
  if ('resp' in numbered) return numbered.resp;
  return c.json({ rows: numbered.rows });
};

export const creditNoteDetailHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const sb = c.get('supabase');
  const { data: lines, error } = await scopeToCompany(sb.from('acc_credit_note_lines').select(LINE).eq('note_id', found.note.id), c).order('line_no');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const numbered = await withInvoiceNumbers(c, [found.note as unknown as Row]);
  if ('resp' in numbered) return numbered.resp;
  /* A supplier note's applications and the credit it has left (part 2) — an
     other debtor's the same, off the debtor's bills. */
  let credit: Row = {};
  if (found.note.kind === 'SCN' || found.note.kind === 'OCN') {
    const al = await noteAllocations(sb, co.companyId, found.note);
    if (!al.ok) return c.json({ error: 'load_failed', reason: al.reason }, 500);
    credit = { allocations: al.allocations, appliedSen: al.appliedSen, leftSen: al.leftSen };
  }
  return c.json({ note: numbered.rows[0], lines: (Array.isArray(lines) ? lines : []) as Row[], ...credit });
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
  if (!KINDS.has(kind)) return c.json({ error: 'kind_required', message: 'Say which note this is: CN or DN (to a customer), OCN (to an other debtor) or SCN (from a supplier).' }, 400);
  const built = buildLines(body.lines);
  if ('error' in built) return c.json({ error: built.error, message: built.message }, 400);
  const noteDate = dateOrNull(body.noteDate) ?? todayMyt();
  const sb = c.get('supabase');
  const roles = await resolveRoles(sb, co.companyId);

  /* The party, by kind. */
  let party: NoteParty;
  let supplierId: string | null = null;
  let debtorId: string | null = null;
  let soDocNo: string | null = null;
  let salesInvoiceId: string | null = null;
  if (kind === 'OCN') {
    const debtorIdRaw = String(body.debtorId ?? '').trim();
    if (!debtorIdRaw) return c.json({ error: 'debtor_required', message: 'Pick the other debtor this credit note is to.' }, 400);
    const deb = await loadDebtor(c, debtorIdRaw);
    if ('resp' in deb) return deb.resp;
    party = { code: null, name: deb.debtor.name };
    debtorId = deb.debtor.id;
  } else if (kind === 'SCN') {
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
  /* An other debtor's credit has no default — a discount, a waiver, an
     adjustment: the line says which. */
  if (kind === 'OCN' && built.lines.some((l) => !l.code)) {
    return c.json({ error: 'account_required', message: 'Each line of an other-debtor credit note names its account (e.g. 520-0000 DISCOUNT ALLOWED).' }, 400);
  }
  const fallback = kind === 'SCN' ? roles.PURCHASE_RETURNS : roles.SALES_RETURNS;
  const lines = built.lines.map((l) => ({ ...l, code: l.code ?? fallback }));
  for (const code of [...new Set(lines.map((l) => l.code))]) {
    const leafErr = await requireLeafAccount(c, co.companyId, code);
    if (leafErr) return leafErr;
  }
  const eventErr = await unknownEventRefusal(c, lines.map((l) => l.projectId));
  if (eventErr) return eventErr;

  /* The invoice a supplier note credits (owner 2026-10-01: 这个 cn 可能会 link 去
     相对应的 supplier invoice) — one of this supplier's own, in this company. */
  const apInvoiceId = String(body.apInvoiceId ?? '').trim() || null;
  const purchaseInvoiceId = String(body.purchaseInvoiceId ?? '').trim() || null;
  if (apInvoiceId || purchaseInvoiceId) {
    if (kind !== 'SCN') return c.json({ error: 'invoice_not_this_kind', message: 'Only a supplier credit note credits a supplier\'s invoice.' }, 400);
    for (const [table, docId] of [['purchase_invoices', purchaseInvoiceId], ['ap_invoices', apInvoiceId]] as const) {
      if (!docId) continue;
      const { data: doc, error: docErr } = await sb.from(table).select('id, supplier_id').eq('company_id', co.companyId).eq('id', docId).maybeSingle();
      if (docErr) return c.json({ error: 'load_failed', reason: docErr.message }, 500);
      if (!doc || String((doc as Row).supplier_id) !== supplierId) {
        return c.json({ error: 'invoice_not_this_supplier', message: 'That invoice is not one of this supplier\'s here — pick it again.' }, 400);
      }
    }
  }

  /* The knock-off (owner 2026-10-02: 类似 ap payment 这样 knock off) — the ticks,
     carried by the draft as its plan and carried out by the post. A body that
     names its invoice but brings no ticks (the API before them) plans the
     credit off that invoice, as much as it owes. Checked before anything is
     written. */
  let plan: CreditTarget[] = [];
  if (body.allocations !== undefined && kind !== 'SCN' && kind !== 'OCN' && parseTargets(body.allocations).length > 0) {
    return c.json({ error: 'invoice_not_this_kind', message: 'Only a supplier or other-debtor credit note knocks off an invoice or a bill.' }, 400);
  }
  /* An other debtor's note knocks off the debtor's bills the same way, planned on the draft. */
  if (kind === 'OCN' && debtorId && body.allocations !== undefined) {
    plan = parseTargets(body.allocations);
    const checked = await checkKnockOff(sb, { companyId: co.companyId, label: 'This note', party: debtorParty(debtorId), totalSen: built.total, posted: false, targets: plan, current: new Map() });
    if (!checked.ok) return c.json({ error: checked.refusal.error, message: checked.refusal.message }, checked.refusal.status);
  }
  if (kind === 'SCN' && supplierId) {
    if (body.allocations !== undefined) {
      plan = parseTargets(body.allocations);
    } else {
      const namedId = purchaseInvoiceId ?? apInvoiceId;
      const namedKind = purchaseInvoiceId ? 'PI' as const : 'API' as const;
      if (namedId) {
        const { data: doc, error: docErr } = await sb.from(namedKind === 'PI' ? 'purchase_invoices' : 'ap_invoices')
          .select('total_sen, paid_sen, status').eq('company_id', co.companyId).eq('id', namedId).maybeSingle();
        if (docErr) return c.json({ error: 'load_failed', reason: docErr.message }, 500);
        const d = doc as Row | null;
        const owed = d && (d.status === 'POSTED' || d.status === 'PARTIALLY_PAID') ? Number(d.total_sen ?? 0) - Number(d.paid_sen ?? 0) : 0;
        const amount = Math.min(built.total, owed);
        if (amount > 0) plan = [{ kind: namedKind, id: namedId, amountSen: amount }];
      }
    }
    const checked = await checkKnockOff(sb, { companyId: co.companyId, label: 'This note', party: supplierParty(supplierId), totalSen: built.total, posted: false, targets: plan, current: new Map() });
    if (!checked.ok) return c.json({ error: checked.refusal.error, message: checked.refusal.message }, checked.refusal.status);
  }

  const raised = await insertCreditNote(sb, {
    companyId: co.companyId,
    docPrefix: companyDocPrefix(c),
    kind: kind as Kind,
    party,
    supplierId,
    debtorId,
    soDocNo,
    salesInvoiceId,
    apInvoiceId,
    purchaseInvoiceId,
    sourceDocNo: String(body.sourceDocNo ?? '').trim() || null,
    noteDate,
    reason: String(body.reason ?? '').trim() || null,
    notes: String(body.notes ?? '').trim() || null,
    lines: lines.map((l) => ({ description: l.description, code: l.code, amountSen: l.amountSen, projectId: l.projectId })),
    knockOffApInvoiceIds: plan.filter((t) => t.kind === 'API').map((t) => t.id),
    createdBy: who(c),
  });
  if (!raised.ok) return c.json({ error: 'save_failed', reason: raised.reason }, 500);
  if (plan.length > 0) {
    /* The note stands either way — a second Save would raise it twice. */
    const written = await writePlan(sb, { companyId: co.companyId, noteId: String(raised.note.id), targets: plan, actor: who(c) });
    if (!written.ok) {
      return c.json({ ok: true, note: raised.note, knockOffFailed: `${raised.note.note_number} is saved, but its knock-off is not (${written.reason}) — open it and tick again.` }, 201);
    }
  }
  return c.json({ ok: true, note: raised.note }, 201);
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
  if (note.opening === true) return c.json(openingDocumentRefusal(String(note.note_number)), 409);
  if (note.status !== 'DRAFT') {
    return c.json({ error: 'not_editable', message: `${note.note_number} is ${String(note.status).toLowerCase()} — cancel it and raise it again.` }, 409);
  }
  const sb = c.get('supabase');
  const roles = await resolveRoles(sb, co.companyId);
  /* The lines are checked first — the knock-off below is held against their total. */
  const built = body.lines !== undefined ? buildLines(body.lines) : null;
  if (built && 'error' in built) return c.json({ error: built.error, message: built.message }, 400);
  const newTotal = built ? built.total : Number(note.total_sen ?? 0);
  /* A draft's knock-off plan (2026-10-02): replaced when the body brings ticks;
     a new total below what is planned is refused, never trimmed — the ticks
     are Finance's. */
  let plan: CreditTarget[] | null = null;
  const party: CreditParty | null = partyOfNote(note);
  if (body.allocations !== undefined) {
    if (!party) return c.json({ error: 'invoice_not_this_kind', message: 'Only a supplier or other-debtor credit note knocks off an invoice or a bill.' }, 400);
    plan = parseTargets(body.allocations);
    const checked = await checkKnockOff(sb, {
      companyId: co.companyId, label: String(note.note_number), party, totalSen: newTotal, posted: false, targets: plan, current: new Map(),
    });
    if (!checked.ok) return c.json({ error: checked.refusal.error, message: checked.refusal.message }, checked.refusal.status);
  } else if (party && built) {
    const al = await noteAllocations(sb, co.companyId, note);
    if (!al.ok) return c.json({ error: 'load_failed', reason: al.reason }, 500);
    const planned = al.allocations.reduce((s, a) => s + a.amountSen, 0);
    if (planned > newTotal) {
      return c.json({ error: 'over_credit', message: `The knock-off planned (${fmtSen(planned)}) is more than the note's new total (${fmtSen(newTotal)}) — untick some first.` }, 409);
    }
  }
  const patch: Row = { updated_at: new Date().toISOString() };
  if (body.noteDate !== undefined) patch.note_date = dateOrNull(body.noteDate) ?? note.note_date;
  if (body.reason !== undefined) patch.reason = String(body.reason ?? '').trim() || null;
  if (body.notes !== undefined) patch.notes = String(body.notes ?? '').trim() || null;
  if (body.sourceDocNo !== undefined) patch.source_doc_no = String(body.sourceDocNo ?? '').trim() || null;
  if (built) {
    if (note.kind === 'OCN' && built.lines.some((l) => !l.code)) {
      return c.json({ error: 'account_required', message: 'Each line of an other-debtor credit note names its account (e.g. 520-0000 DISCOUNT ALLOWED).' }, 400);
    }
    const fallback = note.kind === 'SCN' ? roles.PURCHASE_RETURNS : roles.SALES_RETURNS;
    const typed = built.lines.map((l) => ({ ...l, code: l.code ?? fallback }));
    for (const code of [...new Set(typed.map((l) => l.code))]) {
      const leafErr = await requireLeafAccount(c, co.companyId, code);
      if (leafErr) return leafErr;
    }
    const eventErr = await unknownEventRefusal(c, typed.map((l) => l.projectId));
    if (eventErr) return eventErr;
    /* A supplier note takes the events of the AP invoices it names or knocks
       off (acc/credit-notes.ts) — the ticks in this body, else the ones it has. */
    let sources: string[] = [];
    if (note.kind === 'SCN') {
      const ticked = plan ? plan.filter((t) => t.kind === 'API').map((t) => t.id) : null;
      if (ticked) sources = ticked;
      else {
        const al = await noteAllocations(sb, co.companyId, note);
        sources = al.ok ? al.allocations.filter((a) => a.kind === 'API').map((a) => a.docId) : [];
      }
      if (note.ap_invoice_id) sources.push(String(note.ap_invoice_id));
    }
    const lines = sources.length > 0 ? eventsFromApInvoice(typed, await apInvoiceEventLines(sb, co.companyId, sources)) : typed;
    const { error: delErr } = await sb.from('acc_credit_note_lines').delete().eq('company_id', co.companyId).eq('note_id', note.id);
    if (delErr) return c.json({ error: 'save_failed', reason: delErr.message }, 500);
    const { error: insErr } = await sb.from('acc_credit_note_lines').insert(lines.map((l, i) => ({
      company_id: co.companyId, note_id: note.id, line_no: i + 1, description: l.description, account_code: l.code, amount_sen: l.amountSen,
      project_id: l.projectId,
    })));
    if (insErr) return c.json({ error: 'save_failed', reason: insErr.message }, 500);
    patch.total_sen = built.total;
  }
  const { data: saved, error: upErr } = await sb.from('acc_credit_notes').update(patch).eq('company_id', co.companyId).eq('id', note.id).select(HEADER).single();
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  if (plan) {
    const written = await writePlan(sb, { companyId: co.companyId, noteId: String(note.id), targets: plan, actor: who(c) });
    if (!written.ok) return c.json({ error: 'save_failed', reason: written.reason }, 500);
  }
  return c.json({ ok: true, note: saved });
};

export const postCreditNoteHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM('post to the general ledger'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const note = found.note;
  if (note.opening === true) return c.json(openingDocumentRefusal(String(note.note_number)), 409);
  if (note.status === 'CANCELLED') return c.json({ error: 'cancelled', message: `${note.note_number} is cancelled.` }, 409);
  const posted = await postCreditNote(c.get('supabase'), { companyId: co.companyId, note, actor: who(c) });
  if (!posted.ok) {
    if (posted.status === 'lines_required') return c.json({ error: 'lines_required', message: posted.reason }, 400);
    if (posted.status === 'load_failed' || posted.status === 'save_failed') return c.json({ error: posted.status, reason: posted.reason }, 500);
    return c.json({ error: 'post_failed', status: posted.status, reason: posted.reason }, 500);
  }
  /* The draft's knock-off carried out (owner 2026-10-01 有写发票的 CN 直接扣那张发票
     的欠款; 2026-10-02 the ticks): each planned invoice (an other debtor's: bill)
     takes its credit now — as much as it still owes; what it cannot take stays
     with the supplier or the debtor. The post stands whatever this says. */
  if ((note.kind !== 'SCN' && note.kind !== 'OCN') || posted.status !== 'posted') return c.json({ ok: true, jeNo: posted.jeNo, status: posted.status });
  const done = await carryOutPlan(c.get('supabase'), { companyId: co.companyId, note: { ...note, status: 'POSTED' } });
  if (!done.ok) {
    return c.json({ ok: true, jeNo: posted.jeNo, status: posted.status, applied: [], notApplied: `The knock-off did not run (${done.reason}) — open the note and save its ticks again.` });
  }
  return c.json({
    ok: true, jeNo: posted.jeNo, status: posted.status,
    ...(done.applied.length > 0 ? { applied: done.applied } : {}),
    ...(done.notApplied.length > 0 ? { notApplied: done.notApplied.join(' ') } : {}),
  });
};

/* ── The credit coming off the supplier's invoices (part 2) ──────────────── */

/** The supplier's invoices still owing — what the note's credit can come off. */
export const creditNoteOpenInvoicesHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const party = partyOfNote(found.note);
  if (!party) return c.json({ invoices: [] });
  const open = await partyOpenDocs(c.get('supabase'), co.companyId, party);
  if (!open.ok) return c.json({ error: 'load_failed', reason: open.reason }, 500);
  return c.json({ invoices: open.invoices });
};

/** POST /:id/apply { targets: [{ kind: 'PI' | 'API', id, amountSen }] } — 没写的先挂在
    供应商名下，再选要扣哪几张发票 (owner 2026-10-01). */
export const applyCreditNoteHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM('take a credit off an invoice'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const targets: CreditTarget[] = (Array.isArray(body?.targets) ? body.targets : []).map((t: any) => ({
    kind: String(t?.kind ?? '').toUpperCase() as CreditTarget['kind'], id: String(t?.id ?? '').trim(), amountSen: Number(t?.amountSen),
  }));
  const applied = await applyCreditNote(c.get('supabase'), { companyId: co.companyId, note: found.note, targets, actor: who(c) });
  if (!applied.ok) return c.json({ error: applied.refusal.error, message: applied.refusal.message }, applied.refusal.status);
  return c.json({ ok: true, applied: applied.applied });
};

/* ── Knock off like an AP Payment (owner 2026-10-02) ───────────────────────── */

/** GET /knock-off?supplierId= | ?debtorId= — a new note's table: the supplier's
    invoices still owing, or the other debtor's bills. */
export const supplierKnockOffHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const supplierId = String(c.req.query('supplierId') ?? '').trim();
  const debtorId = String(c.req.query('debtorId') ?? '').trim();
  let party: CreditParty;
  if (debtorId) {
    const deb = await loadDebtor(c, debtorId);
    if ('resp' in deb) return deb.resp;
    party = debtorParty(deb.debtor.id);
  } else if (supplierId) {
    const sup = await loadSupplier(c, supplierId);
    if ('resp' in sup) return sup.resp;
    party = supplierParty(sup.supplier.id);
  } else {
    return c.json({ rows: [] });
  }
  const rows = await knockOffRows(c.get('supabase'), co.companyId, { party, note: null });
  if (!rows.ok) return c.json({ error: 'load_failed', reason: rows.reason }, 500);
  return c.json({ rows: rows.rows });
};

/** GET /:id/knock-off — the note's table: what it takes from each invoice, and the credit left. */
export const creditNoteKnockOffHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const note = found.note;
  const totalSen = Number(note.total_sen ?? 0);
  const party = partyOfNote(note);
  if (!party) return c.json({ rows: [], totalSen, takenSen: 0, leftSen: totalSen, posted: note.status === 'POSTED' });
  const rows = await knockOffRows(c.get('supabase'), co.companyId, { party, note });
  if (!rows.ok) return c.json({ error: 'load_failed', reason: rows.reason }, 500);
  const takenSen = rows.rows.reduce((s, r) => s + r.noteSen, 0);
  return c.json({ rows: rows.rows, totalSen, takenSen, leftSen: Math.max(0, totalSen - takenSen), posted: note.status === 'POSTED' });
};

/** PUT /:id/allocations { targets: [{ kind, id, amountSen }] } — the knock-off
    set whole: a draft's plan (the editor's keys), a posted note's knock-off
    carried out at once (the poster's key) — untick = give it back. */
export const setCreditNoteAllocationsHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const note = found.note;
  const may = note.status === 'POSTED'
    ? hasHouzsPerm(c, 'scm.payment_voucher.post')
    : hasHouzsPerm(c, 'scm.payment_voucher.create') || hasHouzsPerm(c, 'scm.payment_voucher.write');
  if (!may) return c.json(NO_PERM('knock off a supplier\'s invoice'), 403);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const set = await setNoteKnockOff(c.get('supabase'), { companyId: co.companyId, note, targets: parseTargets(body?.targets), actor: who(c) });
  if (!set.ok) return c.json({ error: set.refusal.error, message: set.refusal.message }, set.refusal.status);
  return c.json({ ok: true, short: set.short });
};

/** POST /:id/allocations/:allocationId/remove — the credit given back to the note; the invoice owes it again. */
export const removeCreditNoteAllocationHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json(NO_PERM('give a credit back'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  if (found.note.status !== 'POSTED') return c.json({ error: 'note_not_posted', message: `${found.note.note_number} is ${String(found.note.status).toLowerCase()}.` }, 409);
  const back = await removeAllocation(c.get('supabase'), { companyId: co.companyId, note: found.note, allocationId: c.req.param('allocationId') });
  if (!back.ok) return c.json({ error: back.refusal.error, message: back.refusal.message }, back.refusal.status);
  return c.json({ ok: true });
};

export const cancelCreditNoteHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) return c.json(NO_PERM('cancel a credit or debit note'), 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadNote(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const note = found.note;
  if (note.opening === true) return c.json(openingDocumentRefusal(String(note.note_number)), 409);
  if (note.status === 'CANCELLED') return c.json({ ok: true, already: true });
  const cancelled = await cancelCreditNote(c.get('supabase'), { companyId: co.companyId, note, actor: who(c) });
  if (!cancelled.ok) {
    if (cancelled.status === 'save_failed') return c.json({ error: 'save_failed', reason: cancelled.reason }, 500);
    if (cancelled.status === 'settle_failed' || cancelled.status === 'load_failed') return c.json({ error: cancelled.status, message: cancelled.reason }, 500);
    return c.json({ error: 'reverse_failed', status: cancelled.status, reason: cancelled.reason }, 500);
  }
  return c.json({ ok: true });
};

export const creditNotes = new Hono();
/* EVERY SCM router carries the bridge (docs/bugs/0648): it turns the JWT into
   the real caller as houzsUser — what hasHouzsPerm reads — and hands out the
   scoped client. */
creditNotes.use('*', supabaseAuth);
creditNotes.get('/', listCreditNotesHandler);
creditNotes.post('/', createCreditNoteHandler);
creditNotes.post('/scan', scanSupplierCreditNoteHandler);
/* Before /:id, or 'knock-off' would be read as a note id. */
creditNotes.get('/knock-off', supplierKnockOffHandler);
creditNotes.get('/:id', creditNoteDetailHandler);
creditNotes.patch('/:id', updateCreditNoteHandler);
creditNotes.post('/:id/post', postCreditNoteHandler);
creditNotes.post('/:id/cancel', cancelCreditNoteHandler);
creditNotes.get('/:id/open-invoices', creditNoteOpenInvoicesHandler);
creditNotes.post('/:id/apply', applyCreditNoteHandler);
creditNotes.post('/:id/allocations/:allocationId/remove', removeCreditNoteAllocationHandler);
creditNotes.get('/:id/knock-off', creditNoteKnockOffHandler);
creditNotes.put('/:id/allocations', setCreditNoteAllocationsHandler);
creditNotes.post('/:id/files', uploadCreditNoteFileHandler);
creditNotes.get('/:id/files', listCreditNoteFilesHandler);
creditNotes.get('/:id/files/:fileId', streamCreditNoteFileHandler);
creditNotes.delete('/:id/files/:fileId', deleteCreditNoteFileHandler);
