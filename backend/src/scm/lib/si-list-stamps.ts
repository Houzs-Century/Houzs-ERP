
export { stampOrderDeposit } from './si-order-deposit';

export async function stampSoDates(sb: any, rows: unknown): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const list = rows as Array<Record<string, unknown>>;
  const soDocNos = [...new Set(list.map((r) => r.so_doc_no as string | null).filter((d): d is string => !!d))];
  const byDoc = new Map<string, { processing_date: string | null; customer_delivery_date: string | null }>();
  if (soDocNos.length > 0) {
    const { data, error } = await sb.from('mfg_sales_orders')
      .select('doc_no, processing_date, customer_delivery_date').in('doc_no', soDocNos);
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

export async function stampDoNumber(sb: any, rows: unknown): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const list = rows as Array<Record<string, unknown>>;
  const doIds = [...new Set(list.map((r) => r.delivery_order_id as string | null).filter((d): d is string => !!d))];
  const byId = new Map<string, string>();
  if (doIds.length > 0) {
    const { data, error } = await sb.from('delivery_orders').select('id, do_number').in('id', doIds);
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
