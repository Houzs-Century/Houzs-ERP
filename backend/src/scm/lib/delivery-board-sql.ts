/* The Delivery Planning board's reads as TWO SQL statements over Hyperdrive,
   instead of ~800-1,400 PostgREST calls (production 2026-11, p95 13.9 s).

   1. BOARD_HEAD_SQL: region master + state mapping + warehouses + the SO headers
      (status, company, ?docs and date-band filters). Was 4+ serial reads plus
      one per 1,000 headers.
   2. BOARD_DATA_SQL: every per-order fact for the doc numbers the board builds —
      lines, catalog, deliverable sums (linked + unlinked DO lines, returns),
      DOs, trip stops, trips, crew, live balances, PO lock, PO numbers, the
      AutoCount exemption expiry. Was one chunked read per ~80 doc numbers per
      table.

   ACCURACY. Each dataset is the same columns, filters and company predicates as
   the PostgREST read it replaces (named on each CTE), and is folded by the SAME
   functions (delivery-board-maps.ts) the PostgREST path uses; only the
   deliverable sum and the PO walks are re-folded here, from their pure parts
   (attributeUnlinkedDoLines, doCountsAsDelivered). Rows are serialised by
   Postgres json (json_agg), the same serialiser PostgREST uses, so a date, a
   timestamptz or a bigint reaches the fold as the same JSON value. Where the
   PostgREST read's ORDER decides a "last write wins", the chunked order is
   re-created (chunkRank) rather than assumed.

   COMPANY SCOPE. The caller's allowed companies filter the SO headers (as the
   PostgREST read did), the catalog is the active company (scopeToCompany), the
   PO-number walk is per company on all three tables (planningPoNosByDoc), and
   the AutoCount mirror is the allowed companies. Every other dataset is keyed
   through those company-scoped doc numbers, exactly as before. */
import type { Sql } from 'postgres';
import type { Context } from 'hono';
import { activeCompanyId, allowedCompanyIds } from './companyScope';
import { chunkSizeForUrl } from './paginate-all';
import { bandDateRanges, type BandParams } from './delivery-board-window';
import { regionConfigFromRows, type RegionConfig, type RegionRow, type StateRegionRow } from './delivery-board-regions';
import {
  foldItems, foldDos, foldStops, foldCrew,
  type BoardItemRow, type BoardProductRow, type BoardStopRow, type BoardTripRow, type BoardCrewRow, type SoBoardMaps, type SoBoardHeader,
} from './delivery-board-maps';
import { attributeUnlinkedDoLines, type UnlinkedDoLine } from './do-unlinked-coverage';
import { acExemptionExpiryByDoc, linkedAcDocByDoc } from './ac-exemption-expiry';
import { doCountsAsDelivered } from '../shared/do-shipped-states';
import type { DeliveryOrderExecRow } from '../routes/delivery-planning-fields';
import type { SoHeaderRow } from './delivery-board-so-rows';
import type { Env, Variables } from '../env';

type BoardCtx = Context<{ Bindings: Env; Variables: Variables }>;

const SO_COLS = 'doc_no, company_id, debtor_code, debtor_name, phone, branding, status, delivery_state, agent, salesperson_id, venue, customer_state, customer_country, customer_delivery_date, sales_exemption_expiry, amend_date_from_customer, amended_delivery_date, amend_reason, amend_reason_from_customer, processing_date, so_date, address1, address2, postcode, building_type, local_total_sen, balance_sen, possession_date, house_type, replacement_disposal, referral, ref, customer_so_no, delivery_message_status, disposal_request, dp_remark, linked_ac_docno';
const DO_COLS = 'id, do_number, so_doc_no, status, driver_id, driver_name, vehicle, delivery_state, customer_delivery_date, do_date, delivered_at, pod_r2_key, pod_lat, time_range, time_confirmed, arrival_at, departure_at, shipout_date, customer_delivered_date, eta_arriving_port, delivery_substatus, arrives_em_warehouse_date, em_delivery_status, consignment_no, vessel_voyage, etd_port_klang, bs_delivery_date, esb_remarks, bs_remarks, ctn, em_delivered_date, created_at';
const EFF = 'coalesce(amended_delivery_date, customer_delivery_date)';
/* $1 allowed companies (jsonb array, null = unresolved: no predicate), $2 ?docs (jsonb, null = all),
   $3 band ranges inside (jsonb [[lo,hi],...]), $4/$5 band 5 outside lo/hi. */
export const BOARD_HEAD_SQL = `
WITH so AS (
  SELECT ${SO_COLS}
    FROM scm.mfg_sales_orders
   WHERE status::text <> 'DRAFT' AND status::text <> 'CANCELLED'
     AND ($1::jsonb IS NULL OR company_id IN (SELECT jsonb_array_elements_text($1::jsonb)::bigint))
     AND ($2::jsonb IS NULL OR doc_no IN (SELECT jsonb_array_elements_text($2::jsonb)))
     AND ($3::jsonb IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements($3::jsonb) r WHERE ${EFF} BETWEEN (r->>0)::date AND (r->>1)::date))
     AND ($4::date IS NULL OR ${EFF} IS NULL OR ${EFF} < $4::date OR ${EFF} > $5::date)
)
SELECT
  (SELECT coalesce(json_agg(r ORDER BY r.sort_order, r.code), '[]'::json) FROM (SELECT id, code, name, sort_order, active FROM scm.delivery_planning_regions) r) AS regions,
  (SELECT coalesce(json_agg(m), '[]'::json) FROM (SELECT state_key, country, region_id FROM scm.state_delivery_regions) m) AS state_map,
  (SELECT coalesce(json_agg(w), '[]'::json) FROM (SELECT id, code, name FROM scm.warehouses) w) AS warehouses,
  (SELECT coalesce(json_agg(so ORDER BY so.customer_delivery_date ASC NULLS LAST, so.doc_no), '[]'::json) FROM so) AS so`;

/* $1 doc numbers (jsonb), $2 display (false for ?counts_only: the reads that feed
   only display columns and the row scope are skipped, as kickOffBoardReads does),
   $3 catalog scope ('company' | 'none' | 'open'), $4 active company, $5 PO-walk
   [doc, company] pairs (jsonb), $6 AutoCount book doc numbers (jsonb), $7 allowed
   companies (jsonb, null = unresolved). */
export const BOARD_DATA_SQL = `
WITH docs AS (SELECT DISTINCT d AS doc_no FROM jsonb_array_elements_text($1::jsonb) d),
-- kickOffBoardReads itemRowsReadP + soDeliverableRemaining's lines: non-cancelled lines.
items AS (
  SELECT id, doc_no, item_group, item_code, stock_status, cancelled, warehouse_id, branding, created_at, line_no, qty
    FROM scm.mfg_sales_order_items
   WHERE doc_no IN (SELECT doc_no FROM docs) AND cancelled = false
),
-- kickOffBoardReads doRowsReadP; also loadUnlinkedDoCoverage's DO headers.
dos AS (SELECT ${DO_COLS} FROM scm.delivery_orders WHERE so_doc_no IN (SELECT doc_no FROM docs)),
live_dos AS (SELECT id FROM dos WHERE $2::boolean AND upper(coalesce(status::text, '')) NOT IN ('DRAFT', 'CANCELLED') AND coalesce(so_doc_no, '') <> ''),
-- netDeliveredBySoItem: DO lines linked by so_item_id, with the parent DO status.
linked AS (
  SELECT l.id, l.so_item_id, l.qty, d.status AS parent_status, (d.id IS NOT NULL) AS has_parent
    FROM scm.delivery_order_items l LEFT JOIN scm.delivery_orders d ON d.id = l.delivery_order_id
   WHERE l.so_item_id IN (SELECT id FROM items)
),
-- loadUnlinkedDoCoverage: DO lines with no so_item_id under the orders' DOs.
unlinked AS (
  SELECT id, delivery_order_id, item_code, qty FROM scm.delivery_order_items
   WHERE so_item_id IS NULL AND delivery_order_id IN (SELECT id FROM dos)
),
-- soDeliverableRemaining step 3: returns against those DO lines, with the parent DR status.
rets AS (
  SELECT ri.do_item_id, ri.qty_returned, r.status AS parent_status, (r.id IS NOT NULL) AS has_parent
    FROM scm.delivery_return_items ri LEFT JOIN scm.delivery_returns r ON r.id = ri.delivery_return_id
   WHERE ri.do_item_id IN (SELECT id FROM linked UNION SELECT id FROM unlinked)
),
stops AS (SELECT dp_no, do_id, trip_id, stop_no, eta_offset_s FROM scm.trip_stops WHERE do_id IN (SELECT id FROM live_dos)),
-- soPoLockedMany: every line (cancelled too) -> PO line -> PO.
po_lock AS (
  SELECT DISTINCT i.doc_no, po.status
    FROM scm.mfg_sales_order_items i
    JOIN scm.purchase_order_items pi ON pi.so_item_id = i.id AND pi.purchase_order_id IS NOT NULL
    JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
   WHERE $2::boolean AND i.doc_no IN (SELECT doc_no FROM docs)
),
-- planningPoNosByDoc -> soConvertedPos: per company, company_id on all three tables.
pairs AS (SELECT p->>0 AS doc_no, (p->>1)::bigint AS cid FROM jsonb_array_elements($5::jsonb) p),
po_nos AS (
  SELECT pairs.cid, i.doc_no, po.id AS po_id, po.po_number, po.status
    FROM pairs
    JOIN scm.mfg_sales_order_items i ON i.doc_no = pairs.doc_no AND i.company_id = pairs.cid
    JOIN scm.purchase_order_items pi ON pi.so_item_id = i.id AND pi.purchase_order_id IS NOT NULL AND pi.company_id = pairs.cid
    JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = pairs.cid
   WHERE $2::boolean
)
SELECT
  (SELECT coalesce(json_agg(t ORDER BY t.doc_no, t.line_no ASC NULLS LAST, t.created_at, t.id), '[]'::json) FROM items t) AS items,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM (
     SELECT code, category, branding FROM scm.mfg_products
      WHERE code IN (SELECT item_code FROM items WHERE item_code IS NOT NULL)
        AND CASE $3::text WHEN 'company' THEN company_id = $4::bigint WHEN 'none' THEN false ELSE true END) t) AS products,
  (SELECT coalesce(json_agg(t ORDER BY t.created_at, t.id), '[]'::json) FROM dos t) AS dos,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM linked t) AS linked,
  (SELECT coalesce(json_agg(t ORDER BY t.id), '[]'::json) FROM unlinked t) AS unlinked,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM rets t) AS rets,
  (SELECT coalesce(json_agg(t ORDER BY t.do_id), '[]'::json) FROM stops t) AS stops,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT id, trip_no, trip_date, status FROM scm.trips WHERE id IN (SELECT trip_id FROM stops)) t) AS trips,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM (
     SELECT do_id, driver_1_id, driver_2_id, helper_1_id, helper_2_id, driver_1_name, driver_1_ic, driver_1_contact, driver_2_name, helper_1_name, helper_2_name, lorry_plate
       FROM scm.delivery_order_crew WHERE do_id IN (SELECT id FROM live_dos)) t) AS crew,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM (
     SELECT doc_no, balance_sen_live FROM scm.mfg_sales_orders_with_payment_totals WHERE $2::boolean AND doc_no IN (SELECT doc_no FROM docs)) t) AS balances,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM po_lock t) AS po_lock,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM po_nos t) AS po_nos,
  (SELECT coalesce(json_agg(t ORDER BY t.doc_no), '[]'::json) FROM (
     SELECT doc_no, expiry_date FROM public.sales_orders
      WHERE $2::boolean AND doc_no IN (SELECT jsonb_array_elements_text($6::jsonb))
        AND ($7::jsonb IS NULL OR company_id IN (SELECT jsonb_array_elements_text($7::jsonb)::bigint))) t) AS ac`;

export type BoardHead = {
  regionCfg: RegionConfig;
  warehouses: Array<{ id: string; code: string | null; name: string | null }>;
  soRows: SoHeaderRow[];
};

const jsonOrNull = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Round trip 1: region config, warehouses and the SO headers. */
export async function loadBoardHeadSql(
  sql: Sql,
  c: BoardCtx,
  input: { onlyDocs: string[] | null; band: BandParams; today: string },
): Promise<BoardHead> {
  const band = input.band && input.band !== 'invalid' ? bandDateRanges(input.band.band, input.today) : null;
  const rows = await sql.unsafe(BOARD_HEAD_SQL, [
    jsonOrNull(allowedCompanyIds(c) ?? null),
    jsonOrNull(input.onlyDocs),
    jsonOrNull(band?.inside ?? null),
    band?.outside?.[0] ?? null,
    band?.outside?.[1] ?? null,
  ] as never[]) as unknown as Array<{ regions: RegionRow[]; state_map: StateRegionRow[]; warehouses: BoardHead['warehouses']; so: SoHeaderRow[] }>;
  const row = rows.at(0);
  if (!row) throw new Error('board head query returned no row');
  return { regionCfg: regionConfigFromRows(row.regions, row.state_map), warehouses: row.warehouses, soRows: row.so };
}

type DataRow = {
  items: Array<BoardItemRow & { id: string; qty: number | null }>;
  products: BoardProductRow[];
  dos: DeliveryOrderExecRow[];
  linked: Array<{ id: string; so_item_id: string | null; qty: number | null; parent_status: string | null; has_parent: boolean }>;
  unlinked: Array<{ id: string; delivery_order_id: string; item_code: string | null; qty: number | null }>;
  rets: Array<{ do_item_id: string | null; qty_returned: number | null; parent_status: string | null; has_parent: boolean }>;
  stops: BoardStopRow[];
  trips: BoardTripRow[];
  crew: BoardCrewRow[];
  balances: Array<{ doc_no: string | null; balance_sen_live: number | null }>;
  po_lock: Array<{ doc_no: string | null; status: string | null }>;
  po_nos: Array<{ cid: number; doc_no: string; po_id: string; po_number: string | null; status: string | null }>;
  ac: Array<{ doc_no: string | null; expiry_date: string | null }>;
};

/* The batch each value lands in when chunkIn(values) splits it: the PostgREST
   read returns batch by batch, each batch in its own ORDER BY, so a "last row
   wins" fold over it depends on the batching. */
export function chunkRank(values: readonly string[]): Map<string, number> {
  const size = chunkSizeForUrl(values);
  const out = new Map<string, number>();
  values.forEach((v, i) => { if (!out.has(v)) out.set(v, Math.floor(i / size)); });
  return out;
}
const byRank = <T>(rows: T[], rank: Map<string, number>, key: (r: T) => string | null | undefined): T[] =>
  rows.map((r, i) => ({ r, i, k: rank.get(String(key(r) ?? '')) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.r);

/* soDeliverableRemaining folded down to the two sums the board reads. Per order,
   both are independent of the order lines and unlinked DO lines are visited in:
   attributeUnlinkedDoLines fills a (doc, item code) bucket greedily, so a bucket
   takes min(Σ unlinked, Σ open) whatever the order, and a return nets inside the
   same order either way. */
export type DeliverableRows = {
  items: Array<{ id: string; doc_no: string; item_code: string | null; qty: number | null }>;
  dos: Array<{ id: string; so_doc_no: string | null; status: string | null }>;
  linked: DataRow['linked'];
  unlinked: DataRow['unlinked'];
  rets: DataRow['rets'];
};
export function foldDeliverable(d: DeliverableRows) {
  const deliveredByDoc = new Map<string, number>();
  const remainingByDoc = new Map<string, number>();
  const lines = d.items.map((l) => ({ id: l.id, docNo: l.doc_no, itemCode: l.item_code, qty: Number(l.qty ?? 0) }));
  if (lines.length === 0) return { deliveredByDoc, remainingByDoc };
  const doLineToSoItem = new Map<string, string>();
  const deliveredBySoItem = new Map<string, number>();
  for (const l of d.linked) {
    if (!l.so_item_id || !l.has_parent) continue;
    if (!doCountsAsDelivered(l.parent_status)) continue;
    doLineToSoItem.set(l.id, l.so_item_id);
    deliveredBySoItem.set(l.so_item_id, (deliveredBySoItem.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
  }
  const docByDoId = new Map<string, string>();
  for (const h of d.dos) {
    if (!h.so_doc_no) continue;
    if (!doCountsAsDelivered(h.status)) continue;
    docByDoId.set(h.id, h.so_doc_no);
  }
  const unlinked: UnlinkedDoLine[] = [];
  for (const r of d.unlinked) {
    const docNo = docByDoId.get(r.delivery_order_id);
    if (docNo) unlinked.push({ id: r.id, docNo, itemCode: r.item_code, qty: Number(r.qty ?? 0) });
  }
  for (const a of attributeUnlinkedDoLines(lines, deliveredBySoItem, unlinked)) {
    doLineToSoItem.set(a.doLineId, a.soItemId);
    deliveredBySoItem.set(a.soItemId, (deliveredBySoItem.get(a.soItemId) ?? 0) + a.qty);
  }
  const returnedBySoItem = new Map<string, number>();
  for (const r of d.rets) {
    if (!r.do_item_id || !r.has_parent) continue;
    if ((r.parent_status ?? '').toUpperCase() === 'CANCELLED') continue;
    const soItemId = doLineToSoItem.get(r.do_item_id);
    if (!soItemId) continue;
    returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(r.qty_returned ?? 0));
  }
  for (const l of lines) {
    const delivered = deliveredBySoItem.get(l.id) ?? 0;
    const returned = returnedBySoItem.get(l.id) ?? 0;
    deliveredByDoc.set(l.docNo, (deliveredByDoc.get(l.docNo) ?? 0) + delivered);
    remainingByDoc.set(l.docNo, (remainingByDoc.get(l.docNo) ?? 0) + (l.qty - delivered + returned));
  }
  return { deliveredByDoc, remainingByDoc };
}

/** soConvertedPoNumbers per company (planningPoNosByDoc), from the walked rows. */
export function foldPoNos(rows: DataRow['po_nos'], companyOrder: number[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const cid of companyOrder) {
    const byDoc = new Map<string, Map<string, string>>();
    for (const r of rows) {
      if (Number(r.cid) !== cid) continue;
      if ((r.status ?? '').toUpperCase() === 'CANCELLED' || !r.po_number) continue;
      const m = byDoc.get(r.doc_no) ?? new Map<string, string>();
      m.set(r.po_id, r.po_number);
      byDoc.set(r.doc_no, m);
    }
    for (const [doc, m] of byDoc) {
      const sorted = [...m.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      out.set(doc, [...new Set(sorted)]);
    }
  }
  return out;
}

/** Round trip 2: every per-order fact for docNos, folded into the board's maps. */
export async function loadSoBoardMapsSql(
  sql: Sql,
  c: BoardCtx,
  input: { docNos: string[]; soRows: SoBoardHeader[]; display: boolean },
): Promise<SoBoardMaps> {
  const { docNos, display } = input;
  const soRows = display ? input.soRows : [];
  const active = activeCompanyId(c);
  const allowed = allowedCompanyIds(c);
  const catalogScope = active != null ? 'company' : allowed !== undefined ? 'none' : 'open';
  const companyOrder: number[] = [];
  const pairs: Array<[string, number]> = [];
  for (const r of soRows) {
    if (!r.doc_no || r.company_id == null) continue;
    const cid = Number(r.company_id);
    if (!Number.isFinite(cid)) continue;
    if (!companyOrder.includes(cid)) companyOrder.push(cid);
    pairs.push([String(r.doc_no), cid]);
  }
  const linkedAc = linkedAcDocByDoc(soRows);
  const rows = await sql.unsafe(BOARD_DATA_SQL, [
    JSON.stringify(docNos), display, catalogScope, active ?? null,
    JSON.stringify(pairs), JSON.stringify([...new Set(linkedAc.values())]), jsonOrNull(allowed ?? null),
  ] as never[]) as unknown as DataRow[];
  const row = rows.at(0);
  if (!row) throw new Error('board data query returned no row');

  const liveBalanceByDoc = new Map<string, number>();
  for (const b of row.balances) {
    if (b.doc_no != null && b.balance_sen_live != null) liveBalanceByDoc.set(String(b.doc_no), Number(b.balance_sen_live));
  }
  const items = foldItems(row.items, row.products);
  const { deliveredByDoc, remainingByDoc } = foldDeliverable(row);
  // The DO read was chunked on docNos, each batch ordered (created_at, id).
  const dos = foldDos(display ? byRank(row.dos, chunkRank(docNos), (d) => d.so_doc_no) : []);
  // The stop read was chunked on the live DO ids, each batch ordered by do_id.
  const live = new Set(dos.doIds);
  const stopRows = byRank(row.stops.filter((s) => !!s.do_id && live.has(s.do_id)), chunkRank(dos.doIds), (s) => s.do_id);
  const stops = foldStops(dos.doByDoc, stopRows, row.trips);
  const crew = foldCrew(row.crew.filter((r) => live.has(r.do_id)));
  const poLockedDocs = new Set<string>();
  for (const p of row.po_lock) if (p.doc_no && (p.status ?? '').toUpperCase() !== 'CANCELLED') poLockedDocs.add(p.doc_no);
  return {
    liveBalanceByDoc, ...items, deliveredByDoc, remainingByDoc, ...dos, ...stops, ...crew,
    poLockedDocs, poNosByDoc: foldPoNos(row.po_nos, companyOrder), acExpiryByDoc: acExemptionExpiryByDoc(linkedAc, row.ac),
  };
}
