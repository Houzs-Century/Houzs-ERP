// ----------------------------------------------------------------------------
// Credit and debit notes — the document core, with no request context
// (docs/bugs/0827 for the notes, 0831 for why this is its own module).
//
// Two callers raise a note and only one of them is an HTTP request:
// /scm/credit-notes (Finance, by hand) and the deposit-invoice close-out,
// which raises one credit note per deposit invoice the moment the order's
// final sales invoice posts its revenue — from inside the posting path, with
// no request to hand. Everything that must be true of a note therefore lives
// here: the number, the header and its lines, the journal by kind through
// the one gate, the contra on cancel. The route keeps what is the caller's —
// permissions, the party lookup, the leaf check on a typed account, the
// draft edit.
//
//   CN  — to a customer: Dr each line's account / Cr AR, party the customer.
//   DN  — to a customer: Dr AR, party the customer / Cr each line's account.
//   SCN — from a supplier: Dr the supplier's AP control / Cr each line's account.
// ----------------------------------------------------------------------------

import { postJournal, reverseJournal } from './engine';
import { creditNoteLines, debitNoteLines, supplierCreditNoteLines, resolveRoles, type NoteLine, type NoteParty } from './rules';
import { docMonthTag, mintMonthlyDocNo } from '../scm/lib/doc-no';
import { todayMyt } from '../scm/lib/my-time';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

export type NoteKind = 'CN' | 'DN' | 'SCN';
export const NOTE_KINDS: ReadonlySet<string> = new Set(['CN', 'DN', 'SCN']);
export const NOTE_KIND_WORD: Record<NoteKind, string> = { CN: 'Credit note', DN: 'Debit note', SCN: 'Supplier credit note' };

export const CREDIT_NOTE_HEADER = 'id, company_id, note_number, kind, party_type, party_code, party_name, supplier_id, so_doc_no, sales_invoice_id, ap_invoice_id, purchase_invoice_id, source_doc_no, note_date, total_sen, reason, notes, status, je_no, created_at, created_by, updated_at, posted_at, posted_by, cancelled_at, cancelled_by';
export const CREDIT_NOTE_LINE = 'id, line_no, description, account_code, amount_sen';

export type CreditNoteLineInput = { description: string | null; code: string; amountSen: number };

export type InsertCreditNoteInput = {
  companyId: number;
  /** The document prefix the number is minted under (companyDocPrefix / docPrefixForCode). */
  docPrefix: string;
  kind: NoteKind;
  party: NoteParty;
  supplierId?: string | null;
  soDocNo?: string | null;
  salesInvoiceId?: string | null;
  apInvoiceId?: string | null;
  purchaseInvoiceId?: string | null;
  sourceDocNo?: string | null;
  noteDate: string;
  reason?: string | null;
  notes?: string | null;
  /** Every line already carries its account — the caller resolved the kind's default. */
  lines: CreditNoteLineInput[];
  createdBy: string | null;
};

/** Raise a DRAFT note: the number, the header, the lines — the lines' failure
    takes the header with it, so a note is never on file without them. */
export async function insertCreditNote(sb: Db, p: InsertCreditNoteInput): Promise<{ ok: true; note: Row } | { ok: false; reason: string }> {
  if (p.lines.length === 0) return { ok: false, reason: 'a note takes at least one line' };
  const total = p.lines.reduce((s, l) => s + l.amountSen, 0);
  const noteNumber = await mintMonthlyDocNo(sb, 'acc_credit_notes', 'note_number', `${p.docPrefix}${p.kind}-${docMonthTag(p.noteDate)}`);
  const { data: note, error: insErr } = await sb.from('acc_credit_notes').insert({
    company_id: p.companyId,
    note_number: noteNumber,
    kind: p.kind,
    party_type: p.kind === 'SCN' ? 'SUPPLIER' : 'CUSTOMER',
    party_code: p.party.code,
    party_name: p.party.name,
    supplier_id: p.supplierId ?? null,
    so_doc_no: p.soDocNo ?? null,
    sales_invoice_id: p.salesInvoiceId ?? null,
    ap_invoice_id: p.apInvoiceId ?? null,
    purchase_invoice_id: p.purchaseInvoiceId ?? null,
    source_doc_no: p.sourceDocNo ?? null,
    note_date: p.noteDate,
    total_sen: total,
    reason: p.reason ?? null,
    notes: p.notes ?? null,
    status: 'DRAFT',
    je_no: null,
    created_by: p.createdBy,
  }).select(CREDIT_NOTE_HEADER).single();
  if (insErr || !note) return { ok: false, reason: insErr?.message ?? 'insert returned nothing' };
  const { error: lineErr } = await sb.from('acc_credit_note_lines').insert(p.lines.map((l, i) => ({
    company_id: p.companyId, note_id: (note as Row).id, line_no: i + 1, description: l.description, account_code: l.code, amount_sen: l.amountSen,
  })));
  if (lineErr) {
    await sb.from('acc_credit_notes').delete().eq('company_id', p.companyId).eq('id', (note as Row).id);
    return { ok: false, reason: lineErr.message };
  }
  return { ok: true, note: note as Row };
}

/** Post one note's journal through the one gate — keyed (kind, note number),
    so a second post echoes — and mark it POSTED. A cancelled note refuses. */
export async function postCreditNote(
  sb: Db,
  p: { companyId: number; note: Row; actor: string | null },
): Promise<{ ok: true; jeNo: string; status: 'posted' | 'already_posted' } | { ok: false; status: string; reason: string }> {
  const note = p.note;
  if (note.status === 'CANCELLED') return { ok: false, status: 'cancelled', reason: `${note.note_number} is cancelled.` };
  const { data: lineRows, error: lErr } = await sb.from('acc_credit_note_lines')
    .select(CREDIT_NOTE_LINE).eq('company_id', p.companyId).eq('note_id', note.id).order('line_no');
  if (lErr) return { ok: false, status: 'load_failed', reason: lErr.message };
  const lines: NoteLine[] = ((Array.isArray(lineRows) ? lineRows : []) as Array<{ description: string | null; account_code: string; amount_sen: number }>)
    .map((l) => ({ accountCode: l.account_code, amountSen: Number(l.amount_sen), description: l.description }));
  if (lines.length === 0) return { ok: false, status: 'lines_required', reason: 'This note has no lines to post.' };
  const kind = String(note.kind) as NoteKind;
  const party: NoteParty = { code: note.party_code ?? null, name: note.party_name ?? null };
  const roles = await resolveRoles(sb, p.companyId);
  const ruleLines = kind === 'CN' ? creditNoteLines(roles, { note_number: String(note.note_number) }, party, lines)
    : kind === 'DN' ? debitNoteLines(roles, { note_number: String(note.note_number) }, party, lines)
    : supplierCreditNoteLines(roles, { note_number: String(note.note_number) }, party, lines);
  const je = await postJournal(sb, {
    companyId: p.companyId,
    entryDate: String(note.note_date),
    sourceType: kind,
    sourceDocNo: String(note.note_number),
    narration: `${NOTE_KIND_WORD[kind]} ${note.note_number} — ${party.name ?? party.code ?? 'party'}${note.reason ? ` (${note.reason})` : ''}`,
    lines: ruleLines,
  });
  if (!je.ok) return { ok: false, status: je.status, reason: (je as { reason?: string }).reason ?? je.status };
  if (note.status === 'DRAFT') {
    const { error: upErr } = await sb.from('acc_credit_notes').update({
      status: 'POSTED', je_no: je.jeNo, posted_at: new Date().toISOString(), posted_by: p.actor, updated_at: new Date().toISOString(),
    }).eq('company_id', p.companyId).eq('id', note.id);
    if (upErr) return { ok: false, status: 'save_failed', reason: upErr.message };
  }
  return { ok: true, jeNo: je.jeNo, status: je.status === 'already_posted' ? 'already_posted' : 'posted' };
}

/** Cancel one note: the contra for a posted one (dated the day of the
    cancel), nothing for a draft; the row stays on file as CANCELLED. */
export async function cancelCreditNote(
  sb: Db,
  p: { companyId: number; note: Row; actor: string | null; entryDate?: string },
): Promise<{ ok: true; status: 'cancelled' | 'already_cancelled'; contraJeNo: string | null } | { ok: false; status: string; reason: string }> {
  const note = p.note;
  if (note.status === 'CANCELLED') return { ok: true, status: 'already_cancelled', contraJeNo: null };
  let contraJeNo: string | null = null;
  if (note.status === 'POSTED') {
    const kind = String(note.kind) as NoteKind;
    const rev = await reverseJournal(sb, {
      sourceType: kind,
      sourceDocNo: String(note.note_number),
      companyId: p.companyId,
      narration: (orig) => `Reversal of ${orig.je_no} — ${NOTE_KIND_WORD[kind].toLowerCase()} ${note.note_number} cancelled`,
      entryDate: p.entryDate ?? todayMyt(),
    });
    if (!rev.ok) return { ok: false, status: rev.status, reason: (rev as { reason?: string }).reason ?? rev.status };
    contraJeNo = rev.status === 'reversed' ? rev.jeNo : null;
  }
  const { error: upErr } = await sb.from('acc_credit_notes').update({
    status: 'CANCELLED', cancelled_at: new Date().toISOString(), cancelled_by: p.actor, updated_at: new Date().toISOString(),
  }).eq('company_id', p.companyId).eq('id', note.id);
  if (upErr) return { ok: false, status: 'save_failed', reason: upErr.message };
  return { ok: true, status: 'cancelled', contraJeNo };
}
