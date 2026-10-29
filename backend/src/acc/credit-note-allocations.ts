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
// ----------------------------------------------------------------------------

import { settlePiPaidSen } from '../scm/lib/pi-settlement';
import { settleApInvoicePaidSen } from '../scm/lib/ap-invoice-settlement';
import { settleDebtorBillReceivedSen } from '../scm/lib/debtor-bill-settlement';
import { fmtSen } from '../scm/shared/format';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

export type CreditTargetKind = 'PI' | 'API' | 'ODB';
export type CreditTarget = { kind: CreditTargetKind; id: string; amountSen: number };

/* Each document a credit comes off, by the columns its own table names it with. */
type DocTable = {
  table: string; column: 'purchase_invoice_id' | 'ap_invoice_id' | 'debtor_bill_id';
  owner: 'supplier_id' | 'debtor_id'; number: string; paid: 'paid_sen' | 'received_sen'; ref: string | null; date: string;
  /** The statuses that still owe. */
  owing: ReadonlySet<string>;
};
const SUPPLIER_OWING: ReadonlySet<string> = new Set(['POSTED', 'PARTIALLY_PAID']);
const TABLE: Record<CreditTargetKind, DocTable> = {
  PI: { table: 'purchase_invoices', column: 'purchase_invoice_id', owner: 'supplier_id', number: 'invoice_number', paid: 'paid_sen', ref: 'supplier_invoice_ref', date: 'invoice_date', owing: SUPPLIER_OWING },
  API: { table: 'ap_invoices', column: 'ap_invoice_id', owner: 'supplier_id', number: 'invoice_number', paid: 'paid_sen', ref: 'supplier_invoice_ref', date: 'invoice_date', owing: SUPPLIER_OWING },
  /* A debtor bill is POSTED until it is received in full (PAID). */
  ODB: { table: 'acc_debtor_bills', column: 'debtor_bill_id', owner: 'debtor_id', number: 'bill_number', paid: 'received_sen', ref: null, date: 'bill_date', owing: new Set(['POSTED']) },
};
const ALLOCATION_COLS = 'id, purchase_invoice_id, ap_invoice_id, debtor_bill_id, amount_sen, applied_sen';
const kindOfRow = (r: Row): CreditTargetKind => (r.purchase_invoice_id ? 'PI' : r.ap_invoice_id ? 'API' : 'ODB');
const docSelect = (kind: CreditTargetKind): string => {
  const t = TABLE[kind];
  return ['id', t.number, t.owner, t.ref, t.date, 'total_sen', t.paid, 'status'].filter(Boolean).join(', ');
};

const settle = (sb: Db, kind: CreditTargetKind, id: string, delta: number) =>
  kind === 'PI' ? settlePiPaidSen(sb, id, delta) : kind === 'API' ? settleApInvoicePaidSen(sb, id, delta) : settleDebtorBillReceivedSen(sb, id, delta);

/** Whose documents a credit comes off: a supplier note's supplier (purchase and
    AP invoices), an other-debtor note's debtor (debtor bills). */
export type CreditParty = { owner: 'supplier_id' | 'debtor_id'; id: string; kinds: readonly CreditTargetKind[] };
export const supplierParty = (supplierId: string): CreditParty => ({ owner: 'supplier_id', id: supplierId, kinds: ['PI', 'API'] });
export const debtorParty = (debtorId: string): CreditParty => ({ owner: 'debtor_id', id: debtorId, kinds: ['ODB'] });
/** The party a stored note knocks off for — none for a customer note. */
export const partyOfNote = (note: Row): CreditParty | null =>
  note.kind === 'SCN' && note.supplier_id ? supplierParty(String(note.supplier_id))
    : note.kind === 'OCN' && note.debtor_id ? debtorParty(String(note.debtor_id))
      : null;
const words = (party: CreditParty) => (party.owner === 'debtor_id'
  ? { who: 'debtor', doc: 'bill' }
  : { who: 'supplier', doc: 'invoice' });

export type AllocationView = {
  id: string; kind: CreditTargetKind; docId: string; number: string | null;
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
  const numbers = new Map<string, string>();
  for (const kind of ['PI', 'API', 'ODB'] as const) {
    const ids = [...new Set(rows.filter((r) => kindOfRow(r) === kind).map((r) => r[TABLE[kind].column]).filter(Boolean).map(String))];
    if (ids.length === 0) continue;
    const { data: docs, error: dErr } = await sb.from(TABLE[kind].table).select(`id, ${TABLE[kind].number}`).eq('company_id', companyId).in('id', ids);
    if (dErr) return { ok: false, reason: dErr.message };
    for (const d of (docs ?? []) as Row[]) numbers.set(String(d.id), String(d[TABLE[kind].number]));
  }
  const allocations: AllocationView[] = rows.map((r) => {
    const kind = kindOfRow(r);
    const docId = String(r[TABLE[kind].column]);
    return {
      id: String(r.id), kind, docId, number: numbers.get(docId) ?? null,
      amountSen: Number(r.amount_sen ?? 0), appliedSen: Number(r.applied_sen ?? 0),
      createdAt: r.created_at ?? null, createdBy: r.created_by ?? null,
    };
  });
  const appliedSen = allocations.reduce((s, a) => s + a.appliedSen, 0);
  return { ok: true, allocations, appliedSen, leftSen: Math.max(0, Number(note.total_sen ?? 0) - appliedSen) };
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
    records what the settle moved. */
export async function applyCreditNote(
  sb: Db,
  p: { companyId: number; note: Row; targets: CreditTarget[]; actor: string | null },
): Promise<{ ok: true; applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }> } | { ok: false; refusal: ApplyRefusal }> {
  const { note } = p;
  const refuse = (status: number, error: string, message: string) => ({ ok: false as const, refusal: { status, error, message } });
  const party = partyOfNote(note);
  if (!party) return refuse(400, 'not_a_supplier_note', `${note.note_number} is not a supplier or other-debtor credit note — only those come off an invoice or a bill.`);
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

/** Give one application's credit back to the note: the document owes again
    exactly what was applied, and the row goes. */
export async function removeAllocation(sb: Db, p: { companyId: number; note: Row; allocationId: string }): Promise<{ ok: true } | { ok: false; refusal: ApplyRefusal }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select(ALLOCATION_COLS)
    .eq('company_id', p.companyId).eq('note_id', p.note.id).eq('id', p.allocationId).maybeSingle();
  if (error) return { ok: false, refusal: { status: 500, error: 'load_failed', message: error.message } };
  if (!data) return { ok: false, refusal: { status: 404, error: 'not_found', message: 'That application is not on this note.' } };
  const r = data as Row;
  return giveBack(sb, p.companyId, [r]);
}

/** Every application of the note given back — before a cancel. */
export async function removeAllAllocations(sb: Db, p: { companyId: number; note: Row }): Promise<{ ok: true } | { ok: false; refusal: ApplyRefusal }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select(ALLOCATION_COLS)
    .eq('company_id', p.companyId).eq('note_id', p.note.id);
  if (error) return { ok: false, refusal: { status: 500, error: 'load_failed', message: error.message } };
  return giveBack(sb, p.companyId, (data ?? []) as Row[]);
}

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

/** The targets as the server takes them — each a purchase or AP invoice or a
    debtor bill, a positive sum in sen, one line per document. */
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
    if (!p.party.kinds.includes(t.kind) || !t.id) return refuse(400, 'bad_target', p.party.owner === 'debtor_id' ? 'Each line names a debtor bill.' : 'Each line names a purchase invoice or an AP invoice.');
    if (!Number.isInteger(t.amountSen) || t.amountSen <= 0) return refuse(400, 'bad_amount', 'Each amount is a positive sum in sen.');
    if (seen.has(t.id)) return refuse(400, 'bad_target', p.party.owner === 'debtor_id' ? 'A bill is named twice — one line per bill.' : 'An invoice is named twice — one line per invoice.');
    seen.add(t.id);
  }
  const asked = p.targets.reduce((s, t) => s + t.amountSen, 0);
  if (asked > p.totalSen) {
    return refuse(409, 'over_credit', `${p.label} is ${fmtSen(p.totalSen)} — knocking off ${fmtSen(asked)} is more.`);
  }
  const numbers = new Map<string, string>();
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
): Promise<{ ok: true; short: KnockOffShort[] } | { ok: false; refusal: ApplyRefusal }> {
  const { note } = p;
  const party = partyOfNote(note);
  if (!party) return { ok: false, refusal: { status: 400, error: 'not_a_supplier_note', message: `${note.note_number} is not a supplier or other-debtor credit note — only those knock off an invoice or a bill.` } };
  if (note.status === 'CANCELLED') return { ok: false, refusal: { status: 409, error: 'note_cancelled', message: `${note.note_number} is cancelled — it knocks nothing off.` } };
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
    return written.ok ? { ok: true, short: [] } : { ok: false, refusal: { status: 500, error: 'save_failed', message: written.reason } };
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
  for (const ch of changes) {
    const back = await giveBack(sb, p.companyId, ch.rows);
    if (!back.ok) return back;
    if (ch.to <= 0) continue;
    const { data: row, error: insErr } = await sb.from('acc_credit_note_allocations').insert({
      company_id: p.companyId, note_id: note.id, [TABLE[ch.kind].column]: ch.id, amount_sen: ch.to, applied_sen: 0, created_by: p.actor,
    }).select('id').single();
    if (insErr || !row) return { ok: false, refusal: { status: 500, error: 'save_failed', message: insErr?.message ?? 'insert returned nothing' } };
    const moved = await settle(sb, ch.kind, ch.id, ch.to);
    const number = checked.numbers.get(ch.id) ?? (ch.kind === 'ODB' ? 'The bill' : 'The invoice');
    if (!moved.ok || moved.appliedSen <= 0) {
      await sb.from('acc_credit_note_allocations').delete().eq('company_id', p.companyId).eq('id', (row as Row).id);
      if (!moved.ok) return { ok: false, refusal: { status: 500, error: 'settle_failed', message: `${number} could not take the credit: ${moved.reason ?? 'unknown'}` } };
      short.push({ number, askedSen: ch.to, appliedSen: 0 });
      continue;
    }
    const { error: upErr } = await sb.from('acc_credit_note_allocations').update({ applied_sen: moved.appliedSen })
      .eq('company_id', p.companyId).eq('id', (row as Row).id);
    if (upErr) return { ok: false, refusal: { status: 500, error: 'save_failed', message: upErr.message } };
    if (moved.appliedSen < ch.to) short.push({ number, askedSen: ch.to, appliedSen: moved.appliedSen });
  }
  return { ok: true, short };
}

/** At post — the DRAFT → POSTED moment — the plan is carried out. A document
    that owes less now than planned takes what it owes; one that owes nothing
    (paid or cancelled since) takes none, and its row goes. The post stands
    either way; `notApplied` says what stayed with the supplier or the debtor. */
export async function carryOutPlan(sb: Db, p: { companyId: number; note: Row }): Promise<
  { ok: true; applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }>; notApplied: string[] } | { ok: false; reason: string }
> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select(ALLOCATION_COLS)
    .eq('company_id', p.companyId).eq('note_id', p.note.id).order('created_at');
  if (error) return { ok: false, reason: error.message };
  const applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }> = [];
  const notApplied: string[] = [];
  const holder = p.note.kind === 'OCN' ? 'the debtor' : 'the supplier';
  for (const r of ((data ?? []) as Row[]).filter((x) => Number(x.applied_sen ?? 0) === 0)) {
    const kind = kindOfRow(r);
    const id = String(r[TABLE[kind].column]);
    const asked = Number(r.amount_sen ?? 0);
    const drop = async () => { await sb.from('acc_credit_note_allocations').delete().eq('company_id', p.companyId).eq('id', r.id); };
    const { data: doc, error: dErr } = await sb.from(TABLE[kind].table).select(`${TABLE[kind].number}, status`).eq('company_id', p.companyId).eq('id', id).maybeSingle();
    const number = String((doc as Row | null)?.[TABLE[kind].number] ?? (kind === 'ODB' ? 'The bill' : 'The invoice'));
    if (dErr || !doc || !TABLE[kind].owing.has(String((doc as Row).status))) {
      await drop();
      notApplied.push(`${number} owes nothing now — its ${fmtSen(asked)} stays with ${holder}.`);
      continue;
    }
    const moved = await settle(sb, kind, id, asked);
    if (!moved.ok || moved.appliedSen <= 0) {
      await drop();
      notApplied.push(`${number} could not take the credit${moved.ok ? '' : `: ${moved.reason ?? 'unknown'}`} — its ${fmtSen(asked)} stays with ${holder}.`);
      continue;
    }
    const { error: upErr } = await sb.from('acc_credit_note_allocations').update({ applied_sen: moved.appliedSen }).eq('company_id', p.companyId).eq('id', r.id);
    if (upErr) return { ok: false, reason: upErr.message };
    if (moved.appliedSen < asked) notApplied.push(`${number} owed only ${fmtSen(moved.appliedSen)} — ${fmtSen(asked - moved.appliedSen)} stays with ${holder}.`);
    applied.push({ kind, id, number, appliedSen: moved.appliedSen });
  }
  return { ok: true, applied, notApplied };
}
