// ----------------------------------------------------------------------------
// si-credit-notes — what customers' credit notes knock off a SALES INVOICE
// (owner 2026-11-03: 「要」 — his design, "like AutoCount": a customer's credit
// note knocks off the customer's sales invoices and each owes that much less).
//
// The knock-off posts nothing: the note's own journal already credits the
// customer (Dr its lines / Cr 300-0000 Trade Debtors). It is a row of
// scm.acc_credit_note_allocations naming the invoice (sales_invoice_id,
// migration 20261108T1600), applied_sen what it took. It is kept APART from
// the invoice's paid_sen on purpose: paid_sen feeds the overpayment rule
// (customer-credits.ts reconcileSiOverpay — money above the total becomes
// customer credit), so a credit written there would turn a later full payment
// into credit. Every reader of an invoice's outstanding subtracts this figure
// beside the order's deposit; si-order-deposit.ts stamps both on a page of rows
// (`credit_notes_sen`).
//
// Only a POSTED note's rows count: a draft's are its plan (applied 0), and a
// cancelled note's are given back before the cancel. A failed read is never
// "nothing credited" — it comes back `ok: false` and the caller keeps the
// LARGER outstanding, the one direction it may be wrong in.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout scm/lib */
type Row = Record<string, any>;

export type SiCreditRead = { ok: true; bySi: Map<string, number> } | { ok: false; reason: string };

/** What POSTED customer credit notes knocked off each invoice, by invoice id. */
export async function creditNotesBySi(sb: any, companyId: number, siIds: readonly string[]): Promise<SiCreditRead> {
  const ids = [...new Set(siIds.filter((x) => typeof x === 'string' && x !== ''))];
  const bySi = new Map<string, number>();
  if (ids.length === 0) return { ok: true, bySi };
  try {
    const rows = await chunkIn<Row>(ids, (batch, from, to) => sb.from('acc_credit_note_allocations')
      .select('id, note_id, sales_invoice_id, applied_sen').eq('company_id', companyId).in('sales_invoice_id', batch)
      .order('id').range(from, to));
    if (rows.error) return { ok: false, reason: rows.error.message };
    const taken = rows.data.filter((r) => Number(r.applied_sen ?? 0) > 0);
    if (taken.length === 0) return { ok: true, bySi };
    const noteIds = [...new Set(taken.map((r) => String(r.note_id)))];
    const notes = await chunkIn<Row>(noteIds, (batch, from, to) => sb.from('acc_credit_notes')
      .select('id, status').eq('company_id', companyId).in('id', batch).order('id').range(from, to));
    if (notes.error) return { ok: false, reason: notes.error.message };
    const posted = new Set(notes.data.filter((n) => n.status === 'POSTED').map((n) => String(n.id)));
    for (const r of taken) {
      if (!posted.has(String(r.note_id))) continue;
      const si = String(r.sales_invoice_id);
      bySi.set(si, (bySi.get(si) ?? 0) + Number(r.applied_sen));
    }
    return { ok: true, bySi };
  } catch (e) {
    /* A client that throws is a read that failed, never a credit of nothing. */
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The credit notes knocked off ONE invoice, for the screens that read one
    (the Sales detail and its print). null = could not read — the screen keeps
    the larger outstanding. */
export async function siCreditNotesSen(sb: any, companyId: number | null, siId: string): Promise<number | null> {
  if (companyId == null) return null;
  const read = await creditNotesBySi(sb, companyId, [siId]);
  if (!read.ok) {
    /* eslint-disable-next-line no-console */
    console.error('[si-credit-notes] read failed — the invoice keeps its larger outstanding:', siId, read.reason);
    return null;
  }
  return read.bySi.get(siId) ?? 0;
}

/** The ONE place an invoice's credit-note figure is read off a stamped row:
    a number, or 0 when the stamp could not read it. */
export const creditNotesOf = (r: Row): number => {
  const v = Number(r.credit_notes_sen ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
};
