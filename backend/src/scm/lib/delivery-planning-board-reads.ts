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
import type { Context } from 'hono';
import { chunkIn } from './paginate-all';
import { boardDeliverableByDoc } from './board-deliverable';
import { scopeToAllowedCompanies } from './companyScope';
import { assrBoardUnionSql } from './assr-board-scope';
import type { DeliveryOrderExecRow } from '../routes/delivery-planning-fields';
import type { Env, Variables } from '../env';

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

/* The three NON-SO sub-boards (ASSR legs, manual DP jobs, PMS project windows) are
   unioned onto the board AFTER the SO rows. Their first reads depend only on c / sb
   (not on any SO-board output), yet ran serially after the whole SO assembly — more
   open latency. Kick them off together with the per-SO reads above so they overlap.
   Each is wrapped ok/err: the handler awaits each inside the SAME try/catch that
   already guards its sub-board ("log + leave the other rows untouched"), re-throwing
   the err so that behaviour is byte-identical — only the waiting moves earlier.
   The query text is moved verbatim from the handler; delivery-planning.board.test.ts
   now seeds all three sub-boards so a move that broke one would fail there. */
const PROJECT_UNION_SQL =
  `SELECT p.id AS id, p.code AS code, p.name AS name, p.brand AS brand,
              p.venue AS venue, p.venue_address AS venue_address, p.state AS state,
              p.setup_start_at     AS setup_start_at,
              p.dismantle_start_at AS dismantle_start_at,
              sd.name  AS setup_driver_name,     sl.plate AS setup_lorry_plate,
              dd.name  AS dismantle_driver_name, dl.plate AS dismantle_lorry_plate
         FROM projects p
         LEFT JOIN users   sd ON sd.id = p.setup_driver_user_id
         LEFT JOIN lorries sl ON sl.id = p.setup_lorry_id
         LEFT JOIN users   dd ON dd.id = p.dismantle_driver_user_id
         LEFT JOIN lorries dl ON dl.id = p.dismantle_lorry_id
        WHERE p.archived_at IS NULL
          AND (p.setup_start_at IS NOT NULL OR p.dismantle_start_at IS NOT NULL)`;

export function kickOffSubBoardReads(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- sb is the scm service client, as in kickOffBoardReads
  sb: any,
) {
  /* Each read is built AND awaited inside an async try/catch so a SYNCHRONOUS throw
     (e.g. c.env.DB absent — the handler used to call these inside the sub-board
     try/catch, which caught that) becomes an {err} result, never an unhandled throw
     out of this kick-off. The handler re-throws {err} inside the SAME try/catch that
     already guards each sub-board, so a failed read still just logs + leaves the
     other rows — byte-identical to before, only started earlier. */
  // Explicit lowercase aliases → deterministic snake_case result keys
  // (sidesteps any driver camelCasing). Only OPEN cases with a trigger date.
  const assrRowsP = (async () => {
    try {
      return { ok: await c.env.DB.prepare(assrBoardUnionSql(c)).all<{
        id: number | null; assr_no: string | null; company_id: number | null; status: string | null;
        customer_name: string | null; phone: string | null; location: string | null;
        customer_pickup_at: string | null; inspection_visit_at: string | null;
        inspection_by: string | null; do_date: string | null;
        addr1: string | null; addr2: string | null; addr3: string | null; addr4: string | null;
        so_state: string | null; so_postcode: string | null; so_country: string | null;
      }>() } as const;
    } catch (e) { return { err: e } as const; }
  })();

  const dpResP = (async () => {
    try {
      let dpQuery = sb.from('dp_orders')
        .select('id, dp_no, job_type, party_name, contact_phone, address1, address2, address3, address4, city, postcode, state, requested_date, status, trip_id')
        .is('so_doc_no', null).is('assr_case_id', null).is('do_id', null)
        .not('status', 'in', '("DELIVERED","CANCELLED")')
        .limit(1000);
      dpQuery = scopeToAllowedCompanies(dpQuery, c);
      return { ok: await dpQuery } as const;
    } catch (e) { return { err: e } as const; }
  })();

  const projRowsP = (async () => {
    try {
      return { ok: await c.env.DB.prepare(PROJECT_UNION_SQL).all<{
        id: number | null; code: string | null; name: string | null; brand: string | null;
        venue: string | null; venue_address: string | null; state: string | null;
        setup_start_at: string | null; dismantle_start_at: string | null;
        setup_driver_name: string | null; setup_lorry_plate: string | null;
        dismantle_driver_name: string | null; dismantle_lorry_plate: string | null;
      }>() } as const;
    } catch (e) { return { err: e } as const; }
  })();

  return { assrRowsP, dpResP, projRowsP };
}
