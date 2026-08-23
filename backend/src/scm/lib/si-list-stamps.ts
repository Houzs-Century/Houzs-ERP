// ----------------------------------------------------------------------------
// si-list-stamps — the derived columns a page of Sales Invoice list rows needs
// that no column on `scm.sales_invoices` carries.
//
// Lifted out of routes/sales-invoices.ts unchanged apart from the imports, for
// the reason so-payment-row.ts was: that file is over its size ceiling and may
// only shrink, and a third stamp was joining these two. Each one is ONE batched
// read for the whole page and mutates the rows in place.
//
// The third stamp — the ORDER's deposit — lives with its RULE in
// si-order-deposit.ts and is re-exported here so the list path has one import.
// ----------------------------------------------------------------------------

export { stampOrderDeposit } from './si-order-deposit';

/* Stamp the linked SO's dates onto SI list rows for the quick-view drawer:
   so_processing_date (the "Processing date" — mfg_sales_orders.processing_date,
   the one true user date, and since mig 0284 under the one name the UI, the API
   and every human already use) and so_customer_delivery_date
   (fallback for pre-snapshot SIs whose own customer_delivery_date is null).
   One batched read keyed by so_doc_no; mutates rows in place, same style as
   gateSiFinance. Called on BOTH list paths (legacy + paginated). */
export async function stampSoDates(sb: any, rows: unknown): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const list = rows as Array<Record<string, unknown>>;
  const soDocNos = [...new Set(list.map((r) => r.so_doc_no as string | null).filter((d): d is string => !!d))];
  const byDoc = new Map<string, { processing_date: string | null; customer_delivery_date: string | null }>();
  if (soDocNos.length > 0) {
    const { data, error } = await sb.from('mfg_sales_orders')
      .select('doc_no, processing_date, customer_delivery_date').in('doc_no', soDocNos);
    /* Bound and LOGGED rather than discarded. The rows still fall through to
       null dates — these are display-only columns and a blip here must not 500
       the invoice list — but "the read failed" and "the order has no dates" are
       different facts, and until 2026-08-23 nothing could tell them apart. */
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[si-list-stamps] SO date read failed — rows show no processing/delivery date:', error.message);
    }
    for (const s of ((data ?? []) as Array<{ doc_no: string | null; processing_date: string | null; customer_delivery_date: string | null }>)) {
      if (s.doc_no) byDoc.set(s.doc_no, { processing_date: s.processing_date ?? null, customer_delivery_date: s.customer_delivery_date ?? null });
    }
  }
  for (const r of list) {
    const so = byDoc.get((r.so_doc_no as string | null) ?? '');
    r.so_processing_date = so?.processing_date ?? null;
    r.so_customer_delivery_date = so?.customer_delivery_date ?? null;
  }
}

/* Convert-from column (display-only, audit R8): the SI header stores the source
   Delivery Order only as a UUID (delivery_order_id) — there is no do_doc_no
   column — so no screen can show a readable "From DO" without this resolve.
   One batched read, mutates rows in place. Both list paths AND the detail. */
export async function stampDoNumber(sb: any, rows: unknown): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const list = rows as Array<Record<string, unknown>>;
  const doIds = [...new Set(list.map((r) => r.delivery_order_id as string | null).filter((d): d is string => !!d))];
  const byId = new Map<string, string>();
  if (doIds.length > 0) {
    const { data, error } = await sb.from('delivery_orders').select('id, do_number').in('id', doIds);
    // Same contract as the stamp above: fail SOFT, but never silently.
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[si-list-stamps] DO number read failed — rows show no source DO:', error.message);
    }
    for (const d of ((data ?? []) as Array<{ id: string | null; do_number: string | null }>)) {
      if (d.id && d.do_number) byId.set(d.id, d.do_number);
    }
  }
  for (const r of list) {
    r.do_number = byId.get((r.delivery_order_id as string | null) ?? '') ?? null;
  }
}
