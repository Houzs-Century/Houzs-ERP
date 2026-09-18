// ----------------------------------------------------------------------------
// do-list-rows — the Delivery Order LIST's per-row fields, built for a page of
// header rows the list's own filter already matched.
//
// Lifted VERBATIM out of GET /delivery-orders-mfg (routes/delivery-orders-mfg.ts)
// on 2026-09-15 so the list page and the export (GET
// /delivery-orders-mfg/export/rows) produce the identical row shape. The
// comments below are the handler's own, moved with the code. The reads are sized
// for ONE page of rows (several send every row id in one request), so a caller
// with more rows passes them in pages. The two things the route owns —
// computeDoLifecycle and its finance-key list — are passed in, so this module
// never imports the route that imports it.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { canViewScmFinance } from './houzs-perms';
import { resolveDoHeaderSources, resolveDoSourceSos } from './source-po-trace';

export type DoListRowDeps = {
  computeDoLifecycle: (sb: unknown, ids: string[]) => Promise<Map<string, 'shipped' | 'invoiced' | 'returned'>>;
  financeKeys: readonly string[];
};
type DoLifecycle = 'shipped' | 'invoiced' | 'returned';

export async function buildDoListRows(
  sb: Variables['supabase'],
  c: Context<{ Bindings: Env; Variables: Variables }>,
  rows: Array<{ id: string } & Record<string, unknown>>,
  deps: DoListRowDeps,
): Promise<Array<{ id: string } & Record<string, unknown>>> {
  const computeDoLifecycle = deps.computeDoLifecycle;
  const DO_FINANCE_KEYS = deps.financeKeys;
  /* Tier 2 downstream-lock — one extra batched read per doc set: pull every
     non-cancelled DR/SI that points back to a listed DO and stamp has_children
     on the row. The list grid uses this to hide Edit / Cancel actions on DOs
     that are downstream-locked (mirrors computeGrnFlags in lib/grn-consumption-flags). */
  const childIds = new Set<string>();
  /* DISPLAY-ONLY transfer-to columns (audit R8): the SI number(s) each DO was
     invoiced into and the DR number(s) returned against it. Derived from the
     SAME batched child reads that already stamp has_children — one added column
     in each select, no extra round-trip, and never touches DO status/lifecycle
     (which stays computeDoLifecycle below). */
  const invoicedSiByDo = new Map<string, Set<string>>();
  const returnedDrByDo = new Map<string, Set<string>>();
  let lifecycleByDo = new Map<string, DoLifecycle>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const [drRes, siRes, lc] = await Promise.all([
      sb.from('delivery_returns').select('delivery_order_id, return_number').in('delivery_order_id', ids).neq('status', 'CANCELLED'),
      sb.from('sales_invoices').select('delivery_order_id, invoice_number').in('delivery_order_id', ids).neq('status', 'CANCELLED'),
      computeDoLifecycle(sb, ids),
    ]);
    lifecycleByDo = lc;
    for (const d of ((drRes.data ?? []) as Array<{ delivery_order_id: string | null; return_number: string | null }>)) {
      if (!d.delivery_order_id) continue;
      childIds.add(d.delivery_order_id);
      if (d.return_number) {
        const set = returnedDrByDo.get(d.delivery_order_id) ?? new Set<string>();
        set.add(d.return_number);
        returnedDrByDo.set(d.delivery_order_id, set);
      }
    }
    for (const s of ((siRes.data ?? []) as Array<{ delivery_order_id: string | null; invoice_number: string | null }>)) {
      if (!s.delivery_order_id) continue;
      childIds.add(s.delivery_order_id);
      if (s.invoice_number) {
        const set = invoicedSiByDo.get(s.delivery_order_id) ?? new Set<string>();
        set.add(s.invoice_number);
        invoicedSiByDo.set(s.delivery_order_id, set);
      }
    }
  }
  const sortedNos = (set: Set<string> | undefined): string[] =>
    set ? [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  /* Linked-SO Processing date (mfg_sales_orders.processing_date — the one true
     user date, one column since 0189 and one name since 0284).
     The DO quick-view drawer shows it next to the DO's own delivery
     date; one batched read keyed by so_doc_no, same pattern as the DR/SI child
     reads above. */
  const soProcByDoc = new Map<string, string | null>();
  {
    const soDocNos = [...new Set(rows.map((r) => r.so_doc_no as string | null).filter((d): d is string => !!d))];
    if (soDocNos.length > 0) {
      const { data: soRows } = await sb.from('mfg_sales_orders')
        .select('doc_no, processing_date').in('doc_no', soDocNos);
      for (const s of ((soRows ?? []) as Array<{ doc_no: string | null; processing_date: string | null }>)) {
        if (s.doc_no) soProcByDoc.set(s.doc_no, s.processing_date ?? null);
      }
    }
  }
  /* Source PO(s) each DO's goods shipped from (owner 2026-07-31): a DO/SI is a
     SALES-side doc, so it shows the durable batch_no = source-PO hard link, not
     an Assigned SO. ONE batched ledger pass across the page (the shared
     resolver — GRN-healed, adjustment-classified).
     2026-08-02 (2990-DO-2607-017): derived as the UNION OF THE DO'S OWN LINES'
     traces (resolveDoHeaderSources), never the raw byDo ledger rollup — the old
     rollup surfaced orphan ledger buckets (re-pointed consumptions / drifted
     variant keys) as phantom chips no item line could explain. Header ≡ ∪(lines)
     by construction now; the orphan buckets stay visible to the read-only check
     (check-so-source-trace.mjs), not to this cell. */
  const sourceTraceByDo = rows.length > 0
    ? await resolveDoHeaderSources(sb, rows.map((r) => r.id))
    : new Map<string, { pos: string[]; adjQty: number }>();
  /* The SOs this DO's LINES draw on — see resolveDoSourceSos. so_doc_no is a
     header LABEL (from-sos copies the first pick's SO), so a merged DO shows one
     source and hides the rest, and two DOs can appear to ship one Sales Order
     while sharing no quantity at all. */
  const sourceSosByDo = rows.length > 0
    ? await resolveDoSourceSos(sb, rows.map((r) => r.id))
    : new Map<string, string[]>();
  /* Finance gate — cost / margin / per-category subtotals reach ONLY a
     finance-viewer; stripped from every row otherwise. */
  const showFinance = canViewScmFinance(c);
  const deliveryOrders = rows.map((r) => {
    const row: Record<string, unknown> = {
      ...r,
      has_children: childIds.has(r.id),
      lifecycle_state: lifecycleByDo.get(r.id) ?? 'shipped',
      so_processing_date: soProcByDoc.get((r.so_doc_no as string | null) ?? '') ?? null,
      source_pos: sourceTraceByDo.get(r.id)?.pos ?? [],
      source_sos: sourceSosByDo.get(r.id) ?? [],
      source_adj: (sourceTraceByDo.get(r.id)?.adjQty ?? 0) > 0,
      // Transfer-to (display-only, audit R8): SI(s) invoiced / DR(s) returned.
      invoiced_si_nos: sortedNos(invoicedSiByDo.get(r.id)),
      return_nos: sortedNos(returnedDrByDo.get(r.id)),
    };
    if (!showFinance) for (const k of DO_FINANCE_KEYS) delete row[k];
    return row;
  });
  return deliveryOrders as Array<{ id: string } & Record<string, unknown>>;
}
