// ----------------------------------------------------------------------------
// A customer credit note raised from a Delivery Return (Hookka #952 / #956 /
// #959, backlog A1). The return moves stock only (docs/modules/delivery-return.md);
// this is its money side: each returned line is credited at what the customer
// was INVOICED for it — the invoice line's total after discount and tax, per
// unit — never the SKU's list price, and never more units than came back.
//
// The link is stored on the note (acc_credit_notes.delivery_return_id) and on
// each line (acc_credit_note_lines.delivery_return_item_id + qty). A cancelled
// note gives its quantity back. The database refuses a line that would credit
// more than was returned (migration 20261110T0200) — this file says so first,
// in words, and is what the screens read.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout scm/lib */
import { chunkIn } from './paginate-all';

type Row = Record<string, any>;

export type ReturnLineIn = { id: string; do_item_id: string | null; item_code: string | null; description: string | null; qty_returned: number };
export type InvoiceLineIn = { sales_invoice_id: string; do_item_id: string | null; qty: number; line_total_sen: number };

export type PricedReturnLine = {
  returnItemId: string;
  itemCode: string | null;
  description: string | null;
  qtyReturned: number;
  /** Units already on a live (draft or posted) credit note. */
  creditedQty: number;
  remainingQty: number;
  /** Per-unit credit off the invoice, unrounded; null = this line was never invoiced. */
  unitSen: number | null;
  /** The invoices that billed the line's delivery-order line. */
  invoiceIds: string[];
};

/** A sales invoice counts as billed once issued — never a draft, never cancelled or void. */
export const isIssuedInvoice = (status: string | null | undefined): boolean => {
  const s = String(status ?? '').toUpperCase();
  return s !== '' && s !== 'DRAFT' && s !== 'CANCELLED' && s !== 'VOID';
};

/** Each returned line priced off the issued invoice lines that billed its DO line. */
export function priceReturnLines(
  lines: readonly ReturnLineIn[],
  invoiceLines: readonly InvoiceLineIn[],
  creditedQty: ReadonlyMap<string, number>,
): PricedReturnLine[] {
  return lines.map((l) => {
    const billed = l.do_item_id ? invoiceLines.filter((s) => s.do_item_id === l.do_item_id && Number(s.qty) > 0) : [];
    const qty = billed.reduce((s, b) => s + Number(b.qty), 0);
    const total = billed.reduce((s, b) => s + Number(b.line_total_sen), 0);
    const credited = creditedQty.get(l.id) ?? 0;
    const returned = Number(l.qty_returned);
    return {
      returnItemId: l.id,
      itemCode: l.item_code,
      description: l.description,
      qtyReturned: returned,
      creditedQty: credited,
      remainingQty: Math.max(0, returned - credited),
      unitSen: qty > 0 ? total / qty : null,
      invoiceIds: [...new Set(billed.map((b) => b.sales_invoice_id))],
    };
  });
}

/** The most a line may credit for `qty` units: the invoiced unit price times qty, to the sen. */
export const lineCapSen = (unitSen: number, qty: number): number => Math.round(unitSen * qty);

/** The invoice the note goes on: the one that billed most of the return's lines (ties: the first met). */
export function pickInvoice(priced: readonly PricedReturnLine[]): string | null {
  const count = new Map<string, number>();
  for (const p of priced) for (const id of p.invoiceIds) count.set(id, (count.get(id) ?? 0) + 1);
  let best: string | null = null;
  for (const [id, n] of count) if (best === null || n > (count.get(best) ?? 0)) best = id;
  return best;
}

export type ReturnCreditState = 'NOT_INVOICED' | 'AWAITING' | 'DRAFTED' | 'ISSUED';

/** Where the return's money side stands, worked from the notes actually linked:
    nothing invoiced needs no note; any invoiced unit not yet on a live note is
    awaiting one; all covered with a draft among them is drafted; else issued. */
export function returnCreditState(priced: readonly PricedReturnLine[], liveNoteStatuses: readonly string[]): ReturnCreditState {
  const invoiced = priced.filter((p) => p.unitSen !== null && p.qtyReturned > 0);
  if (invoiced.length === 0) return 'NOT_INVOICED';
  if (invoiced.some((p) => p.remainingQty > 0)) return 'AWAITING';
  return liveNoteStatuses.some((s) => s === 'DRAFT') ? 'DRAFTED' : 'ISSUED';
}

export type ReturnLineCheckIn = { returnItemId: string; qty: number; amountSen: number };
export type ReturnLineRefusal = { error: string; message: string };

/** The lines a note asks to credit, held against the priced return: every line
    names one of the return's lines, once; a whole number of units no more than
    is still uncredited; an amount no more than the invoice charged for them. */
export function checkReturnLines(priced: readonly PricedReturnLine[], asked: readonly ReturnLineCheckIn[]): ReturnLineRefusal | null {
  const byId = new Map(priced.map((p) => [p.returnItemId, p]));
  const seen = new Set<string>();
  for (const [i, a] of asked.entries()) {
    const p = byId.get(a.returnItemId);
    const at = `Line ${i + 1}`;
    if (!p) return { error: 'return_line_unknown', message: `${at} is not a line of this delivery return.` };
    const name = p.itemCode ?? p.description ?? 'this item';
    if (seen.has(a.returnItemId)) return { error: 'return_line_twice', message: `${at}: ${name} is on this note twice — put its units on one line.` };
    seen.add(a.returnItemId);
    if (!Number.isInteger(a.qty) || a.qty <= 0) return { error: 'bad_line', message: `${at}: the quantity credited must be a whole number above zero.` };
    if (p.unitSen === null) return { error: 'return_line_not_invoiced', message: `${at}: ${name} was never invoiced, so there is nothing to credit for it.` };
    if (a.qty > p.remainingQty) {
      return {
        error: 'over_return_credit',
        message: `${at}: ${name} — ${p.qtyReturned} came back and ${p.creditedQty} ${p.creditedQty === 1 ? 'is' : 'are'} already on a credit note, so at most ${p.remainingQty} can be credited (asked ${a.qty}).`,
      };
    }
    const cap = lineCapSen(p.unitSen, a.qty);
    if (a.amountSen > cap) {
      return { error: 'over_invoice_price', message: `${at}: ${name} — ${a.qty} unit(s) were invoiced at ${(cap / 100).toFixed(2)} in all; the credit cannot be more (asked ${(a.amountSen / 100).toFixed(2)}).` };
    }
  }
  return null;
}

export type ReturnCredit = {
  ret: { id: string; return_number: string; status: string; delivery_order_id: string | null; do_doc_no: string | null; debtor_name: string | null };
  lines: PricedReturnLine[];
  invoice: { id: string; invoice_number: string; so_doc_no: string | null } | null;
  soDocNo: string | null;
  notes: Array<{ id: string; note_number: string; status: string; total_sen: number }>;
  state: ReturnCreditState;
};

export type ReturnCreditRead = { ok: true; value: ReturnCredit } | { ok: false; status: 404 | 500; reason: string };

/** Everything a credit note from this return needs, read in the caller's company.
    `excludeNoteId`: the draft being edited — its own lines do not count against it. */
export async function loadReturnCredit(sb: any, companyId: number, returnId: string, excludeNoteId: string | null): Promise<ReturnCreditRead> {
  const { data: hdr, error: hErr } = await sb.from('delivery_returns')
    .select('id, return_number, status, delivery_order_id, do_doc_no, debtor_name')
    .eq('company_id', companyId).eq('id', returnId).maybeSingle();
  if (hErr) return { ok: false, status: 500, reason: `delivery_returns: ${hErr.message}` };
  if (!hdr) return { ok: false, status: 404, reason: 'That delivery return is not in the company you are working in.' };
  const ret = hdr as ReturnCredit['ret'];

  const { data: items, error: iErr } = await sb.from('delivery_return_items')
    .select('id, do_item_id, item_code, description, qty_returned')
    .eq('company_id', companyId).eq('delivery_return_id', returnId).order('created_at');
  if (iErr) return { ok: false, status: 500, reason: `delivery_return_items: ${iErr.message}` };
  const lines = (Array.isArray(items) ? items : []) as ReturnLineIn[];

  const doItemIds = [...new Set(lines.map((l) => l.do_item_id).filter((x): x is string => !!x))];
  const siLines = await chunkIn<InvoiceLineIn>(doItemIds, (batch, from, to) => sb.from('sales_invoice_items')
    .select('sales_invoice_id, do_item_id, qty, line_total_sen').eq('company_id', companyId).in('do_item_id', batch).order('id').range(from, to));
  if (siLines.error) return { ok: false, status: 500, reason: `sales_invoice_items: ${siLines.error.message}` };
  const siIds = [...new Set(siLines.data.map((l) => l.sales_invoice_id))];
  const sis = await chunkIn<Row>(siIds, (batch, from, to) => sb.from('sales_invoices')
    .select('id, invoice_number, so_doc_no, status').eq('company_id', companyId).in('id', batch).order('id').range(from, to));
  if (sis.error) return { ok: false, status: 500, reason: `sales_invoices: ${sis.error.message}` };
  const issued = new Map(sis.data.filter((s) => isIssuedInvoice(s.status)).map((s) => [String(s.id), s]));

  const itemIds = lines.map((l) => l.id);
  const noteLines = await chunkIn<Row>(itemIds, (batch, from, to) => sb.from('acc_credit_note_lines')
    .select('note_id, delivery_return_item_id, qty').eq('company_id', companyId).in('delivery_return_item_id', batch).order('id').range(from, to));
  if (noteLines.error) return { ok: false, status: 500, reason: `acc_credit_note_lines: ${noteLines.error.message}` };
  const noteIds = [...new Set(noteLines.data.map((l) => String(l.note_id)))];
  const notesRead = await chunkIn<Row>(noteIds, (batch, from, to) => sb.from('acc_credit_notes')
    .select('id, note_number, status, total_sen').eq('company_id', companyId).in('id', batch).order('id').range(from, to));
  if (notesRead.error) return { ok: false, status: 500, reason: `acc_credit_notes: ${notesRead.error.message}` };
  const live = new Map(notesRead.data.filter((n) => n.status !== 'CANCELLED').map((n) => [String(n.id), n]));
  const credited = new Map<string, number>();
  for (const l of noteLines.data) {
    if (!live.has(String(l.note_id)) || String(l.note_id) === excludeNoteId) continue;
    const k = String(l.delivery_return_item_id);
    credited.set(k, (credited.get(k) ?? 0) + Number(l.qty ?? 0));
  }

  const priced = priceReturnLines(lines, siLines.data.filter((l) => issued.has(l.sales_invoice_id)), credited);
  const invoiceId = pickInvoice(priced);
  const inv = invoiceId ? issued.get(invoiceId) : undefined;
  let soDocNo: string | null = inv?.so_doc_no ?? null;
  if (!soDocNo && ret.delivery_order_id) {
    const { data: doHdr, error: dErr } = await sb.from('delivery_orders').select('so_doc_no').eq('company_id', companyId).eq('id', ret.delivery_order_id).maybeSingle();
    if (dErr) return { ok: false, status: 500, reason: `delivery_orders: ${dErr.message}` };
    soDocNo = (doHdr as { so_doc_no: string | null } | null)?.so_doc_no ?? null;
  }
  const notes = [...live.values()].map((n) => ({ id: String(n.id), note_number: String(n.note_number), status: String(n.status), total_sen: Number(n.total_sen ?? 0) }))
    .sort((a, b) => a.note_number.localeCompare(b.note_number));
  return {
    ok: true,
    value: {
      ret, lines: priced,
      invoice: inv ? { id: String(inv.id), invoice_number: String(inv.invoice_number), so_doc_no: inv.so_doc_no ?? null } : null,
      soDocNo, notes,
      state: returnCreditState(priced, notes.map((n) => n.status)),
    },
  };
}

/** Units on live credit notes per return line — the DR's own edits read this
    before taking a credited unit away. */
export async function liveCreditedQty(sb: any, companyId: number, returnItemIds: readonly string[]): Promise<{ ok: true; byItem: Map<string, number> } | { ok: false; reason: string }> {
  const byItem = new Map<string, number>();
  const ids = [...new Set(returnItemIds.filter(Boolean))];
  if (ids.length === 0) return { ok: true, byItem };
  const lines = await chunkIn<Row>(ids, (batch, from, to) => sb.from('acc_credit_note_lines')
    .select('note_id, delivery_return_item_id, qty').eq('company_id', companyId).in('delivery_return_item_id', batch).order('id').range(from, to));
  if (lines.error) return { ok: false, reason: `acc_credit_note_lines: ${lines.error.message}` };
  const noteIds = [...new Set(lines.data.map((l) => String(l.note_id)))];
  const notes = await chunkIn<Row>(noteIds, (batch, from, to) => sb.from('acc_credit_notes')
    .select('id, status').eq('company_id', companyId).in('id', batch).order('id').range(from, to));
  if (notes.error) return { ok: false, reason: `acc_credit_notes: ${notes.error.message}` };
  const live = new Set(notes.data.filter((n) => n.status !== 'CANCELLED').map((n) => String(n.id)));
  for (const l of lines.data) {
    if (!live.has(String(l.note_id))) continue;
    const k = String(l.delivery_return_item_id);
    byItem.set(k, (byItem.get(k) ?? 0) + Number(l.qty ?? 0));
  }
  return { ok: true, byItem };
}

/** A return edit that would take away units a live credit note already credits
    — a cancel (every line to 0), a line deleted (to 0), a quantity cut — is
    refused: cancel the credit note first. A failed read refuses too. */
export async function creditNoteHold(
  sb: any, companyId: number, keep: ReadonlyArray<{ itemId: string; qty: number }>,
): Promise<{ error: string; message: string; status: 409 | 503 } | null> {
  const read = await liveCreditedQty(sb, companyId, keep.map((k) => k.itemId));
  if (!read.ok) return { error: 'credit_check_failed', message: `Could not check the credit notes raised from this return (${read.reason}) — try again.`, status: 503 };
  for (const k of keep) {
    const credited = read.byItem.get(k.itemId) ?? 0;
    if (credited > k.qty) {
      return {
        error: 'dr_credit_noted', status: 409,
        message: `${credited} unit(s) of this return are on a credit note — cancel the credit note first, then change the return.`,
      };
    }
  }
  return null;
}
