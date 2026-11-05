// ----------------------------------------------------------------------------
// What paid an AP bill — the bill page's Payments section in the owner's Claude
// Design (Money out, batch 4 step 6; read c7). Read-only: the vouchers whose
// allocations name the bill (a voucher's own payment, or an advance knocked off
// onto it), the supplier credit notes knocked off it, and the bill's journal.
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from '../lib/companyScope';

type Row = Record<string, any>;

export type BillPayment = {
  kind: 'PV' | 'SCN';
  /** The voucher's or the note's id — the page links to it. */
  id: string;
  number: string;
  date: string | null;
  /** The voucher's stage in the design's words, or the note's status. */
  stage: string;
  amountSen: number;
  /** An advance paid earlier, knocked off onto this bill from the voucher that holds it. */
  fromAdvance: boolean;
};

/** A voucher's stage as the redesign says it: the four layers ride on a DRAFT as marks. */
const pvStageWord = (pv: Row | undefined): string =>
  !pv ? 'Unknown' : pv.status === 'CANCELLED' ? 'Cancelled' : pv.status === 'POSTED' ? 'Approved' : pv.checked_at ? 'Checked' : pv.submitted_at ? 'Prepared' : 'Draft';

export async function billPayments(sb: any, c: CompanyScopeCtx, inv: Row): Promise<
  { ok: true; payments: BillPayment[]; jeNo: string | null } | { ok: false; reason: string }
> {
  const [al, cn, je] = await Promise.all([
    scopeToCompany(sb.from('pv_allocations').select('id, pv_id, amount_sen, from_advance').eq('ap_invoice_id', inv.id), c),
    scopeToCompany(sb.from('acc_credit_note_allocations').select('id, note_id, amount_sen, applied_sen').eq('ap_invoice_id', inv.id), c),
    /* The bill's journal: one, two when an edit re-posted it (the old one reversed). */
    scopeToCompany(sb.from('journal_entries').select('je_no, reversed').eq('source_type', 'API').eq('source_doc_no', inv.invoice_number), c),
  ]);
  if (al.error) return { ok: false, reason: `allocations: ${al.error.message}` };
  if (cn.error) return { ok: false, reason: `credit notes: ${cn.error.message}` };
  if (je.error) return { ok: false, reason: `journal: ${je.error.message}` };
  const allocs = (al.data ?? []) as Row[];
  const knocks = (cn.data ?? []) as Row[];

  const pvIds = [...new Set(allocs.map((a) => String(a.pv_id)))];
  const noteIds = [...new Set(knocks.map((k) => String(k.note_id)))];
  const [pvs, notes] = await Promise.all([
    pvIds.length === 0 ? { data: [], error: null }
      : scopeToCompany(sb.from('payment_vouchers').select('id, pv_number, voucher_date, status, submitted_at, checked_at'), c).in('id', pvIds),
    noteIds.length === 0 ? { data: [], error: null }
      : scopeToCompany(sb.from('acc_credit_notes').select('id, note_number, note_date, status'), c).in('id', noteIds),
  ]);
  if (pvs.error) return { ok: false, reason: `vouchers: ${pvs.error.message}` };
  if (notes.error) return { ok: false, reason: `notes: ${notes.error.message}` };
  const pvById = new Map(((pvs.data ?? []) as Row[]).map((p) => [String(p.id), p]));
  const noteById = new Map(((notes.data ?? []) as Row[]).map((n) => [String(n.id), n]));

  const payments: BillPayment[] = [
    ...allocs.map((a): BillPayment => {
      const pv = pvById.get(String(a.pv_id));
      return {
        kind: 'PV', id: String(a.pv_id), number: String(pv?.pv_number ?? '—'), date: pv?.voucher_date ?? null,
        stage: pvStageWord(pv), amountSen: Number(a.amount_sen ?? 0), fromAdvance: a.from_advance === true,
      };
    }),
    ...knocks.map((k): BillPayment => {
      const note = noteById.get(String(k.note_id));
      const posted = note?.status === 'POSTED';
      /* A posted note took what it moved; a draft's tick is its plan. */
      return {
        kind: 'SCN', id: String(k.note_id), number: String(note?.note_number ?? '—'), date: note?.note_date ?? null,
        stage: posted ? 'Posted' : note?.status === 'CANCELLED' ? 'Cancelled' : 'Draft',
        amountSen: Number((posted ? k.applied_sen : k.amount_sen) ?? 0), fromAdvance: false,
      };
    }),
  ].sort((x, y) => String(x.date ?? '').localeCompare(String(y.date ?? '')) || x.number.localeCompare(y.number));

  let jeNo: string | null = null;
  for (const j of (je.data ?? []) as Row[]) if (!j.reversed || jeNo == null) jeNo = String(j.je_no);
  return { ok: true, payments, jeNo };
}
