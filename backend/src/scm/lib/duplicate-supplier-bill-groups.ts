
import { billRefKey } from './duplicate-supplier-bill';

export type BillTable = 'purchase_invoices' | 'ap_invoices';

export type BillRow = {
  table: BillTable;
  id: string;
  companyId: number;
  supplierId: string | null;
  supplierInvoiceRef: string | null;
  docKind: 'INV' | 'DN';
  status: string;
};

export type BillGroup<R extends BillRow> = {
  table: BillTable;
  supplierId: string;
  docKind: 'INV' | 'DN';
  billKey: string;
  rows: R[];
};

export function groupDuplicateBills<R extends BillRow>(rows: readonly R[]): BillGroup<R>[] {
  const byKey = new Map<string, BillGroup<R>>();
  for (const r of rows) {
    if (String(r.status).toUpperCase() === 'CANCELLED') continue;
    const billKey = billRefKey(r.supplierInvoiceRef);
    if (!billKey || !r.supplierId) continue;
    const k = JSON.stringify([r.companyId, r.table, r.supplierId, r.docKind, billKey]);
    let g = byKey.get(k);
    if (!g) { g = { table: r.table, supplierId: r.supplierId, docKind: r.docKind, billKey, rows: [] }; byKey.set(k, g); }
    g.rows.push(r);
  }
  return [...byKey.values()].filter((g) => g.rows.length > 1);
}
