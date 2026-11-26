// ----------------------------------------------------------------------------
// product-changes — Finance's product change reports (owner 2026-11-23:
// 「我主要是看销售价和成本的变动，因为我要确定这些改动销售价是足够cover成本的变动」,
// and 「那个变动的报表我要可以选择月份去看哦」).
//
// One row per product change event on a sales order (scm.so_product_changes,
// written when the change is saved or approved: scm/lib/so-product-change-record.ts),
// with the order it changed and who sold it. The detail report lists them;
// the summary report (P&L-style) adds them up by month and by salesperson.
// The month is the change day's (Malaysia). A change to an order that has since
// been cancelled is left out: the sale it changed is gone. Each row says whether
// the order was brought over from AutoCount at the cutover; the reports leave
// those out unless asked (owner 2026-11-23: 「默认只看新单」).
// ----------------------------------------------------------------------------

import { changeCoverage, type ChangedLine, type ProductChangeBucket, type ProductChangeType } from '../scm/lib/so-product-change';
import { soIsMigratedShape } from '../scm/lib/so-is-migrated';

export type PcEventRow = {
  id: string;
  so_doc_no: string;
  route: string;
  change_day: string;
  changed_at: string | null;
  changed_by: string[] | null;
  approved_by: string[] | null;
  amendment_nos: string[] | null;
  change_types: string[] | null;
  bucket: string | null;
  selling_before_sen: number | string | null;
  selling_after_sen: number | string | null;
  cost_before_sen: number | string | null;
  cost_after_sen: number | string | null;
  lines: ChangedLine[] | null;
  rebuilt: boolean | null;
  cost_estimated: boolean | null;
};

export type PcOrder = {
  doc_no: string;
  so_date: string | null;
  status: string | null;
  debtor_name: string | null;
  salesperson_id: string | null;
  agent: string | null;
  linked_ac_docno: string | null;
};

export type ProductChangeRow = {
  id: string;
  docNo: string;
  soDate: string | null;
  customer: string | null;
  salesperson: string;
  imported: boolean;
  changeDay: string;
  changedAt: string | null;
  route: 'DIRECT' | 'AMENDMENT';
  amendmentNos: string[];
  changedBy: string[];
  approvedBy: string[];
  types: ProductChangeType[];
  bucket: ProductChangeBucket;
  sellingBeforeSen: number;
  sellingAfterSen: number;
  costBeforeSen: number;
  costAfterSen: number;
  sellingDeltaSen: number;
  costDeltaSen: number;
  marginDeltaSen: number;
  covered: boolean;
  shortfallSen: number;
  lines: ChangedLine[];
  rebuilt: boolean;
  costEstimated: boolean;
};

export type ProductChangesData = {
  month: string;
  from: string;
  to: string;
  rows: ProductChangeRow[];
};

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? Math.round(x) : 0;
};

export function buildProductChanges(input: {
  month: string;
  from: string;
  to: string;
  events: readonly PcEventRow[];
  orders: readonly PcOrder[];
  staffNames: ReadonlyMap<string, string>;
}): ProductChangesData {
  const orderOf = new Map(input.orders.map((o) => [o.doc_no, o]));
  const rows: ProductChangeRow[] = [];
  for (const e of input.events) {
    if (e.bucket !== 'SELLING' && e.bucket !== 'COST_ONLY') continue;
    const o = orderOf.get(e.so_doc_no);
    if (!o || String(o.status ?? '') === 'CANCELLED') continue;
    const money = {
      sellingBeforeSen: n(e.selling_before_sen), sellingAfterSen: n(e.selling_after_sen),
      costBeforeSen: n(e.cost_before_sen), costAfterSen: n(e.cost_after_sen),
    };
    const cov = changeCoverage(money);
    const id = o.salesperson_id ? String(o.salesperson_id) : null;
    rows.push({
      id: e.id,
      docNo: e.so_doc_no,
      soDate: o.so_date ? String(o.so_date).slice(0, 10) : null,
      customer: o.debtor_name ?? null,
      salesperson: id ? (input.staffNames.get(id) ?? o.agent ?? id) : (o.agent?.trim() || 'Unassigned'),
      imported: soIsMigratedShape(o.doc_no, o.linked_ac_docno),
      changeDay: String(e.change_day).slice(0, 10),
      changedAt: e.changed_at ?? null,
      route: e.route === 'AMENDMENT' ? 'AMENDMENT' : 'DIRECT',
      amendmentNos: [...(e.amendment_nos ?? [])],
      changedBy: [...(e.changed_by ?? [])],
      approvedBy: [...(e.approved_by ?? [])],
      types: [...(e.change_types ?? [])] as ProductChangeType[],
      bucket: e.bucket,
      ...money,
      ...cov,
      lines: [...(e.lines ?? [])],
      rebuilt: e.rebuilt === true,
      costEstimated: e.cost_estimated === true,
    });
  }
  rows.sort((a, b) => (a.changeDay !== b.changeDay ? (a.changeDay < b.changeDay ? -1 : 1) : a.docNo.localeCompare(b.docNo)));
  return { month: input.month, from: input.from, to: input.to, rows };
}
