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

