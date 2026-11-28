
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { canViewScmFinance } from './houzs-perms';
import { resolveDoHeaderSources, resolveDoSourceSos } from './source-po-trace';
import { doLifecycleFrom, type DoLifecycle, type DoLifecycleDr, type DoLifecycleSi } from './do-lifecycle';

export type DoListRowDeps = {
  financeKeys: readonly string[];
};

export async function buildDoListRows(
  sb: Variables['supabase'],
  c: Context<{ Bindings: Env; Variables: Variables }>,
  rows: Array<{ id: string } & Record<string, unknown>>,
  deps: DoListRowDeps,
): Promise<Array<{ id: string } & Record<string, unknown>>> {
  const DO_FINANCE_KEYS = deps.financeKeys;
  const childIds = new Set<string>();
  const invoicedSiByDo = new Map<string, Set<string>>();
  const returnedDrByDo = new Map<string, Set<string>>();
  let lifecycleByDo = new Map<string, DoLifecycle>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const [drRes, siRes] = await Promise.all([
      sb.from('delivery_returns').select('delivery_order_id, return_number, return_date, created_at').in('delivery_order_id', ids).neq('status', 'CANCELLED'),
      sb.from('sales_invoices').select('delivery_order_id, invoice_number, invoice_date, created_at').in('delivery_order_id', ids).neq('status', 'CANCELLED'),
    ]);
    const drRows = (drRes.data ?? []) as Array<DoLifecycleDr & { return_number: string | null }>;
    const siRows = (siRes.data ?? []) as Array<DoLifecycleSi & { invoice_number: string | null }>;
    lifecycleByDo = doLifecycleFrom([...new Set(ids.filter(Boolean))], siRows, drRows);
    for (const d of drRows) {
      if (!d.delivery_order_id) continue;
      childIds.add(d.delivery_order_id);
      if (d.return_number) {
        const set = returnedDrByDo.get(d.delivery_order_id) ?? new Set<string>();
        set.add(d.return_number);
        returnedDrByDo.set(d.delivery_order_id, set);
      }
    }
    for (const s of siRows) {
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
  const sourceSosByDo = rows.length > 0
    ? await resolveDoSourceSos(sb, rows.map((r) => r.id))
    : new Map<string, string[]>();
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
      invoiced_si_nos: sortedNos(invoicedSiByDo.get(r.id)),
      return_nos: sortedNos(returnedDrByDo.get(r.id)),
    };
    if (!showFinance) for (const k of DO_FINANCE_KEYS) delete row[k];
    return row;
  });
  return deliveryOrders as Array<{ id: string } & Record<string, unknown>>;
}
