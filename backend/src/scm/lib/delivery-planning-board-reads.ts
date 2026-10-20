// Delivery Planning board — OPEN-TIME read kick-off.
//
// The board assembles ~1,450 live-delivery SO rows per open (owner 2026-10-20
// "开得慢"). Four of its per-SO reads — live balance, line readiness, deliverable
// sums, and DOs — depend only on docNos and on nothing from one another, yet used
// to run as four SERIAL DB round-trips (over ~1,450 docs + ~7k lines), the bulk of
// the open latency. This kicks all four off together so they run CONCURRENTLY; the
// handler still awaits and processes each at its original site, so the assembled
// board is byte-identical — only the waiting is shared. They also overlap the
// product-catalog sub-reads the handler runs between them.
//
// Lives in its own module so the already-oversized delivery-planning.ts does not
// grow (file-size gate); it is pure (sb + docNos -> four in-flight promises) and
// is exercised end-to-end by delivery-planning.board.test.ts through the handler.
import { chunkIn } from './paginate-all';
import { boardDeliverableByDoc } from './board-deliverable';
import type { DeliveryOrderExecRow } from '../routes/delivery-planning-fields';

export function kickOffBoardReads(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- sb is the scm service client, mirrored from boardDeliverableByDoc
  sb: any,
  docNos: string[],
) {
  const liveBalanceReadP = chunkIn<{ doc_no: string | null; balance_sen_live: number | null }>(docNos, (batch, from, to) =>
    sb.from('mfg_sales_orders_with_payment_totals')
      .select('doc_no, balance_sen_live')
      .in('doc_no', batch).order('doc_no').range(from, to),
  );
  const itemRowsReadP = chunkIn<{
    doc_no: string; item_group: string | null; item_code: string | null;
    stock_status: string | null; cancelled: boolean | null; warehouse_id: string | null;
    branding: string | null; created_at: string | null;
  }>(docNos, (batch, from, to) =>
    sb.from('mfg_sales_order_items')
      .select('doc_no, item_group, item_code, stock_status, cancelled, warehouse_id, branding, created_at')
      .in('doc_no', batch)
      .eq('cancelled', false)
      .order('doc_no')
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to),
  );
  /* boardDeliverableByDoc THROWS on failure (the others resolve {data,error}); wrap
     it so the in-flight promise can never float as an unhandled rejection while the
     other reads run. The handler reproduces the 'delivered_sum' 500 at its await. */
  const deliverableReadP = boardDeliverableByDoc(sb, docNos).then(
    (r) => ({ ok: r } as const),
    (e) => ({ err: e } as const),
  );
  const doRowsReadP = chunkIn<DeliveryOrderExecRow>(docNos, (batch, from, to) =>
    sb.from('delivery_orders')
      .select('id, do_number, so_doc_no, status, driver_id, delivery_state, customer_delivery_date, do_date, delivered_at, pod_r2_key, pod_lat, time_range, time_confirmed, arrival_at, departure_at, shipout_date, customer_delivered_date, eta_arriving_port, delivery_substatus, arrives_em_warehouse_date, em_delivery_status, consignment_no, vessel_voyage, etd_port_klang, bs_delivery_date, esb_remarks, bs_remarks, ctn, em_delivered_date')
      .in('so_doc_no', batch).order('id').range(from, to),
  );
  return { liveBalanceReadP, itemRowsReadP, deliverableReadP, doRowsReadP };
}
