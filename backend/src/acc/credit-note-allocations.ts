// ----------------------------------------------------------------------------
// credit-note-allocations — a supplier credit note's credit coming off the
// supplier's invoices (owner 2026-10-01, Supplier CN part 2: 有写发票的 CN 直接扣
// 那张发票的欠款；没写的先挂在 Diglant 名下，再选要扣哪几张发票；付款时只付剩下的).
//
// The way a payment voucher's money comes off them (scm.pv_allocations): one row
// per invoice credited (scm.acc_credit_note_allocations, 20261002T0100), the
// invoice's paid_sen moved through the SAME settle functions an AP Payment uses
// (scm/lib/pi-settlement.ts, ap-invoice-settlement.ts — row lock, clamp at write
// time), and applied_sen recording what was actually moved, so a remove or a
// cancel gives back exactly that. The ledger is not touched: the note's own
// journal (Dr AP control / Cr its lines) already carries the money; this is the
// invoice's side of it. An AP Payment then pays what is left.
// ----------------------------------------------------------------------------

import { settlePiPaidSen } from '../scm/lib/pi-settlement';
import { settleApInvoicePaidSen } from '../scm/lib/ap-invoice-settlement';
import { fmtSen } from '../scm/shared/format';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;
type Row = Record<string, any>;

export type CreditTargetKind = 'PI' | 'API';
export type CreditTarget = { kind: CreditTargetKind; id: string; amountSen: number };

const TABLE: Record<CreditTargetKind, { table: string; column: 'purchase_invoice_id' | 'ap_invoice_id' }> = {
  PI: { table: 'purchase_invoices', column: 'purchase_invoice_id' },
  API: { table: 'ap_invoices', column: 'ap_invoice_id' },
};

const settle = (sb: Db, kind: CreditTargetKind, id: string, delta: number) =>
  kind === 'PI' ? settlePiPaidSen(sb, id, delta) : settleApInvoicePaidSen(sb, id, delta);

export type AllocationView = {
  id: string; kind: CreditTargetKind; docId: string; number: string | null;
  amountSen: number; appliedSen: number; createdAt: string | null; createdBy: string | null;
};

/** The note's applications, each with its invoice's number, and the credit left. */
export async function noteAllocations(sb: Db, companyId: number, note: Row): Promise<
  { ok: true; allocations: AllocationView[]; appliedSen: number; leftSen: number } | { ok: false; reason: string }
> {
  const { data, error } = await sb.from('acc_credit_note_allocations')
    .select('id, purchase_invoice_id, ap_invoice_id, amount_sen, applied_sen, created_at, created_by')
    .eq('company_id', companyId).eq('note_id', note.id).order('created_at');
  if (error) return { ok: false, reason: error.message };
  const rows = (data ?? []) as Row[];
  const numbers = new Map<string, string>();
  for (const kind of ['PI', 'API'] as const) {
    const ids = [...new Set(rows.map((r) => r[TABLE[kind].column]).filter(Boolean).map(String))];
    if (ids.length === 0) continue;
    const { data: docs, error: dErr } = await sb.from(TABLE[kind].table).select('id, invoice_number').eq('company_id', companyId).in('id', ids);
    if (dErr) return { ok: false, reason: dErr.message };
    for (const d of (docs ?? []) as Row[]) numbers.set(String(d.id), String(d.invoice_number));
  }
  const allocations: AllocationView[] = rows.map((r) => {
    const kind: CreditTargetKind = r.purchase_invoice_id ? 'PI' : 'API';
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

/** The supplier's invoices with money still owed — what a credit can come off. */
export async function supplierOpenInvoices(sb: Db, companyId: number, supplierId: string): Promise<{ ok: true; invoices: OpenInvoice[] } | { ok: false; reason: string }> {
  const out: OpenInvoice[] = [];
  for (const kind of ['PI', 'API'] as const) {
    const { data, error } = await sb.from(TABLE[kind].table)
      .select('id, invoice_number, supplier_invoice_ref, invoice_date, total_sen, paid_sen, status')
      .eq('company_id', companyId).eq('supplier_id', supplierId).in('status', ['POSTED', 'PARTIALLY_PAID']);
    if (error) return { ok: false, reason: error.message };
    for (const r of (data ?? []) as Row[]) {
      const outstanding = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
      if (outstanding <= 0) continue;
      out.push({
        kind, id: String(r.id), number: String(r.invoice_number), invoiceRef: r.supplier_invoice_ref ?? null, invoiceDate: r.invoice_date ?? null,
        totalSen: Number(r.total_sen ?? 0), paidSen: Number(r.paid_sen ?? 0), outstandingSen: outstanding, status: String(r.status),
      });
    }
  }
  out.sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')) || a.number.localeCompare(b.number));
  return { ok: true, invoices: out };
}

export type ApplyRefusal = { status: number; error: string; message: string };

/** Take the credit off the named invoices. Every target is checked before any
    is written — the note posted and a supplier's, the invoice this supplier's and
    owing, the amounts within what is owed and what is left — then each row is
    written and its invoice settled; applied_sen records what the settle moved. */
export async function applyCreditNote(
  sb: Db,
  p: { companyId: number; note: Row; targets: CreditTarget[]; actor: string | null },
): Promise<{ ok: true; applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }> } | { ok: false; refusal: ApplyRefusal }> {
  const { note } = p;
  const refuse = (status: number, error: string, message: string) => ({ ok: false as const, refusal: { status, error, message } });
  if (note.kind !== 'SCN') return refuse(400, 'not_a_supplier_note', `${note.note_number} is not a supplier credit note — only those come off a supplier's invoice.`);
  if (note.status !== 'POSTED') return refuse(409, 'note_not_posted', `${note.note_number} is ${String(note.status).toLowerCase()} — post it first; the credit comes off an invoice once it is in the books.`);
  if (p.targets.length === 0) return refuse(400, 'targets_required', 'Pick the invoice the credit comes off, and how much.');
  const seen = new Set<string>();
  for (const t of p.targets) {
    if ((t.kind !== 'PI' && t.kind !== 'API') || !t.id) return refuse(400, 'bad_target', 'Each line names a purchase invoice or an AP invoice.');
    if (!Number.isInteger(t.amountSen) || t.amountSen <= 0) return refuse(400, 'bad_amount', 'Each amount is a positive sum in sen.');
    if (seen.has(t.id)) return refuse(400, 'bad_target', 'An invoice is named twice — one line per invoice.');
    seen.add(t.id);
  }
  const current = await noteAllocations(sb, p.companyId, note);
  if (!current.ok) return refuse(500, 'load_failed', current.reason);
  const asked = p.targets.reduce((s, t) => s + t.amountSen, 0);
  if (asked > current.leftSen) {
    return refuse(409, 'over_credit', `${note.note_number} has ${fmtSen(current.leftSen)} of credit left — ${fmtSen(asked)} is more.`);
  }
  const docs = new Map<string, Row>();
  for (const t of p.targets) {
    const { data, error } = await sb.from(TABLE[t.kind].table).select('id, invoice_number, supplier_id, total_sen, paid_sen, status')
      .eq('company_id', p.companyId).eq('id', t.id).maybeSingle();
    if (error) return refuse(500, 'load_failed', error.message);
    const doc = data as Row | null;
    if (!doc || String(doc.supplier_id) !== String(note.supplier_id)) {
      return refuse(400, 'invoice_not_this_supplier', 'That invoice is not one of this supplier\'s here — pick it again.');
    }
    if (doc.status !== 'POSTED' && doc.status !== 'PARTIALLY_PAID') {
      return refuse(409, 'invoice_not_owing', `${doc.invoice_number} is ${String(doc.status).toLowerCase()} — nothing is owed on it.`);
    }
    const owed = Number(doc.total_sen ?? 0) - Number(doc.paid_sen ?? 0);
    if (t.amountSen > owed) return refuse(409, 'over_invoice', `${doc.invoice_number} has ${fmtSen(owed)} owed — ${fmtSen(t.amountSen)} is more.`);
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
      return refuse(500, 'settle_failed', `${docs.get(t.id)?.invoice_number ?? 'The invoice'} could not take the credit: ${moved.reason ?? 'unknown'}`);
    }
    const { error: upErr } = await sb.from('acc_credit_note_allocations').update({ applied_sen: moved.appliedSen })
      .eq('company_id', p.companyId).eq('id', (row as Row).id);
    if (upErr) return refuse(500, 'save_failed', upErr.message);
    applied.push({ kind: t.kind, id: t.id, number: String(docs.get(t.id)?.invoice_number ?? ''), appliedSen: moved.appliedSen });
  }
  return { ok: true, applied };
}

/** Give one application's credit back to the note: the invoice owes again
    exactly what was applied, and the row goes. */
export async function removeAllocation(sb: Db, p: { companyId: number; note: Row; allocationId: string }): Promise<{ ok: true } | { ok: false; refusal: ApplyRefusal }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select('id, purchase_invoice_id, ap_invoice_id, applied_sen')
    .eq('company_id', p.companyId).eq('note_id', p.note.id).eq('id', p.allocationId).maybeSingle();
  if (error) return { ok: false, refusal: { status: 500, error: 'load_failed', message: error.message } };
  if (!data) return { ok: false, refusal: { status: 404, error: 'not_found', message: 'That application is not on this note.' } };
  const r = data as Row;
  return giveBack(sb, p.companyId, [r]);
}

/** Every application of the note given back — before a cancel. */
export async function removeAllAllocations(sb: Db, p: { companyId: number; note: Row }): Promise<{ ok: true } | { ok: false; refusal: ApplyRefusal }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select('id, purchase_invoice_id, ap_invoice_id, applied_sen')
    .eq('company_id', p.companyId).eq('note_id', p.note.id);
  if (error) return { ok: false, refusal: { status: 500, error: 'load_failed', message: error.message } };
  return giveBack(sb, p.companyId, (data ?? []) as Row[]);
}

async function giveBack(sb: Db, companyId: number, rows: Row[]): Promise<{ ok: true } | { ok: false; refusal: ApplyRefusal }> {
  for (const r of rows) {
    const kind: CreditTargetKind = r.purchase_invoice_id ? 'PI' : 'API';
    const applied = Number(r.applied_sen ?? 0);
    if (applied > 0) {
      const moved = await settle(sb, kind, String(r[TABLE[kind].column]), -applied);
      if (!moved.ok) return { ok: false, refusal: { status: 500, error: 'settle_failed', message: `The invoice could not take the credit back: ${moved.reason ?? 'unknown'}` } };
    }
    const { error } = await sb.from('acc_credit_note_allocations').delete().eq('company_id', companyId).eq('id', r.id);
    if (error) return { ok: false, refusal: { status: 500, error: 'save_failed', message: error.message } };
  }
  return { ok: true };
}

/* ── Knock off like an AP Payment (owner 2026-10-02: CN 的方式应该是类似 ap payment
   这样 knock off；扣错了就我 untick 会 knock off 的 invoice 就行了) ──────────────
   A note's knock-off is ONE picture — which of the supplier's invoices it takes
   from, and how much — set whole, the way the AP Payment's Apply-to-PI table is.
   A DRAFT keeps it as a plan: rows with nothing applied yet, carried out by the
   post. A POSTED note's picture is carried out at once; for an invoice whose take
   changes, the old take is given back before the new one is taken, so every
   invoice holds one row and applied_sen stays what the settle really moved. */

export type KnockOffRow = {
  kind: CreditTargetKind; id: string; number: string; invoiceRef: string | null; invoiceDate: string | null;
  totalSen: number;
  /** What the invoice owes before THIS note — its outstanding, plus what this
      note already took off it. The most this note can take from it. */
  owedSen: number;
  /** What this note takes off it: applied once posted, planned while a draft. */
  noteSen: number;
  status: string;
};

type Take = { kind: CreditTargetKind; sen: number; rows: Row[] };
const OWING = new Set(['POSTED', 'PARTIALLY_PAID']);

/** Per invoice, what this note takes off it — applied once posted, planned
    while a draft — and the rows that hold it. */
async function noteTakes(sb: Db, companyId: number, note: Row): Promise<{ ok: true; takes: Map<string, Take> } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select('id, purchase_invoice_id, ap_invoice_id, amount_sen, applied_sen')
    .eq('company_id', companyId).eq('note_id', note.id);
  if (error) return { ok: false, reason: error.message };
  const posted = note.status === 'POSTED';
  const takes = new Map<string, Take>();
  for (const r of (data ?? []) as Row[]) {
    const kind: CreditTargetKind = r.purchase_invoice_id ? 'PI' : 'API';
    const id = String(r[TABLE[kind].column]);
    const t = takes.get(id) ?? { kind, sen: 0, rows: [] };
    t.sen += Number((posted ? r.applied_sen : r.amount_sen) ?? 0);
    t.rows.push(r);
    takes.set(id, t);
  }
  return { ok: true, takes };
}

/** The knock-off table: the supplier's invoices still owing, plus every invoice
    this note already takes from (one it took in full is PAID now, and still the
    note's to untick). A new note (no note yet) sees only the owing ones. */
export async function knockOffRows(sb: Db, companyId: number, p: { supplierId: string; note: Row | null }): Promise<{ ok: true; rows: KnockOffRow[] } | { ok: false; reason: string }> {
  const open = await supplierOpenInvoices(sb, companyId, p.supplierId);
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
  for (const kind of ['PI', 'API'] as const) {
    const ids = [...noted.takes.entries()].filter(([id, t]) => t.kind === kind && !rows.has(id)).map(([id]) => id);
    if (ids.length === 0) continue;
    const { data, error } = await sb.from(TABLE[kind].table).select('id, invoice_number, supplier_invoice_ref, invoice_date, total_sen, paid_sen, status')
      .eq('company_id', companyId).in('id', ids);
    if (error) return { ok: false, reason: error.message };
    for (const r of (data ?? []) as Row[]) {
      const take = noted.takes.get(String(r.id))?.sen ?? 0;
      const outstanding = Math.max(0, Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0));
      rows.set(String(r.id), {
        kind, id: String(r.id), number: String(r.invoice_number), invoiceRef: r.supplier_invoice_ref ?? null, invoiceDate: r.invoice_date ?? null,
        totalSen: Number(r.total_sen ?? 0), owedSen: outstanding + (applied ? take : 0), noteSen: take, status: String(r.status),
      });
    }
  }
  const out = [...rows.values()];
  out.sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')) || a.number.localeCompare(b.number));
  return { ok: true, rows: out };
}

/** The targets as the server takes them — each a purchase or AP invoice, a
    positive sum in sen, one line per invoice. */
export function parseTargets(raw: unknown): CreditTarget[] {
  return (Array.isArray(raw) ? raw : []).map((t: any) => ({
    kind: String(t?.kind ?? '').toUpperCase() as CreditTargetKind, id: String(t?.id ?? '').trim(), amountSen: Number(t?.amountSen),
  }));
}

/** Every target checked before anything is written: each invoice this
    supplier's own and posted, each take within what the invoice owes before
    this note, the whole within the note's total. `current` is what the note
    takes now (a posted note's applied, given back before the new take). */
export async function checkKnockOff(
  sb: Db,
  p: { companyId: number; label: string; supplierId: string; totalSen: number; posted: boolean; targets: CreditTarget[]; current: Map<string, Take> },
): Promise<{ ok: true; numbers: Map<string, string> } | { ok: false; refusal: ApplyRefusal }> {
  const refuse = (status: number, error: string, message: string) => ({ ok: false as const, refusal: { status, error, message } });
  const seen = new Set<string>();
  for (const t of p.targets) {
    if ((t.kind !== 'PI' && t.kind !== 'API') || !t.id) return refuse(400, 'bad_target', 'Each line names a purchase invoice or an AP invoice.');
    if (!Number.isInteger(t.amountSen) || t.amountSen <= 0) return refuse(400, 'bad_amount', 'Each amount is a positive sum in sen.');
    if (seen.has(t.id)) return refuse(400, 'bad_target', 'An invoice is named twice — one line per invoice.');
    seen.add(t.id);
  }
  const asked = p.targets.reduce((s, t) => s + t.amountSen, 0);
  if (asked > p.totalSen) {
    return refuse(409, 'over_credit', `${p.label} is ${fmtSen(p.totalSen)} — knocking off ${fmtSen(asked)} is more.`);
  }
  const numbers = new Map<string, string>();
  for (const t of p.targets) {
    const { data, error } = await sb.from(TABLE[t.kind].table).select('id, invoice_number, supplier_id, total_sen, paid_sen, status')
      .eq('company_id', p.companyId).eq('id', t.id).maybeSingle();
    if (error) return refuse(500, 'load_failed', error.message);
    const doc = data as Row | null;
    if (!doc || String(doc.supplier_id) !== String(p.supplierId)) {
      return refuse(400, 'invoice_not_this_supplier', 'That invoice is not one of this supplier\'s here — pick it again.');
    }
    const mine = p.posted ? (p.current.get(t.id)?.sen ?? 0) : 0;
    /* Owing, or PAID by this very note — the one a posted note may still keep. */
    if (!OWING.has(String(doc.status)) && !(mine > 0 && doc.status === 'PAID')) {
      return refuse(409, 'invoice_not_owing', `${doc.invoice_number} is ${String(doc.status).toLowerCase()} — nothing is owed on it.`);
    }
    const owed = Math.max(0, Number(doc.total_sen ?? 0) - Number(doc.paid_sen ?? 0)) + mine;
    if (t.amountSen > owed) return refuse(409, 'over_invoice', `${doc.invoice_number} owes ${fmtSen(owed)} — ${fmtSen(t.amountSen)} is more.`);
    numbers.set(t.id, String(doc.invoice_number));
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
    credit), each changed invoice's old take given back before its new one is
    taken. `short` names an invoice that took less than asked (paid meanwhile). */
export async function setNoteKnockOff(
  sb: Db,
  p: { companyId: number; note: Row; targets: CreditTarget[]; actor: string | null },
): Promise<{ ok: true; short: KnockOffShort[] } | { ok: false; refusal: ApplyRefusal }> {
  const { note } = p;
  if (note.kind !== 'SCN') return { ok: false, refusal: { status: 400, error: 'not_a_supplier_note', message: `${note.note_number} is not a supplier credit note — only those knock off a supplier's invoice.` } };
  if (note.status === 'CANCELLED') return { ok: false, refusal: { status: 409, error: 'note_cancelled', message: `${note.note_number} is cancelled — it knocks nothing off.` } };
  const noted = await noteTakes(sb, p.companyId, note);
  if (!noted.ok) return { ok: false, refusal: { status: 500, error: 'load_failed', message: noted.reason } };
  const posted = note.status === 'POSTED';
  const checked = await checkKnockOff(sb, {
    companyId: p.companyId, label: String(note.note_number), supplierId: String(note.supplier_id), totalSen: Number(note.total_sen ?? 0),
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
    const number = checked.numbers.get(ch.id) ?? 'The invoice';
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

/** At post — the DRAFT → POSTED moment — the plan is carried out. An invoice
    that owes less now than planned takes what it owes; one that owes nothing
    (paid or cancelled since) takes none, and its row goes. The post stands
    either way; `notApplied` says what stayed with the supplier. */
export async function carryOutPlan(sb: Db, p: { companyId: number; note: Row }): Promise<
  { ok: true; applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }>; notApplied: string[] } | { ok: false; reason: string }
> {
  const { data, error } = await sb.from('acc_credit_note_allocations').select('id, purchase_invoice_id, ap_invoice_id, amount_sen, applied_sen')
    .eq('company_id', p.companyId).eq('note_id', p.note.id).order('created_at');
  if (error) return { ok: false, reason: error.message };
  const applied: Array<{ kind: CreditTargetKind; id: string; number: string; appliedSen: number }> = [];
  const notApplied: string[] = [];
  for (const r of ((data ?? []) as Row[]).filter((x) => Number(x.applied_sen ?? 0) === 0)) {
    const kind: CreditTargetKind = r.purchase_invoice_id ? 'PI' : 'API';
    const id = String(r[TABLE[kind].column]);
    const asked = Number(r.amount_sen ?? 0);
    const drop = async () => { await sb.from('acc_credit_note_allocations').delete().eq('company_id', p.companyId).eq('id', r.id); };
    const { data: doc, error: dErr } = await sb.from(TABLE[kind].table).select('invoice_number, status').eq('company_id', p.companyId).eq('id', id).maybeSingle();
    const number = String((doc as Row | null)?.invoice_number ?? 'The invoice');
    if (dErr || !doc || !OWING.has(String((doc as Row).status))) {
      await drop();
      notApplied.push(`${number} owes nothing now — its ${fmtSen(asked)} stays with the supplier.`);
      continue;
    }
    const moved = await settle(sb, kind, id, asked);
    if (!moved.ok || moved.appliedSen <= 0) {
      await drop();
      notApplied.push(`${number} could not take the credit${moved.ok ? '' : `: ${moved.reason ?? 'unknown'}`} — its ${fmtSen(asked)} stays with the supplier.`);
      continue;
    }
    const { error: upErr } = await sb.from('acc_credit_note_allocations').update({ applied_sen: moved.appliedSen }).eq('company_id', p.companyId).eq('id', r.id);
    if (upErr) return { ok: false, reason: upErr.message };
    if (moved.appliedSen < asked) notApplied.push(`${number} owed only ${fmtSen(moved.appliedSen)} — ${fmtSen(asked - moved.appliedSen)} stays with the supplier.`);
    applied.push({ kind, id, number, appliedSen: moved.appliedSen });
  }
  return { ok: true, applied, notApplied };
}

