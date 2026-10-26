// stock-take-sources — which PO(s) the stock on a count line came in on
// (Sim 2026-10-26: "with PO more easy for us to trace it"; Samuel: every PO
// still holding stock on the variant, with its qty, and stock that has no PO
// says where it came from instead of a blank).
//
// Read-time only, from the same open lots the cost estimate reads: a lot's
// batch_no is its PO (GRN-stamped, mig 0120); a NULL-batch GRN lot resolves
// its PO through grns.purchase_order_id, like source-po-trace's classifyLots.
// Anything else is labelled by its source document. Nothing is written.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { scopeToCompanyId } from './companyScope';
import { UUID_CHUNK } from './paginate-all';

export type StockSource = { label: string; po: boolean; qty: number };

export type SourceLot = {
  id: string | null;
  batch_no: string | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
  qty_remaining: number | null;
  received_at: string | null;
};

/* Stock that came in on no PO. AC_CUTOVER = the AutoCount opening balance
   brought over at go-live, the biggest share on production. */
const NON_PO_LABEL: Record<string, string> = {
  AC_CUTOVER: 'AC opening',
  STOCK_TRANSFER: 'Transfer',
  ADJUSTMENT: 'Stock adj',
  STOCK_TAKE: 'Stock take',
  DO: 'DO reversed',
  CS_DO: 'DO reversed',
  DR: 'Return',
  CS_DR: 'Return',
  POS_VOID: 'Return',
  PC_RECEIVE: 'Consignment',
  CONSIGNMENT_NOTE: 'Consignment',
  GRN: 'GRN, no PO',
};

const nonPoLabel = (srcType: string): string =>
  NON_PO_LABEL[srcType] ?? (srcType ? srcType.replace(/_/g, ' ') : 'Unknown');

/** Pure: one bucket's open lots -> its sources, oldest first (the order FIFO ships them). */
export const foldStockSources = (
  lots: readonly SourceLot[],
  poByGrnId: ReadonlyMap<string, string>,
): StockSource[] => {
  const open = lots
    .filter((l) => Number(l.qty_remaining ?? 0) > 0)
    .sort((a, b) => String(a.received_at ?? '').localeCompare(String(b.received_at ?? ''))
      || String(a.id ?? '').localeCompare(String(b.id ?? '')));
  const out = new Map<string, StockSource>();
  for (const l of open) {
    const srcType = (l.source_doc_type ?? '').toUpperCase();
    const batch = (l.batch_no ?? '').trim();
    const po = batch
      || (srcType === 'GRN' && l.source_doc_id ? (poByGrnId.get(l.source_doc_id) ?? '') : '');
    const label = po || nonPoLabel(srcType);
    const cur = out.get(label) ?? { label, po: po !== '', qty: 0 };
    cur.qty += Number(l.qty_remaining ?? 0);
    out.set(label, cur);
  }
  return [...out.values()];
};

/** GRN id -> PO number, for open lots that carry no batch_no. Company-scoped on both reads. */
export async function poNumbersForGrnLots(
  sb: any, companyId: number, lots: readonly SourceLot[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const grnIds = [...new Set(lots
    .filter((l) => !(l.batch_no ?? '').trim() && (l.source_doc_type ?? '').toUpperCase() === 'GRN'
      && l.source_doc_id && Number(l.qty_remaining ?? 0) > 0)
    .map((l) => l.source_doc_id as string))];
  if (grnIds.length === 0) return out;
  const poIdByGrn = new Map<string, string>();
  for (let i = 0; i < grnIds.length; i += UUID_CHUNK) {
    const { data, error } = await scopeToCompanyId(sb.from('grns')
      .select('id, purchase_order_id')
      .in('id', grnIds.slice(i, i + UUID_CHUNK)), companyId);
    if (error) return out;
    for (const g of (data ?? []) as Array<{ id: string; purchase_order_id: string | null }>) {
      if (g.purchase_order_id) poIdByGrn.set(g.id, g.purchase_order_id);
    }
  }
  const poIds = [...new Set(poIdByGrn.values())];
  const poNoById = new Map<string, string>();
  for (let i = 0; i < poIds.length; i += UUID_CHUNK) {
    const { data, error } = await scopeToCompanyId(sb.from('purchase_orders')
      .select('id, po_number')
      .in('id', poIds.slice(i, i + UUID_CHUNK)), companyId);
    if (error) return out;
    for (const p of (data ?? []) as Array<{ id: string; po_number: string | null }>) {
      if (p.po_number) poNoById.set(p.id, p.po_number);
    }
  }
  for (const [grnId, poId] of poIdByGrn) {
    const no = poNoById.get(poId);
    if (no) out.set(grnId, no);
  }
  return out;
}
