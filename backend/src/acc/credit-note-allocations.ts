// ----------------------------------------------------------------------------
// credit-note-allocations — a supplier credit note's credit coming off the
// supplier's invoices (owner 2026-10-01, Supplier CN part 2: 有写发票的 CN 直接扣
// 那张发票的欠款；没写的先挂在 Diglant 名下，再选要扣哪几张发票；付款时只付剩下的),
// and since 2026-10-28 an other-debtor credit note's coming off the debtor's
// bills (owner: Customer & Other Debtor CN / DN — 「可以」).
//
// The way a payment voucher's money comes off them (scm.pv_allocations): one row
// per document credited (scm.acc_credit_note_allocations, 20261002T0100), the
// document's paid_sen moved through the SAME settle functions an AP Payment uses
// (scm/lib/pi-settlement.ts, ap-invoice-settlement.ts — row lock, clamp at write
// time) — a debtor bill's received_sen through its twin, the one a debtor
// receipt's knock-off moves (debtor-bill-settlement.ts) — and applied_sen
// recording what was actually moved, so a remove or a cancel gives back exactly
// that. The ledger is not touched: the note's own journal (Dr AP control / Cr
// its lines; Dr its lines / Cr the other-debtor control) already carries the
// money; this is the document's side of it. A payment then pays what is left.
//
// Since 2026-11-03 (owner: 「要」, his design "like AutoCount") a CUSTOMER's
// credit note knocks off the customer's SALES INVOICES the same way — one row
// per invoice (sales_invoice_id), set whole on the same table — but nothing is
// settled into the invoice: its paid_sen feeds the overpayment rule, so the
// credit stays a row of its own that every reader of the invoice's outstanding
// subtracts (credit-note-si.ts, scm/lib/si-credit-notes.ts), and the invoice's
// status is rolled again to follow it. A deposit paper (the note closing a
// deposit invoice at the final invoice, a refund's, a move's) knocks off nothing.
// ----------------------------------------------------------------------------

import { settlePiPaidSen } from '../scm/lib/pi-settlement';
import { settleApInvoicePaidSen } from '../scm/lib/ap-invoice-settlement';
import { settleDebtorBillReceivedSen } from '../scm/lib/debtor-bill-settlement';
import { absorbsOrderDeposit } from '../scm/lib/si-order-deposit';
import { fmtSen } from '../scm/shared/format';
import {
  customerOfNote, customerOpenInvoices, depositPapers, depositPaperRefusal, refreshSiStatuses, sameCustomer, sisOwing, type CustomerKey,
} from './credit-note-si';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

export type CreditTargetKind = 'PI' | 'API' | 'ODB' | 'SI';
export type CreditTarget = { kind: CreditTargetKind; id: string; amountSen: number };

/* Each document a credit comes off, by the columns its own table names it with. */
type DocTable = {
  table: string; column: 'purchase_invoice_id' | 'ap_invoice_id' | 'debtor_bill_id' | 'sales_invoice_id';
  owner: 'supplier_id' | 'debtor_id' | 'debtor_code'; number: string; paid: 'paid_sen' | 'received_sen'; ref: string | null; date: string;
  /** The statuses that still owe. */
  owing: ReadonlySet<string>;
};
const SUPPLIER_OWING: ReadonlySet<string> = new Set(['POSTED', 'PARTIALLY_PAID']);
const TABLE: Record<CreditTargetKind, DocTable> = {
  PI: { table: 'purchase_invoices', column: 'purchase_invoice_id', owner: 'supplier_id', number: 'invoice_number', paid: 'paid_sen', ref: 'supplier_invoice_ref', date: 'invoice_date', owing: SUPPLIER_OWING },
  API: { table: 'ap_invoices', column: 'ap_invoice_id', owner: 'supplier_id', number: 'invoice_number', paid: 'paid_sen', ref: 'supplier_invoice_ref', date: 'invoice_date', owing: SUPPLIER_OWING },
  /* A debtor bill is POSTED until it is received in full (PAID). */
  ODB: { table: 'acc_debtor_bills', column: 'debtor_bill_id', owner: 'debtor_id', number: 'bill_number', paid: 'received_sen', ref: null, date: 'bill_date', owing: new Set(['POSTED']) },
  /* A sales invoice is read by credit-note-si.ts — what it owes is not total
     less paid (its order's deposit and the credit notes come off too), and its
     customer is its AR party; only the names below are read here. */
  SI: { table: 'sales_invoices', column: 'sales_invoice_id', owner: 'debtor_code', number: 'invoice_number', paid: 'paid_sen', ref: 'so_doc_no', date: 'invoice_date', owing: new Set() },
};
const ALLOCATION_COLS = 'id, purchase_invoice_id, ap_invoice_id, debtor_bill_id, sales_invoice_id, amount_sen, applied_sen';
const kindOfRow = (r: Row): CreditTargetKind => (r.purchase_invoice_id ? 'PI' : r.ap_invoice_id ? 'API' : r.sales_invoice_id ? 'SI' : 'ODB');
const docSelect = (kind: CreditTargetKind): string => {
  const t = TABLE[kind];
  return ['id', t.number, t.owner, t.ref, t.date, 'total_sen', t.paid, 'status'].filter(Boolean).join(', ');
};

/* A sales invoice takes a credit note's knock-off as the row itself — nothing
   is settled into it (its paid_sen feeds the overpayment rule) — so what was
   asked, checked against what it owes first, is what it took. */
const settle = (sb: Db, kind: CreditTargetKind, id: string, delta: number) =>
  kind === 'SI' ? Promise.resolve({ ok: true, appliedSen: delta, clampedSen: 0 } as { ok: boolean; appliedSen: number; clampedSen: number; reason?: string })
    : kind === 'PI' ? settlePiPaidSen(sb, id, delta) : kind === 'API' ? settleApInvoicePaidSen(sb, id, delta) : settleDebtorBillReceivedSen(sb, id, delta);

/** Whose documents a credit comes off: a supplier note's supplier (purchase and
    AP invoices), an other-debtor note's debtor (debtor bills), a customer
    note's customer (sales invoices — its AR party, `customer`). */
export type CreditParty = { owner: 'supplier_id' | 'debtor_id' | 'customer'; id: string; kinds: readonly CreditTargetKind[]; customer?: CustomerKey };
export const supplierParty = (supplierId: string): CreditParty => ({ owner: 'supplier_id', id: supplierId, kinds: ['PI', 'API'] });
export const debtorParty = (debtorId: string): CreditParty => ({ owner: 'debtor_id', id: debtorId, kinds: ['ODB'] });
export const customerParty = (customer: CustomerKey): CreditParty => ({
  owner: 'customer', id: `${customer.code ?? ''}|${customer.name ?? ''}`, kinds: ['SI'], customer,
});
/** The party a stored note knocks off for — none for a debit note. */
export const partyOfNote = (note: Row): CreditParty | null =>
  note.kind === 'SCN' && note.supplier_id ? supplierParty(String(note.supplier_id))
    : note.kind === 'OCN' && note.debtor_id ? debtorParty(String(note.debtor_id))
      : note.kind === 'CN' ? customerParty(customerOfNote(note))
        : null;
const words = (party: CreditParty) => (party.owner === 'debtor_id'
  ? { who: 'debtor', doc: 'bill' }
  : party.owner === 'customer' ? { who: 'customer', doc: 'invoice' } : { who: 'supplier', doc: 'invoice' });
/** Where a credit a document could not take stays. */
const staysWith = (kind: unknown): string => (kind === 'OCN' ? 'stays with the debtor' : kind === 'CN' ? 'stays as credit on the customer' : 'stays with the supplier');

export type AllocationView = {
  id: string; kind: CreditTargetKind; docId: string; number: string | null;
  /** The document's own date and total, for the note's print (KNOCKED OFF AGAINST). */
  docDate: string | null; docTotalSen: number | null;
  amountSen: number; appliedSen: number; createdAt: string | null; createdBy: string | null;
};

/** The note's applications, each with its document's number, and the credit left. */
export async function noteAllocations(sb: Db, companyId: number, note: Row): Promise<
  { ok: true; allocations: AllocationView[]; appliedSen: number; leftSen: number } | { ok: false; reason: string }
> {
  const { data, error } = await sb.from('acc_credit_note_allocations')
    .select(`${ALLOCATION_COLS}, created_at, created_by`)
    .eq('company_id', companyId).eq('note_id', note.id).order('created_at');
  if (error) return { ok: false, reason: error.message };
  const rows = (data ?? []) as Row[];
  const docs = new Map<string, Row>();
  for (const kind of ['PI', 'API', 'ODB', 'SI'] as const) {
    const ids = [...new Set(rows.filter((r) => kindOfRow(r) === kind).map((r) => r[TABLE[kind].column]).filter(Boolean).map(String))];
    if (ids.length === 0) continue;
    const t = TABLE[kind];
    const { data: found, error: dErr } = await sb.from(t.table).select(`id, ${t.number}, ${t.date}, total_sen`).eq('company_id', companyId).in('id', ids);
    if (dErr) return { ok: false, reason: dErr.message };
    for (const d of (found ?? []) as Row[]) docs.set(String(d.id), { number: String(d[t.number]), date: d[t.date] ?? null, total: Number(d.total_sen ?? 0) });
  }
  const allocations: AllocationView[] = rows.map((r) => {
    const kind = kindOfRow(r);
    const docId = String(r[TABLE[kind].column]);
    const doc = docs.get(docId);
    return {
      id: String(r.id), kind, docId, number: doc?.number ?? null, docDate: doc?.date ?? null, docTotalSen: doc ? doc.total : null,
      amountSen: Number(r.amount_sen ?? 0), appliedSen: Number(r.applied_sen ?? 0),
      createdAt: r.created_at ?? null, createdBy: r.created_by ?? null,
    };
  });
  const appliedSen = allocations.reduce((s, a) => s + a.appliedSen, 0);
  return { ok: true, allocations, appliedSen, leftSen: Math.max(0, Number(note.total_sen ?? 0) - appliedSen) };
}

/** What each note has used, summed off its applications — the list's
    "To use" / "Used" (the redesign's Credit notes tab). Read in batches of
    note ids, every page of each. */
export async function appliedByNote(sb: Db, companyId: number, noteIds: string[]): Promise<
  { ok: true; byNote: Map<string, number> } | { ok: false; reason: string }
> {
  const byNote = new Map<string, number>();
  const ids = [...new Set(noteIds)];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('acc_credit_note_allocations').select('id, note_id, applied_sen')
        .eq('company_id', companyId).in('note_id', batch).order('id').range(from, from + 999);
      if (error) return { ok: false, reason: error.message };
      const rows = (data ?? []) as Row[];
      for (const r of rows) byNote.set(String(r.note_id), (byNote.get(String(r.note_id)) ?? 0) + Number(r.applied_sen ?? 0));
      if (rows.length < 1000) break;
    }
  }
  return { ok: true, byNote };
}

export type OpenInvoice = {
  kind: CreditTargetKind; id: string; number: string; invoiceRef: string | null; invoiceDate: string | null;
  totalSen: number; paidSen: number; outstandingSen: number; status: string;
};

const openView = (kind: CreditTargetKind, r: Row): OpenInvoice => {
  const t = TABLE[kind];
  const total = Number(r.total_sen ?? 0), paid = Number(r[t.paid] ?? 0);
  return {
    kind, id: String(r.id), number: String(r[t.number]), invoiceRef: t.ref ? r[t.ref] ?? null : null, invoiceDate: r[t.date] ?? null,
    totalSen: total, paidSen: paid, outstandingSen: total - paid, status: String(r.status),
  };
};

/** The party's documents with money still owed — what a credit can come off. */
export async function partyOpenDocs(sb: Db, companyId: number, party: CreditParty): Promise<{ ok: true; invoices: OpenInvoice[] } | { ok: false; reason: string }> {
  if (party.owner === 'customer') {
    const open = await customerOpenInvoices(sb, companyId, party.customer ?? { code: null, name: null });
    if (!open.ok) return open;
    return {
      ok: true,
      invoices: open.value.map((s) => ({
        kind: 'SI' as const, id: s.id, number: s.number, invoiceRef: s.soDocNo, invoiceDate: s.date,
        totalSen: s.totalSen, paidSen: s.totalSen - s.owedSen, outstandingSen: s.owedSen, status: s.status,
      })),
    };
  }
  const out: OpenInvoice[] = [];
  for (const kind of party.kinds) {
    const t = TABLE[kind];
    const { data, error } = await sb.from(t.table).select(docSelect(kind))
      .eq('company_id', companyId).eq(t.owner, party.id).in('status', [...t.owing]);
    if (error) return { ok: false, reason: error.message };
    for (const r of (data ?? []) as Row[]) {
      const v = openView(kind, r);
      if (v.outstandingSen <= 0) continue;
      out.push(v);
    }
  }
  out.sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')) || a.number.localeCompare(b.number));
  return { ok: true, invoices: out };
}

/** The supplier's invoices with money still owed — what a credit can come off. */
export const supplierOpenInvoices = (sb: Db, companyId: number, supplierId: string) => partyOpenDocs(sb, companyId, supplierParty(supplierId));

export type ApplyRefusal = { status: number; error: string; message: string };

/** Take the credit off the named documents. Every target is checked before any
    is written — the note posted and a supplier's or an other debtor's, the
    document this party's and owing, the amounts within what is owed and what is
    left — then each row is written and its document settled; applied_sen
    records what the settle moved. A customer's note knocks off on its table
    (setNoteKnockOff), never here. */
export async function applyCreditNote(
  sb: Db,
  p: { companyId: number; note: Row; targets: CreditTarget[]; actor: string | null },
): Promise<{ ok: true; applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }> } | { ok: false; refusal: ApplyRefusal }> {
  const { note } = p;
  const refuse = (status: number, error: string, message: string) => ({ ok: false as const, refusal: { status, error, message } });
  const party = partyOfNote(note);
  if (!party || party.owner === 'customer') return refuse(400, 'not_a_supplier_note', `${note.note_number} is not a supplier or other-debtor credit note — only those come off an invoice or a bill here.`);
  const w = words(party);
  if (note.status !== 'POSTED') return refuse(409, 'note_not_posted', `${note.note_number} is ${String(note.status).toLowerCase()} — post it first; the credit comes off a document once it is in the books.`);
  if (p.targets.length === 0) return refuse(400, 'targets_required', `Pick the ${w.doc} the credit comes off, and how much.`);
  const seen = new Set<string>();
  for (const t of p.targets) {
    if (!party.kinds.includes(t.kind) || !t.id) return refuse(400, 'bad_target', party.owner === 'debtor_id' ? 'Each line names a debtor bill.' : 'Each line names a purchase invoice or an AP invoice.');
    if (!Number.isInteger(t.amountSen) || t.amountSen <= 0) return refuse(400, 'bad_amount', 'Each amount is a positive sum in sen.');
    if (seen.has(t.id)) return refuse(400, 'bad_target', `An ${w.doc} is named twice — one line per ${w.doc}.`.replace('An bill', 'A bill'));
    seen.add(t.id);
  }
  const current = await noteAllocations(sb, p.companyId, note);
  if (!current.ok) return refuse(500, 'load_failed', current.reason);
  const asked = p.targets.reduce((s, t) => s + t.amountSen, 0);
  if (asked > current.leftSen) {
    return refuse(409, 'over_credit', `${note.note_number} has ${fmtSen(current.leftSen)} of credit left — ${fmtSen(asked)} is more.`);
  }
  const docs = new Map<string, OpenInvoice>();
  for (const t of p.targets) {
    const { data, error } = await sb.from(TABLE[t.kind].table).select(docSelect(t.kind))
      .eq('company_id', p.companyId).eq('id', t.id).maybeSingle();
    if (error) return refuse(500, 'load_failed', error.message);
    const raw = data as Row | null;
    if (!raw || String(raw[TABLE[t.kind].owner]) !== party.id) {
      return refuse(400, `invoice_not_this_${w.who}`, `That ${w.doc} is not one of this ${w.who}'s here — pick it again.`);
    }
    const doc = openView(t.kind, raw);
    if (!TABLE[t.kind].owing.has(doc.status)) {
      return refuse(409, 'invoice_not_owing', `${doc.number} is ${doc.status.toLowerCase()} — nothing is owed on it.`);
    }
    if (t.amountSen > doc.outstandingSen) return refuse(409, 'over_invoice', `${doc.number} has ${fmtSen(doc.outstandingSen)} owed — ${fmtSen(t.amountSen)} is more.`);
    docs.set(t.id, doc);
  }
  const applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }> = [];
  for (const t of p.targets) {
    const { data: row, error: insErr } = await sb.from('acc_credit_note_allocations').insert({
      company_id: p.companyId, note_id: note.id, [TABLE[t.kind].column]: t.id, amount_sen: t.amountSen, applied_sen: 0, created_by: p.actor,
    }).select('id').single();
    if (insErr || !row) return refuse(500, 'save_failed', insErr?.message ?? 'insert returned nothing');
    const moved = await settle(sb, t.kind, t.id, t.amountSen);
    if (!moved.ok) {
      await sb.from('acc_credit_note_allocations').delete().eq('company_id', p.companyId).eq('id', (row as Row).id);
      return refuse(500, 'settle_failed', `${docs.get(t.id)?.number ?? `The ${w.doc}`} could not take the credit: ${moved.reason ?? 'unknown'}`);
    }
    const { error: upErr } = await sb.from('acc_credit_note_allocations').update({ applied_sen: moved.appliedSen })
      .eq('company_id', p.companyId).eq('id', (row as Row).id);
    if (upErr) return refuse(500, 'save_failed', upErr.message);
    applied.push({ kind: t.kind, id: t.id, number: String(docs.get(t.id)?.number ?? ''), appliedSen: moved.appliedSen });
  }
  return { ok: true, applied };
}

/** One document's take from a note, moved: what the audit trail records. */
export type KnockOffMove = { kind: CreditTargetKind; id: string; fromSen: number; toSen: number };

const moveOfRow = (r: Row): KnockOffMove => {
  const kind = kindOfRow(r);
  return { kind, id: String(r[TABLE[kind].column]), fromSen: Number(r.applied_sen ?? 0), toSen: 0 };
};

/** What a note has applied right now, one entry per document — read before a
    cancel gives it all back, so the trail can say what was taken off what. */
export async function noteApplications(sb: Db, companyId: number, noteId: string): Promise<{ ok: true; moves: KnockOffMove[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select(ALLOCATION_COLS)
    .eq('company_id', companyId).eq('note_id', noteId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true, moves: ((data ?? []) as Row[]).filter((r) => Number(r.applied_sen ?? 0) > 0).map(moveOfRow) };
}

/** The numbers of the documents a set of moves touched, for the audit trail's
    labels. A miss leaves the id as the label rather than failing the write. */
export async function moveNumbers(sb: Db, companyId: number, moves: KnockOffMove[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const kind of [...new Set(moves.map((m) => m.kind))]) {
    const t = TABLE[kind];
    const { data } = await sb.from(t.table).select(`id, ${t.number}`).eq('company_id', companyId)
      .in('id', moves.filter((m) => m.kind === kind).map((m) => m.id));
    for (const d of (data ?? []) as Row[]) out.set(String(d.id), String(d[t.number] ?? d.id));
  }
  return out;
}

/** Give one application's credit back to the note: the document owes again
    exactly what was applied, and the row goes. */
export async function removeAllocation(sb: Db, p: { companyId: number; note: Row; allocationId: string }): Promise<{ ok: true; moved: KnockOffMove } | { ok: false; refusal: ApplyRefusal }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select(ALLOCATION_COLS)
    .eq('company_id', p.companyId).eq('note_id', p.note.id).eq('id', p.allocationId).maybeSingle();
  if (error) return { ok: false, refusal: { status: 500, error: 'load_failed', message: error.message } };
  if (!data) return { ok: false, refusal: { status: 404, error: 'not_found', message: 'That application is not on this note.' } };
  const r = data as Row;
  const back = await giveBack(sb, p.companyId, [r]);
  await refreshSiStatuses(sb, p.companyId, siIdsOf([r]));
  return back.ok ? { ok: true, moved: moveOfRow(r) } : back;
}

/** Every application of the note given back — before a cancel. A sales
    invoice's status is rolled again: it owes the credit again. */
export async function removeAllAllocations(sb: Db, p: { companyId: number; note: Row }): Promise<{ ok: true } | { ok: false; refusal: ApplyRefusal }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select(ALLOCATION_COLS)
    .eq('company_id', p.companyId).eq('note_id', p.note.id);
  if (error) return { ok: false, refusal: { status: 500, error: 'load_failed', message: error.message } };
  const rows = (data ?? []) as Row[];
  const back = await giveBack(sb, p.companyId, rows);
  await refreshSiStatuses(sb, p.companyId, siIdsOf(rows));
  return back;
}

const siIdsOf = (rows: Row[]): string[] => rows.filter((r) => kindOfRow(r) === 'SI').map((r) => String(r.sales_invoice_id));

async function giveBack(sb: Db, companyId: number, rows: Row[]): Promise<{ ok: true } | { ok: false; refusal: ApplyRefusal }> {
  for (const r of rows) {
    const kind = kindOfRow(r);
    const applied = Number(r.applied_sen ?? 0);
    if (applied > 0) {
      const moved = await settle(sb, kind, String(r[TABLE[kind].column]), -applied);
      if (!moved.ok) return { ok: false, refusal: { status: 500, error: 'settle_failed', message: `The ${kind === 'ODB' ? 'bill' : 'invoice'} could not take the credit back: ${moved.reason ?? 'unknown'}` } };
    }
    const { error } = await sb.from('acc_credit_note_allocations').delete().eq('company_id', companyId).eq('id', r.id);
    if (error) return { ok: false, refusal: { status: 500, error: 'save_failed', message: error.message } };
  }
  return { ok: true };
}

/* ── Knock off like an AP Payment (owner 2026-10-02: CN 的方式应该是类似 ap payment
   这样 knock off；扣错了就我 untick 会 knock off 的 invoice 就行了) ──────────────
   A note's knock-off is ONE picture — which of the party's documents it takes
   from, and how much — set whole, the way the AP Payment's Apply-to-PI table is.
   A DRAFT keeps it as a plan: rows with nothing applied yet, carried out by the
   post. A POSTED note's picture is carried out at once; for a document whose
   take changes, the old take is given back before the new one is taken, so every
   document holds one row and applied_sen stays what the settle really moved. */

export type KnockOffRow = {
  kind: CreditTargetKind; id: string; number: string; invoiceRef: string | null; invoiceDate: string | null;
  totalSen: number;
  /** What the document owes before THIS note — its outstanding, plus what this
      note already took off it. The most this note can take from it. */
  owedSen: number;
  /** What this note takes off it: applied once posted, planned while a draft. */
  noteSen: number;
  status: string;
};

type Take = { kind: CreditTargetKind; sen: number; rows: Row[] };

/** Per document, what this note takes off it — applied once posted, planned
    while a draft — and the rows that hold it. */
async function noteTakes(sb: Db, companyId: number, note: Row): Promise<{ ok: true; takes: Map<string, Take> } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select(ALLOCATION_COLS)
    .eq('company_id', companyId).eq('note_id', note.id);
  if (error) return { ok: false, reason: error.message };
  const posted = note.status === 'POSTED';
  const takes = new Map<string, Take>();
  for (const r of (data ?? []) as Row[]) {
    const kind = kindOfRow(r);
    const id = String(r[TABLE[kind].column]);
    const t = takes.get(id) ?? { kind, sen: 0, rows: [] };
    t.sen += Number((posted ? r.applied_sen : r.amount_sen) ?? 0);
    t.rows.push(r);
    takes.set(id, t);
  }
  return { ok: true, takes };
}

/** The knock-off table: the party's documents still owing, plus every document
    this note already takes from (one it took in full is PAID now, and still the
    note's to untick). A new note (no note yet) sees only the owing ones. */
export async function knockOffRows(sb: Db, companyId: number, p: { party: CreditParty; note: Row | null }): Promise<{ ok: true; rows: KnockOffRow[] } | { ok: false; reason: string }> {
  const open = await partyOpenDocs(sb, companyId, p.party);
  if (!open.ok) return open;
  const noted = p.note ? await noteTakes(sb, companyId, p.note) : { ok: true as const, takes: new Map<string, Take>() };
  if (!noted.ok) return noted;
  const applied = p.note?.status === 'POSTED';
  const rows = new Map<string, KnockOffRow>();
  for (const i of open.invoices) {
    const take = noted.takes.get(i.id)?.sen ?? 0;
    rows.set(i.id, {
      kind: i.kind, id: i.id, number: i.number, invoiceRef: i.invoiceRef, invoiceDate: i.invoiceDate, totalSen: i.totalSen,
      owedSen: i.outstandingSen + (applied ? take : 0), noteSen: take, status: i.status,
    });
  }
  for (const kind of p.party.kinds) {
    const ids = [...noted.takes.entries()].filter(([id, t]) => t.kind === kind && !rows.has(id)).map(([id]) => id);
    if (ids.length === 0) continue;
    if (kind === 'SI') {
      /* An invoice the note took in full (Paid now), or one that owes nothing
         more — still the note's to untick. */
      const sis = await sisOwing(sb, companyId, ids);
      if (!sis.ok) return sis;
      for (const s of sis.value.values()) {
        const take = noted.takes.get(s.id)?.sen ?? 0;
        rows.set(s.id, {
          kind, id: s.id, number: s.number, invoiceRef: s.soDocNo, invoiceDate: s.date,
          totalSen: s.totalSen, owedSen: s.owedSen + (applied ? take : 0), noteSen: take, status: s.status,
        });
      }
      continue;
    }
    const { data, error } = await sb.from(TABLE[kind].table).select(docSelect(kind))
      .eq('company_id', companyId).in('id', ids);
    if (error) return { ok: false, reason: error.message };
    for (const r of (data ?? []) as Row[]) {
      const v = openView(kind, r);
      const take = noted.takes.get(v.id)?.sen ?? 0;
      rows.set(v.id, {
        kind, id: v.id, number: v.number, invoiceRef: v.invoiceRef, invoiceDate: v.invoiceDate,
        totalSen: v.totalSen, owedSen: Math.max(0, v.outstandingSen) + (applied ? take : 0), noteSen: take, status: v.status,
      });
    }
  }
  const out = [...rows.values()];
  out.sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')) || a.number.localeCompare(b.number));
  return { ok: true, rows: out };
}

/** The targets as the server takes them — each a purchase or AP invoice, a
    debtor bill or a sales invoice, a positive sum in sen, one line per document. */
export function parseTargets(raw: unknown): CreditTarget[] {
  return (Array.isArray(raw) ? raw : []).map((t: any) => ({
    kind: String(t?.kind ?? '').toUpperCase() as CreditTargetKind, id: String(t?.id ?? '').trim(), amountSen: Number(t?.amountSen),
  }));
}

/** Every target checked before anything is written: each document this
    party's own and posted, each take within what the document owes before
    this note, the whole within the note's total. `current` is what the note
    takes now (a posted note's applied, given back before the new take). */
export async function checkKnockOff(
  sb: Db,
  p: { companyId: number; label: string; party: CreditParty; totalSen: number; posted: boolean; targets: CreditTarget[]; current: Map<string, Take> },
): Promise<{ ok: true; numbers: Map<string, string> } | { ok: false; refusal: ApplyRefusal }> {
  const refuse = (status: number, error: string, message: string) => ({ ok: false as const, refusal: { status, error, message } });
  const w = words(p.party);
  const seen = new Set<string>();
  for (const t of p.targets) {
    if (!p.party.kinds.includes(t.kind) || !t.id) {
      return refuse(400, 'bad_target', p.party.owner === 'debtor_id' ? 'Each line names a debtor bill.'
        : p.party.owner === 'customer' ? 'Each line names a sales invoice of the customer.' : 'Each line names a purchase invoice or an AP invoice.');
    }
    if (!Number.isInteger(t.amountSen) || t.amountSen <= 0) return refuse(400, 'bad_amount', 'Each amount is a positive sum in sen.');
    if (seen.has(t.id)) return refuse(400, 'bad_target', p.party.owner === 'debtor_id' ? 'A bill is named twice — one line per bill.' : 'An invoice is named twice — one line per invoice.');
    seen.add(t.id);
  }
  const asked = p.targets.reduce((s, t) => s + t.amountSen, 0);
  if (asked > p.totalSen) {
    return refuse(409, 'over_credit', `${p.label} is ${fmtSen(p.totalSen)} — knocking off ${fmtSen(asked)} is more.`);
  }
  const numbers = new Map<string, string>();
  if (p.party.owner === 'customer') {
    /* A sales invoice owes its total less its receipts, its order's deposit and
       every credit note knocked off it — this note's own take counted back in. */
    const sis = await sisOwing(sb, p.companyId, p.targets.map((t) => t.id));
    if (!sis.ok) return refuse(500, 'load_failed', sis.reason);
    for (const t of p.targets) {
      const s = sis.value.get(t.id);
      if (!s || !sameCustomer(p.party.customer ?? { code: null, name: null }, s.customer)) {
        return refuse(400, 'invoice_not_this_customer', "That invoice is not one of this customer's here — pick it again.");
      }
      if (!absorbsOrderDeposit(s.status)) return refuse(409, 'invoice_not_owing', `${s.number} is ${s.status.toLowerCase()} — nothing is owed on it.`);
      const owed = s.owedSen + (p.posted ? (p.current.get(t.id)?.sen ?? 0) : 0);
      if (t.amountSen > owed) return refuse(409, 'over_invoice', `${s.number} only has ${fmtSen(owed)} outstanding.`);
      numbers.set(t.id, s.number);
    }
    return { ok: true, numbers };
  }
  for (const t of p.targets) {
    const { data, error } = await sb.from(TABLE[t.kind].table).select(docSelect(t.kind))
      .eq('company_id', p.companyId).eq('id', t.id).maybeSingle();
    if (error) return refuse(500, 'load_failed', error.message);
    const raw = data as Row | null;
    if (!raw || String(raw[TABLE[t.kind].owner]) !== String(p.party.id)) {
      return refuse(400, `invoice_not_this_${w.who}`, `That ${w.doc} is not one of this ${w.who}'s here — pick it again.`);
    }
    const doc = openView(t.kind, raw);
    const mine = p.posted ? (p.current.get(t.id)?.sen ?? 0) : 0;
    /* Owing, or PAID by this very note — the one a posted note may still keep. */
    if (!TABLE[t.kind].owing.has(doc.status) && !(mine > 0 && doc.status === 'PAID')) {
      return refuse(409, 'invoice_not_owing', `${doc.number} is ${doc.status.toLowerCase()} — nothing is owed on it.`);
    }
    const owed = Math.max(0, doc.outstandingSen) + mine;
    if (t.amountSen > owed) return refuse(409, 'over_invoice', `${doc.number} owes ${fmtSen(owed)} — ${fmtSen(t.amountSen)} is more.`);
    numbers.set(t.id, doc.number);
  }
  return { ok: true, numbers };
}

/** A customer note that answers a deposit invoice (credit-note-si.ts
    depositPapers) knocks off nothing — said in its own words. */
export async function depositPaperBlock(sb: Db, companyId: number, note: Row): Promise<{ ok: true; refusal: ApplyRefusal | null } | { ok: false; reason: string }> {
  if (note.kind !== 'CN') return { ok: true, refusal: null };
  const papers = await depositPapers(sb, companyId, [note]);
  if (!papers.ok) return papers;
  const paper = papers.value.get(String(note.id));
  return { ok: true, refusal: paper ? { status: 409, error: 'deposit_note', message: depositPaperRefusal(String(note.note_number), paper) } : null };
}

/** A draft's plan written whole: the rows it had go, the targets come in with
    nothing applied. */
export async function writePlan(sb: Db, p: { companyId: number; noteId: string; targets: CreditTarget[]; actor: string | null }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error: delErr } = await sb.from('acc_credit_note_allocations').delete().eq('company_id', p.companyId).eq('note_id', p.noteId);
  if (delErr) return { ok: false, reason: delErr.message };
  if (p.targets.length === 0) return { ok: true };
  const { error } = await sb.from('acc_credit_note_allocations').insert(p.targets.map((t) => ({
    company_id: p.companyId, note_id: p.noteId, [TABLE[t.kind].column]: t.id, amount_sen: t.amountSen, applied_sen: 0, created_by: p.actor,
  })));
  return error ? { ok: false, reason: error.message } : { ok: true };
}

export type KnockOffShort = { number: string; askedSen: number; appliedSen: number };

/** PUT /:id/allocations — the note's knock-off set whole. A draft's plan is
    replaced; a posted note's is carried out: decreases first (they free
    credit), each changed document's old take given back before its new one is
    taken. `short` names a document that took less than asked (paid meanwhile). */
export async function setNoteKnockOff(
  sb: Db,
  p: { companyId: number; note: Row; targets: CreditTarget[]; actor: string | null },
): Promise<{ ok: true; short: KnockOffShort[]; moved: KnockOffMove[] } | { ok: false; refusal: ApplyRefusal; moved?: KnockOffMove[] }> {
  const { note } = p;
  const party = partyOfNote(note);
  if (!party) return { ok: false, refusal: { status: 400, error: 'not_a_supplier_note', message: `${note.note_number} is a debit note — only a credit note knocks off an invoice or a bill.` } };
  if (note.status === 'CANCELLED') return { ok: false, refusal: { status: 409, error: 'note_cancelled', message: `${note.note_number} is cancelled — it knocks nothing off.` } };
  const paper = await depositPaperBlock(sb, p.companyId, note);
  if (!paper.ok) return { ok: false, refusal: { status: 500, error: 'load_failed', message: paper.reason } };
  if (paper.refusal) return { ok: false, refusal: paper.refusal };
  const noted = await noteTakes(sb, p.companyId, note);
  if (!noted.ok) return { ok: false, refusal: { status: 500, error: 'load_failed', message: noted.reason } };
  const posted = note.status === 'POSTED';
  const checked = await checkKnockOff(sb, {
    companyId: p.companyId, label: String(note.note_number), party, totalSen: Number(note.total_sen ?? 0),
    posted, targets: p.targets, current: noted.takes,
  });
  if (!checked.ok) return checked;
  if (!posted) {
    const written = await writePlan(sb, { companyId: p.companyId, noteId: String(note.id), targets: p.targets, actor: p.actor });
    return written.ok ? { ok: true, short: [], moved: [] } : { ok: false, refusal: { status: 500, error: 'save_failed', message: written.reason } };
  }

  const want = new Map(p.targets.map((t) => [t.id, t]));
  const changes: Array<{ id: string; kind: CreditTargetKind; from: number; to: number; rows: Row[] }> = [];
  for (const id of new Set([...noted.takes.keys(), ...want.keys()])) {
    const cur = noted.takes.get(id);
    const kind = want.get(id)?.kind ?? cur?.kind;
    if (!kind) continue;
    const to = want.get(id)?.amountSen ?? 0;
    const from = cur?.sen ?? 0;
    const rowsNow = cur?.rows.length ?? 0;
    /* Unchanged is one row already holding it; a leftover row holding nothing
       (a post cut short) is cleared like any other change. */
    if ((to === from && to > 0 && rowsNow === 1) || (to === 0 && rowsNow === 0)) continue;
    changes.push({ id, kind, from, to, rows: cur?.rows ?? [] });
  }
  changes.sort((a, b) => (a.to - a.from) - (b.to - b.from));
  const short: KnockOffShort[] = [];
  /* What really moved, refusals included: a refusal part-way leaves the earlier
     documents changed, and the trail must say so. */
  const done: KnockOffMove[] = [];
  const doc = (kind: CreditTargetKind) => (kind === 'ODB' ? 'The bill' : 'The invoice');
  try {
    for (const ch of changes) {
      const back = await giveBack(sb, p.companyId, ch.rows);
      if (!back.ok) return { ...back, moved: done };
      const given = { kind: ch.kind, id: ch.id, fromSen: ch.rows.reduce((s, r) => s + Number(r.applied_sen ?? 0), 0), toSen: 0 };
      if (ch.to <= 0) { done.push(given); continue; }
      const { data: row, error: insErr } = await sb.from('acc_credit_note_allocations').insert({
        company_id: p.companyId, note_id: note.id, [TABLE[ch.kind].column]: ch.id, amount_sen: ch.to, applied_sen: 0, created_by: p.actor,
      }).select('id').single();
      if (insErr || !row) { done.push(given); return { ok: false, refusal: { status: 500, error: 'save_failed', message: insErr?.message ?? 'insert returned nothing' }, moved: done }; }
      const moved = await settle(sb, ch.kind, ch.id, ch.to);
      const number = checked.numbers.get(ch.id) ?? doc(ch.kind);
      if (!moved.ok || moved.appliedSen <= 0) {
        await sb.from('acc_credit_note_allocations').delete().eq('company_id', p.companyId).eq('id', (row as Row).id);
        done.push(given);
        if (!moved.ok) return { ok: false, refusal: { status: 500, error: 'settle_failed', message: `${number} could not take the credit: ${moved.reason ?? 'unknown'}` }, moved: done };
        short.push({ number, askedSen: ch.to, appliedSen: 0 });
        continue;
      }
      done.push({ ...given, toSen: moved.appliedSen });
      const { error: upErr } = await sb.from('acc_credit_note_allocations').update({ applied_sen: moved.appliedSen })
        .eq('company_id', p.companyId).eq('id', (row as Row).id);
      if (upErr) return { ok: false, refusal: { status: 500, error: 'save_failed', message: upErr.message }, moved: done };
      if (moved.appliedSen < ch.to) short.push({ number, askedSen: ch.to, appliedSen: moved.appliedSen });
    }
  } finally {
    /* A sales invoice's status follows what is knocked off it — whatever got written. */
    await refreshSiStatuses(sb, p.companyId, changes.filter((ch) => ch.kind === 'SI').map((ch) => ch.id));
  }
  return { ok: true, short, moved: done };
}

/** At post — the DRAFT → POSTED moment — the plan is carried out. A document
    that owes less now than planned takes what it owes; one that owes nothing
    (paid or cancelled since) takes none, and its row goes. The post stands
    either way; `notApplied` says what stayed with the supplier, the debtor or,
    on a customer's note, as credit on the customer. */
export async function carryOutPlan(sb: Db, p: { companyId: number; note: Row }): Promise<
  { ok: true; applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }>; notApplied: string[] } | { ok: false; reason: string }
> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select(ALLOCATION_COLS)
    .eq('company_id', p.companyId).eq('note_id', p.note.id).order('created_at');
  if (error) return { ok: false, reason: error.message };
  const applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }> = [];
  const notApplied: string[] = [];
  const stays = staysWith(p.note.kind);
  const touched: string[] = [];
  try {
    for (const r of ((data ?? []) as Row[]).filter((x) => Number(x.applied_sen ?? 0) === 0)) {
      const kind = kindOfRow(r);
      const id = String(r[TABLE[kind].column]);
      const asked = Number(r.amount_sen ?? 0);
      const drop = async () => { await sb.from('acc_credit_note_allocations').delete().eq('company_id', p.companyId).eq('id', r.id); };
      let number: string;
      let take: number;
      if (kind === 'SI') {
        /* What it owes NOW — read one by one, as each knock-off just written
           moves its order's deposit off the next invoice. */
        touched.push(id);
        const sis = await sisOwing(sb, p.companyId, [id]);
        const s = sis.ok ? sis.value.get(id) : undefined;
        number = s?.number ?? 'The invoice';
        if (!s || !absorbsOrderDeposit(s.status) || s.owedSen <= 0) {
          await drop();
          notApplied.push(`${number} owes nothing now — its ${fmtSen(asked)} ${stays}.`);
          continue;
        }
        take = Math.min(asked, s.owedSen);
      } else {
        const { data: d, error: dErr } = await sb.from(TABLE[kind].table).select(`${TABLE[kind].number}, status`).eq('company_id', p.companyId).eq('id', id).maybeSingle();
        number = String((d as Row | null)?.[TABLE[kind].number] ?? (kind === 'ODB' ? 'The bill' : 'The invoice'));
        if (dErr || !d || !TABLE[kind].owing.has(String((d as Row).status))) {
          await drop();
          notApplied.push(`${number} owes nothing now — its ${fmtSen(asked)} ${stays}.`);
          continue;
        }
        take = asked;
      }
      const moved = await settle(sb, kind, id, take);
      if (!moved.ok || moved.appliedSen <= 0) {
        await drop();
        notApplied.push(`${number} could not take the credit${moved.ok ? '' : `: ${moved.reason ?? 'unknown'}`} — its ${fmtSen(asked)} ${stays}.`);
        continue;
      }
      const { error: upErr } = await sb.from('acc_credit_note_allocations').update({ applied_sen: moved.appliedSen }).eq('company_id', p.companyId).eq('id', r.id);
      if (upErr) return { ok: false, reason: upErr.message };
      if (moved.appliedSen < asked) notApplied.push(`${number} owed only ${fmtSen(moved.appliedSen)} — ${fmtSen(asked - moved.appliedSen)} ${stays}.`);
      applied.push({ kind, id, number, appliedSen: moved.appliedSen });
    }
  } finally {
    await refreshSiStatuses(sb, p.companyId, touched);
  }
  return { ok: true, applied, notApplied };
}
