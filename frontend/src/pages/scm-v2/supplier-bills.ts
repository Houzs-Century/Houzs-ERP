// ----------------------------------------------------------------------------
// Supplier bills — the list's rules in the owner's Claude Design (batch 4,
// step 5). One row shape for the AP bills raised here, Procurement's purchase
// invoices and the suppliers' credit notes; the kind tabs, the status chips,
// the supplier filter, the search and the status tag all read from here, so a
// chip's count and the rows it shows can never disagree.
// ----------------------------------------------------------------------------

import type { ApListRow } from '../../vendor/scm/lib/ap-invoice-queries';
import type { CreditNote } from '../../vendor/scm/lib/credit-note-queries';
import type { ApListingRow } from '../../vendor/scm/lib/ap-invoice-listing-pdf';

export type BillKindTab = 'ALL' | 'API' | 'PI' | 'SCN';
export type BillChip = 'all' | 'unpaid' | 'overdue' | 'draft' | 'paid' | 'cancelled';
/** `all`, `trade` (400), `other` (405), or one supplier's id. */
export type SupplierPick = string;
export type BillTone = 'calm' | 'warn' | 'info' | 'late';

export type BillRow = {
  key: string;
  kind: 'API' | 'PI' | 'SCN';
  /** An AP bill that is a supplier's debit note (series {co}SDN-). */
  debitNote: boolean;
  id: string;
  number: string;
  supplierId: string | null;
  supplierName: string | null;
  supplierCode: string | null;
  /** The control it sits on, the server's rule: AP (400) or AP_OTHER (405). */
  controlRole: 'AP' | 'AP_OTHER' | null;
  ref: string | null;
  description: string | null;
  date: string | null;
  due: string | null;
  currency: string;
  totalSen: number;
  /** Paid on a bill; used on a credit note. */
  paidSen: number;
  /** Still owed on a posted bill; null on a draft, a cancelled bill and every credit note. */
  outstandingSen: number | null;
  /** A posted credit note's credit not used yet; null otherwise. */
  unusedSen: number | null;
  status: string;
  held: boolean;
  holdReason: string | null;
};

/** Where the paper stands: a purchase invoice's POSTED / PARTIALLY_PAID / PAID / ON_HOLD all read as posted. */
export const lifeOf = (status: string): 'draft' | 'cancelled' | 'posted' =>
  status === 'DRAFT' ? 'draft' : status === 'CANCELLED' ? 'cancelled' : 'posted';

export const fromApRow = (r: ApListRow): BillRow => ({
  key: `${r.kind}-${r.id}`,
  kind: r.kind,
  debitNote: r.kind === 'API' && r.docKind === 'DN',
  id: r.id,
  number: r.invoiceNumber,
  supplierId: r.supplierId,
  supplierName: r.supplierName,
  supplierCode: r.supplierCode,
  controlRole: r.controlRole ?? null,
  ref: r.supplierInvoiceRef,
  description: r.description,
  date: r.invoiceDate,
  due: r.dueDate,
  currency: r.currency,
  totalSen: r.totalSen,
  paidSen: r.paidSen,
  outstandingSen: lifeOf(r.status) === 'posted' ? r.outstandingSen : null,
  unusedSen: null,
  status: r.status,
  held: r.held === true,
  holdReason: r.holdReason ?? null,
});

export const fromNote = (n: CreditNote): BillRow => ({
  key: `SCN-${n.id}`,
  kind: 'SCN',
  debitNote: false,
  id: n.id,
  number: n.note_number,
  supplierId: n.supplier_id,
  supplierName: n.party_name,
  supplierCode: n.party_code,
  controlRole: n.controlRole ?? null,
  ref: n.source_doc_no,
  description: n.reason,
  date: n.note_date,
  due: null,
  currency: 'MYR',
  totalSen: n.total_sen,
  paidSen: n.appliedSen ?? 0,
  outstandingSen: null,
  unusedSen: n.status === 'POSTED' ? (n.unusedSen ?? n.total_sen) : null,
  status: n.status,
  held: false,
  holdReason: null,
});

/** Still open — a posted bill with money owed, a posted credit note with credit
    not used. These wear the sand tint and sit under Unpaid / To use. */
export const isOpen = (r: BillRow): boolean =>
  (r.kind === 'SCN' ? r.unusedSen ?? 0 : r.outstandingSen ?? 0) > 0;

/** Whole days a bill is past its due date, by the calendar date (MYT); 0 when not yet due. */
export const daysLate = (due: string | null, today: string): number =>
  !due || due >= today ? 0 : Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000);

export const inKind = (r: BillRow, tab: BillKindTab): boolean => tab === 'ALL' || r.kind === tab;

export function inChip(r: BillRow, chip: BillChip, today: string): boolean {
  const life = lifeOf(r.status);
  switch (chip) {
    case 'all': return true;
    case 'draft': return life === 'draft';
    case 'cancelled': return life === 'cancelled';
    case 'unpaid': return life === 'posted' && isOpen(r);
    case 'overdue': return life === 'posted' && r.kind !== 'SCN' && isOpen(r) && daysLate(r.due, today) > 0;
    case 'paid': return life === 'posted' && !isOpen(r);
  }
}

const CHIPS: BillChip[] = ['all', 'unpaid', 'overdue', 'draft', 'paid', 'cancelled'];
/** The chips a tab offers: a credit note is never overdue. */
export const chipsOf = (tab: BillKindTab): BillChip[] => CHIPS.filter((c) => !(tab === 'SCN' && c === 'overdue'));

/** A chip's word — Unpaid / Paid read To use / Used on the Credit notes tab (the design). */
export function chipLabel(chip: BillChip, tab: BillKindTab): string {
  switch (chip) {
    case 'all': return 'All';
    case 'unpaid': return tab === 'SCN' ? 'To use' : 'Unpaid';
    case 'overdue': return 'Overdue';
    case 'draft': return 'Draft';
    case 'paid': return tab === 'SCN' ? 'Used' : 'Paid';
    case 'cancelled': return 'Cancelled';
  }
}

export function kindTabLabel(tab: BillKindTab): string {
  switch (tab) {
    case 'ALL': return 'All';
    case 'API': return 'AP bills';
    case 'PI': return 'Purchase invoices';
    case 'SCN': return 'Credit notes';
  }
}

export const ofSupplier = (r: BillRow, pick: SupplierPick): boolean =>
  pick === 'all' ? true
    : pick === 'trade' ? r.controlRole === 'AP'
      : pick === 'other' ? r.controlRole === 'AP_OTHER'
        : r.supplierId === pick;

/** A typed amount — `1,234.50`, `RM 1234.5` — in sen; null when the text is not money. */
export const moneyOfQuery = (q: string): number | null => {
  const t = q.replace(/^rm\s*/i, '').replace(/,/g, '').trim();
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null;
};

/** The search box (the design: no., supplier, ref, amount) — over the rows on the page. */
export function matchesBill(r: BillRow, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const sen = moneyOfQuery(t);
  if (sen != null && [r.totalSen, r.outstandingSen, r.unusedSen].includes(sen)) return true;
  return [r.number, r.supplierName, r.supplierCode, r.ref, r.description].some((v) => (v ?? '').toLowerCase().includes(t));
}

/** The status tag, in the design's order: cancelled, draft, a note's use, paid, held, part paid, late. */
export function billTag(r: BillRow, today: string): { text: string; tone: BillTone } {
  const life = lifeOf(r.status);
  if (life === 'cancelled') return { text: 'Cancelled', tone: 'calm' };
  if (life === 'draft') return { text: 'Draft', tone: 'calm' };
  if (r.kind === 'SCN') return isOpen(r) ? { text: 'To use', tone: 'info' } : { text: 'Used', tone: 'calm' };
  if (!isOpen(r)) return { text: 'Paid', tone: 'calm' };
  if (r.held) return { text: 'On hold', tone: 'late' };
  if (r.paidSen > 0) return { text: 'Partly paid', tone: 'info' };
  const late = daysLate(r.due, today);
  return late > 0 ? { text: `Overdue ${late}d`, tone: 'late' } : { text: 'Posted', tone: 'calm' };
}

/** What the paper is, in a word (the Kind column and the listing). */
export const billKindWord = (r: BillRow): string =>
  r.kind === 'SCN' ? 'Credit note' : r.kind === 'PI' ? 'Purchase invoice' : r.debitNote ? 'Debit note' : 'AP bill';

/** The control's short word on the row (the design's pill). */
export const controlWord = (r: BillRow): string => (r.controlRole === 'AP_OTHER' ? '405' : r.controlRole === 'AP' ? '400' : '—');

/** What a ticked row adds to the batch bar: a credit note takes off what we owe. */
export const signedSen = (r: BillRow): number => (r.kind === 'SCN' ? -r.totalSen : r.totalSen);

/** List order: what is still owed by its due date (soonest first); everything else newest first. */
export function sortBills(rows: BillRow[], chip: BillChip): BillRow[] {
  const byDue = chip === 'unpaid' || chip === 'overdue';
  return [...rows].sort((a, b) => (byDue
    ? String(a.due ?? '9999').localeCompare(String(b.due ?? '9999'))
    : String(b.date ?? '').localeCompare(String(a.date ?? ''))) || b.number.localeCompare(a.number));
}

/** A row as Print listing prints it — a credit note's figure takes off what we owe. */
export const listingRowOf = (r: BillRow, today: string): ApListingRow => ({
  kindWord: billKindWord(r),
  number: r.number,
  supplierName: r.supplierName,
  supplierCode: r.supplierCode,
  control: r.controlRole ? controlWord(r) : '',
  ref: r.ref,
  date: r.date,
  due: r.kind === 'SCN' ? null : r.due,
  planned: null,
  description: r.description,
  currency: r.currency,
  totalSen: signedSen(r),
  paidSen: r.kind === 'SCN' ? 0 : r.paidSen,
  outstandingSen: r.outstandingSen,
  status: billTag(r, today).text,
});
