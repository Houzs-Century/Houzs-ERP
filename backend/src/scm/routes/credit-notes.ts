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
//
// 2026-11-03 (owner: 「要」 — a customer CN knocks off the customer's sales
// invoices, like AutoCount): the same table and the same three calls for a CN
// — GET /knock-off?so= | ?customer= for a new note — posting nothing; a note
// that answers a deposit invoice (a close-out, a refund's, a move's) is refused
// (acc/credit-note-si.ts).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { dateOrNull } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { apControlRole, resolveRoles, type NoteParty } from '../../acc/rules';
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
  appliedByNote, applyCreditNote, carryOutPlan, checkKnockOff, customerParty, debtorParty, depositPaperBlock, knockOffRows, noteAllocations, parseTargets,
  moveNumbers, noteApplications, partyOfNote, partyOpenDocs, removeAllocation, setNoteKnockOff, supplierParty, writePlan,
  type CreditParty, type CreditTarget, type KnockOffMove,
} from '../../acc/credit-note-allocations';
import { assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit, statusChange, type AuditAction } from '../lib/entity-audit';
import { depositPapers } from '../../acc/credit-note-si';
import { deleteCreditNoteFileHandler, listCreditNoteFilesHandler, streamCreditNoteFileHandler, uploadCreditNoteFileHandler } from './credit-note-files';
import { fmtSen } from '../shared/format';
import { openingDocumentRefusal } from '../../acc/books-opening';
import { checkReturnLines, loadReturnCredit, type ReturnCredit } from '../lib/cn-from-return';

type Row = Record<string, any>;
const NO_PERM = (what: string) => ({ error: `You don't have permission to ${what}.` });
/* The document itself — number, header, lines, journal, contra — is
   acc/credit-notes.ts (docs/bugs/0831): the deposit-invoice close-out raises
   a note from inside the posting path with no request to hand, so the core
   may not live here. This file keeps the caller's half: permissions, the
   party lookup, the leaf check on a typed account, the draft edit. */

/** projectId: the event the line's money is for (owner 2026-10-22) — null = none. */
type CleanLine = { description: string | null; code: string | null; amountSen: number; projectId: number | null; returnItemId: string | null; qty: number | null };

function buildLines(raw: unknown): { lines: CleanLine[]; total: number } | { error: string; message: string } {
  const arr = Array.isArray(raw) ? raw : [];
  if (arr.length === 0 || arr.length > 50) return { error: 'lines_required', message: 'A note takes 1 to 50 lines.' };
  const lines: CleanLine[] = [];
  for (const [i, l] of arr.entries()) {
    const code = String(l?.accountCode ?? '').trim() || null;
    /* A JSON number only: Number() would read "350000" or true (= 1 sen) as an
       amount, and a NaN the screen could not parse arrives as null. */
    const amount = typeof l?.amountSen === 'number' ? l.amountSen : NaN;
    if (!Number.isInteger(amount) || amount <= 0) {
      return { error: 'bad_line', message: `Line ${i + 1}: amountSen must be a positive integer (got ${String(l?.amountSen)}).` };
    }
    const projectId = parseEventId(l?.projectId);
    if (projectId === 'invalid') return { error: 'bad_line', message: `Line ${i + 1}: projectId must be an event id (got ${String(l?.projectId)}).` };
    const returnItemId = String(l?.deliveryReturnItemId ?? '').trim() || null;
    const qty = returnItemId ? Number(l?.qty) : null;
    lines.push({ description: l?.description ? String(l.description).trim() : null, code, amountSen: amount, projectId, returnItemId, qty });
  }
  return { lines, total: lines.reduce((s, l) => s + l.amountSen, 0) };
}

const who = (c: any): string => String(c.get('houzsUser')?.name ?? c.get('user')?.id ?? '');

/* A knock-off given back or changed moves what an invoice owes, and before
   2026-11-10 it was a hard delete with no trace. The pre-flight runs before
   the first write (entity-audit.ts); the row records each document's applied
   amount from -> to, in sen, labelled by the document's number. */
const knockOffAuditRefusal = async (c: any, companyId: number, note: any, action: AuditAction): Promise<Response | null> => {
  const pf = await assertAuditWritable(c.get('supabase'), { entityType: 'CREDIT_NOTE', entityId: String(note.id), action, companyId });
  return pf.ok ? null : c.json(auditUnavailableBody(), 409);
};

const recordKnockOffAudit = async (
  c: any, companyId: number, note: any, action: AuditAction, moves: KnockOffMove[], extra: { status?: { from: string; to: string }; note?: string } = {},
): Promise<void> => {
  const sb = c.get('supabase');
  const numbers = moves.length > 0 ? await moveNumbers(sb, companyId, moves) : new Map<string, string>();
  const changes = [
    ...(extra.status ? statusChange(extra.status.from, extra.status.to) : []),
    ...compactChanges(moves.map((m) => fieldChange(`appliedSen:${numbers.get(m.id) ?? m.id}`, m.fromSen, m.toSen))),
  ];
  if (changes.length === 0) return;
  await recordEntityAudit(sb, {
    entityType: 'CREDIT_NOTE', entityId: String(note.id), entityDocNo: String(note.note_number ?? ''), action,
    actor: c.get('houzsUser'), companyId, fieldChanges: changes, statusSnapshot: extra.status?.to ?? note.status ?? null,
    ...(extra.note ? { note: extra.note } : {}),
  });
};

/* A note raised from a delivery return (backlog A1): every line names one of
   the return's lines and its units, held against what came back, what other
   live notes already credit, and the invoice's price (lib/cn-from-return.ts). */
async function checkedReturn(c: any, companyId: number, returnId: string, lines: CleanLine[], excludeNoteId: string | null): Promise<{ value: ReturnCredit } | { resp: Response }> {
  const loaded = await loadReturnCredit(c.get('supabase'), companyId, returnId, excludeNoteId);
  if (!loaded.ok) {
    return { resp: loaded.status === 404 ? c.json({ error: 'return_unknown', message: loaded.reason }, 400) : c.json({ error: 'load_failed', reason: loaded.reason }, 500) };
  }
  const r = loaded.value;
  if (String(r.ret.status).toUpperCase() === 'CANCELLED') {
    return { resp: c.json({ error: 'return_cancelled', message: `${r.ret.return_number} is cancelled — nothing came back to credit.` }, 409) };
  }
  const unlinked = lines.findIndex((l) => !l.returnItemId);
  if (unlinked >= 0) return { resp: c.json({ error: 'return_line_required', message: `Line ${unlinked + 1} names no line of ${r.ret.return_number} — a note from a return credits its returned lines only.` }, 400) };
  const refusal = checkReturnLines(r.lines, lines.map((l) => ({ returnItemId: String(l.returnItemId), qty: Number(l.qty), amountSen: l.amountSen })));
  return refusal ? { resp: c.json(refusal, 409) } : { value: r };
}

/* The database's own cap (migration 20261110T0200) refused a line another save took first. */
const overReturnFromDb = (reason: string): boolean => /over_return_credit/.test(reason);

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
  /* An other debtor's account code (owner 2026-11-03), for the screens and the
     print. Read here beside the note, never stored as party_code: the journal
     line copies party_code, and the control's party fields stay as they were. */
  const codeOfDebtor = new Map<string, string | null>();
  const debtorIds = idsOf('debtor_id');
  if (debtorIds.length > 0) {
    const co = requireActiveCompanyId(c);
    if (!co.ok) return { resp: c.json(co.refusal, 409) };
    const { data, error } = await c.get('supabase').from('acc_debtors').select('id, code').eq('company_id', co.companyId).in('id', debtorIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const d of (Array.isArray(data) ? data : []) as Array<{ id: string; code: string | null }>) codeOfDebtor.set(String(d.id), d.code ?? null);
  }
  return { rows: rows.map((r) => ({
    ...r,
    sales_invoice_number: num(r.sales_invoice_id), purchase_invoice_number: num(r.purchase_invoice_id), ap_invoice_number: num(r.ap_invoice_id),
    debtor_code: typeof r.debtor_id === 'string' ? codeOfDebtor.get(r.debtor_id) ?? null : null,
  })) };
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
  /* A supplier note's control by its supplier code (party_code), the AP
     rule's one home — Supplier bills' Control column and Trade / Other filter. */
  for (const r of numbered.rows) if (r.kind === 'SCN') r.controlRole = apControlRole(r.party_code ?? null);
  /* A posted supplier, other-debtor or customer note's use (the redesign's "To
     use" / "Used", Money in's Knocks off): what its applications took, and the
     credit left. */
  const credited = numbered.rows.filter((r) => (r.kind === 'SCN' || r.kind === 'OCN' || r.kind === 'CN') && r.status === 'POSTED');
  if (credited.length > 0) {
    const used = await appliedByNote(sb, co.companyId, credited.map((r) => String(r.id)));
    if (!used.ok) return c.json({ error: 'load_failed', reason: used.reason }, 500);
    for (const r of credited) {
      const applied = used.byNote.get(String(r.id)) ?? 0;
      r.appliedSen = applied;
      r.unusedSen = Math.max(0, Number(r.total_sen ?? 0) - applied);
    }
  }
  /* A customer note that answers a deposit invoice knocks off nothing — its
     credit is not the customer's (acc/credit-note-si.ts) — so it carries what it
     is instead of credit left. */
  const customerNotes = numbered.rows.filter((r) => r.kind === 'CN');
  if (customerNotes.length > 0) {
    const papers = await depositPapers(sb, co.companyId, customerNotes);
    if (!papers.ok) return c.json({ error: 'load_failed', reason: papers.reason }, 500);
    for (const r of customerNotes) {
      const paper = papers.value.get(String(r.id));
      r.depositPaper = paper?.kind ?? null;
      if (paper && r.unusedSen !== undefined) r.unusedSen = 0;
    }
  }
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
     other debtor's the same, off the debtor's bills; a customer's off the
     customer's sales invoices (2026-11-03). */
  let credit: Row = {};
  if (found.note.kind === 'SCN' || found.note.kind === 'OCN' || found.note.kind === 'CN') {
    const al = await noteAllocations(sb, co.companyId, found.note);
    if (!al.ok) return c.json({ error: 'load_failed', reason: al.reason }, 500);
    credit = { allocations: al.allocations, appliedSen: al.appliedSen, leftSen: al.leftSen };
  }
  /* A customer note answering a deposit invoice says what it answers, leaves no
     credit on the customer, and a close-out names the final invoice it closed
     against — its print's KNOCKED OFF AGAINST. */
  if (found.note.kind === 'CN') {
    const papers = await depositPapers(sb, co.companyId, [found.note]);
    if (!papers.ok) return c.json({ error: 'load_failed', reason: papers.reason }, 500);
    const paper = papers.value.get(String(found.note.id)) ?? null;
    credit.depositPaper = paper;
    if (paper) credit.leftSen = 0;
    if (paper?.kind === 'closes' && found.note.sales_invoice_id) {
      const { data: si, error: siErr } = await scopeToCompany(sb.from('sales_invoices').select('id, invoice_number, invoice_date, total_sen').eq('id', found.note.sales_invoice_id), c).maybeSingle();
      if (siErr) return c.json({ error: 'load_failed', reason: siErr.message }, 500);
      const s = si as Row | null;
      credit.closedInvoice = s ? { id: String(s.id), number: String(s.invoice_number), date: s.invoice_date ?? null, totalSen: Number(s.total_sen ?? 0) } : null;
    }
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

  /* From a delivery return (backlog A1): a customer's note, its customer and
     invoice the return's own, each line one of the return's lines. */
  const deliveryReturnId = String(body.deliveryReturnId ?? '').trim() || null;
  let fromReturn: ReturnCredit | null = null;
  if (deliveryReturnId) {
    if (kind !== 'CN') return c.json({ error: 'return_not_this_kind', message: 'Only a customer credit note answers a delivery return.' }, 400);
    const checked = await checkedReturn(c, co.companyId, deliveryReturnId, built.lines, null);
    if ('resp' in checked) return checked.resp;
    fromReturn = checked.value;
    body.soDocNo = fromReturn.soDocNo ?? '';
    body.salesInvoiceId = fromReturn.invoice?.id ?? '';
    if (!String(body.sourceDocNo ?? '').trim()) body.sourceDocNo = fromReturn.ret.return_number;
  } else if (built.lines.some((l) => l.returnItemId)) {
    return c.json({ error: 'return_required', message: 'A line names a delivery-return line, but the note names no delivery return.' }, 400);
  }

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
  if (body.allocations !== undefined && kind === 'DN' && parseTargets(body.allocations).length > 0) {
    return c.json({ error: 'invoice_not_this_kind', message: 'A debit note knocks nothing off.' }, 400);
  }
  /* A customer's note knocks off the customer's sales invoices (2026-11-03),
     planned on the draft — never another party's documents. */
  if (kind === 'CN' && body.allocations !== undefined) {
    plan = parseTargets(body.allocations);
    if (plan.some((t) => t.kind !== 'SI')) {
      return c.json({ error: 'invoice_not_this_kind', message: "A customer's credit note knocks off the customer's sales invoices." }, 400);
    }
    const checked = await checkKnockOff(sb, { companyId: co.companyId, label: 'This note', party: customerParty({ code: party.code, name: party.name }), totalSen: built.total, posted: false, targets: plan, current: new Map() });
    if (!checked.ok) return c.json({ error: checked.refusal.error, message: checked.refusal.message }, checked.refusal.status);
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
    deliveryReturnId: fromReturn ? fromReturn.ret.id : null,
    sourceDocNo: String(body.sourceDocNo ?? '').trim() || null,
    noteDate,
    reason: String(body.reason ?? '').trim() || null,
    notes: String(body.notes ?? '').trim() || null,
    lines: lines.map((l) => ({ description: l.description, code: l.code, amountSen: l.amountSen, projectId: l.projectId, returnItemId: l.returnItemId, qty: l.qty })),
    knockOffApInvoiceIds: plan.filter((t) => t.kind === 'API').map((t) => t.id),
    createdBy: who(c),
  });
  if (!raised.ok) {
    if (overReturnFromDb(raised.reason)) return c.json({ error: 'over_return_credit', message: 'Another credit note took these returned units first — open the return again to see what is left.' }, 409);
    return c.json({ error: 'save_failed', reason: raised.reason }, 500);
  }
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
    if (!party) return c.json({ error: 'invoice_not_this_kind', message: 'A debit note knocks nothing off.' }, 400);
    plan = parseTargets(body.allocations);
    /* A draft close-out (its posting refused at birth) takes no plan either. */
    if (plan.length > 0) {
      const paper = await depositPaperBlock(sb, co.companyId, note);
      if (!paper.ok) return c.json({ error: 'load_failed', reason: paper.reason }, 500);
      if (paper.refusal) return c.json({ error: paper.refusal.error, message: paper.refusal.message }, 409);
    }
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
  if (built && note.delivery_return_id) {
    const checked = await checkedReturn(c, co.companyId, String(note.delivery_return_id), built.lines, String(note.id));
    if ('resp' in checked) return checked.resp;
  } else if (built && built.lines.some((l) => l.returnItemId)) {
    return c.json({ error: 'return_required', message: `${note.note_number} answers no delivery return — its lines cannot name return lines.` }, 400);
  }
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
      project_id: l.projectId, delivery_return_item_id: l.returnItemId, qty: l.returnItemId ? l.qty : null,
    })));
    if (insErr) {
      if (overReturnFromDb(insErr.message)) return c.json({ error: 'over_return_credit', message: 'Another credit note took these returned units first — open the return again to see what is left.' }, 409);
      return c.json({ error: 'save_failed', reason: insErr.message }, 500);
    }
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
  if ((note.kind !== 'SCN' && note.kind !== 'OCN' && note.kind !== 'CN') || posted.status !== 'posted') return c.json({ ok: true, jeNo: posted.jeNo, status: posted.status });
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

/** GET /knock-off?supplierId= | ?debtorId= | ?so= | ?customer= — a new note's
    table: the supplier's invoices still owing, the other debtor's bills, or the
    customer's sales invoices — the customer the note will carry: the sales
    order's (?so=), else the name typed (?customer=). */
export const supplierKnockOffHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const supplierId = String(c.req.query('supplierId') ?? '').trim();
  const debtorId = String(c.req.query('debtorId') ?? '').trim();
  const so = String(c.req.query('so') ?? '').trim();
  const customer = String(c.req.query('customer') ?? '').trim();
  let party: CreditParty;
  if (debtorId) {
    const deb = await loadDebtor(c, debtorId);
    if ('resp' in deb) return deb.resp;
    party = debtorParty(deb.debtor.id);
  } else if (supplierId) {
    const sup = await loadSupplier(c, supplierId);
    if ('resp' in sup) return sup.resp;
    party = supplierParty(sup.supplier.id);
  } else if (so || customer) {
    const who = await resolveCustomer(c, so ? { soDocNo: so } : { partyName: customer });
    if ('resp' in who) return who.resp;
    party = customerParty({ code: who.party.code, name: who.party.name });
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
  /* A note answering a deposit invoice has no credit on the customer to knock off — it says why. */
  const paper = await depositPaperBlock(c.get('supabase'), co.companyId, note);
  if (!paper.ok) return c.json({ error: 'load_failed', reason: paper.reason }, 500);
  if (paper.refusal) return c.json({ rows: [], totalSen, takenSen: 0, leftSen: 0, posted: note.status === 'POSTED', refusal: paper.refusal.message });
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
  if (!may) return c.json(NO_PERM(note.kind === 'CN' ? 'knock off a customer\'s invoice' : note.kind === 'OCN' ? 'knock off a debtor\'s bill' : 'knock off a supplier\'s invoice'), 403);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (note.status === 'POSTED') {
    const refused = await knockOffAuditRefusal(c, co.companyId, note, 'UPDATE');
    if (refused) return refused;
  }
  const set = await setNoteKnockOff(c.get('supabase'), { companyId: co.companyId, note, targets: parseTargets(body?.targets), actor: who(c) });
  await recordKnockOffAudit(c, co.companyId, note, 'UPDATE', set.moved ?? [], set.ok ? {} : { note: `Stopped part-way: ${set.refusal.message}` });
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
  const refused = await knockOffAuditRefusal(c, co.companyId, found.note, 'UPDATE');
  if (refused) return refused;
  const back = await removeAllocation(c.get('supabase'), { companyId: co.companyId, note: found.note, allocationId: c.req.param('allocationId') });
  if (!back.ok) return c.json({ error: back.refusal.error, message: back.refusal.message }, back.refusal.status);
  await recordKnockOffAudit(c, co.companyId, found.note, 'UPDATE', [back.moved]);
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
  const refused = await knockOffAuditRefusal(c, co.companyId, note, 'CANCEL');
  if (refused) return refused;
  const statusBefore = String(note.status);
  const applied = await noteApplications(c.get('supabase'), co.companyId, String(note.id));
  if (!applied.ok) return c.json({ error: 'load_failed', reason: applied.reason }, 500);
  const cancelled = await cancelCreditNote(c.get('supabase'), { companyId: co.companyId, note, actor: who(c) });
  if (!cancelled.ok) {
    if (cancelled.status === 'save_failed') return c.json({ error: 'save_failed', reason: cancelled.reason }, 500);
    if (cancelled.status === 'settle_failed' || cancelled.status === 'load_failed') return c.json({ error: cancelled.status, message: cancelled.reason }, 500);
    return c.json({ error: 'reverse_failed', status: cancelled.status, reason: cancelled.reason }, 500);
  }
  if (cancelled.status === 'cancelled') await recordKnockOffAudit(c, co.companyId, note, 'CANCEL', applied.moves, { status: { from: statusBefore, to: 'CANCELLED' } });
  return c.json({ ok: true });
};

/** GET /from-return/:returnId — a new customer note's starting point from a
    delivery return (backlog A1): the customer's order, the invoice that billed
    most of the lines, each returned line priced off that billing with the
    units still uncredited, and the notes already raised from it. */
export const creditNoteFromReturnHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const loaded = await loadReturnCredit(c.get('supabase'), co.companyId, c.req.param('returnId'), null);
  if (!loaded.ok) return loaded.status === 404 ? c.json({ error: 'not_found', message: loaded.reason }, 404) : c.json({ error: 'load_failed', reason: loaded.reason }, 500);
  const r = loaded.value;
  return c.json({
    deliveryReturn: { id: r.ret.id, returnNumber: r.ret.return_number, status: r.ret.status, doDocNo: r.ret.do_doc_no, customer: r.ret.debtor_name },
    soDocNo: r.soDocNo,
    invoice: r.invoice ? { id: r.invoice.id, number: r.invoice.invoice_number } : null,
    lines: r.lines.map((l) => ({ ...l, capSen: l.unitSen === null ? null : Math.round(l.unitSen * l.remainingQty) })),
    notes: r.notes.map((n) => ({ id: n.id, number: n.note_number, status: n.status, totalSen: n.total_sen })),
    state: r.state,
  });
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
creditNotes.get('/from-return/:returnId', creditNoteFromReturnHandler);
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
