/* The Delivery Planning board's per-order facts (lines, deliverable sums, DOs,
   crew, trips, balances, PO numbers), as maps keyed by SO doc_no / DO id.

   Two loaders fill the SAME maps through the SAME folds, so the two can differ
   only in which raw rows they read, never in what is made of them:
     - loadSoBoardMapsRest: the PostgREST reads, moved verbatim out of
       routes/delivery-planning.ts (the board as it has always been read);
     - loadSoBoardMapsSql (delivery-board-sql.ts): one SQL statement.
   The switch between them is lib/delivery-board-source.ts. */
import type { Context } from 'hono';
import { chunkIn, paginateAll } from './paginate-all';
import { pgrestIn } from './pgrest-in-list';
import { scopeToCompany } from './companyScope';
import { noteDegradedRead } from './read-failure';
import { normCategory, type ReadinessLine } from './so-readiness';
import { attachLineCategories } from './so-readiness-category';
import { soPoLockedMany } from './so-po-lock';
import { loadAcExemptionExpiryByDoc } from './ac-exemption-expiry';
import type { kickOffBoardReads } from './delivery-planning-board-reads';
import { typedHeaderCrewByDo, type DoExecOut, type DeliveryOrderExecRow } from '../routes/delivery-planning-fields';
import type { Env, Variables } from '../env';

export type BoardItemRow = {
  doc_no: string; item_group: string | null; item_code: string | null;
  stock_status: string | null; cancelled: boolean | null; warehouse_id: string | null;
  branding: string | null; created_at: string | null;
};
export type BoardProductRow = { code: string; category: string | null; branding: string | null };
export type BoardStopRow = { dp_no?: string | null; do_id?: string | null; trip_id?: string | null; tripId?: string | null; stop_no?: number | null; stopNo?: number | null; eta_offset_s?: number | null; etaOffsetS?: number | null };
export type BoardTripRow = { id: string; trip_no?: string | null; tripNo?: string | null; trip_date?: string | null; tripDate?: string | null; status?: string | null };
export type BoardCrewRow = {
  do_id: string;
  driver_1_id: string | null; driver_2_id: string | null;
  helper_1_id: string | null; helper_2_id: string | null;
  driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
  driver_2_name: string | null;
  helper_1_name: string | null; helper_2_name: string | null; lorry_plate: string | null;
  driver1Id?: string | null; driver2Id?: string | null; helper1Id?: string | null; helper2Id?: string | null;
};

export type CrewOut = {
  // legacy collapsed strings (kept for back-compat search / fallback)
  driver: string | null; helper: string | null; lorry: string | null;
  // expanded per-person fields (HC delivery-sheet columns, snapshot)
  driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
  driver_2_name: string | null;
  helper_1_name: string | null; helper_2_name: string | null;
  lorry_plate: string | null;
};
export type BoardTrip = { id: string; trip_no: string | null; trip_date: string | null; stop_no: number | null; eta_offset_s: number | null };
export type BoardDo = { id: string; doNumber: string; status: string };

export type ItemMaps = ReturnType<typeof foldItems>;
export type DoMaps = ReturnType<typeof foldDos>;

export type SoBoardMaps = ItemMaps & DoMaps & {
  liveBalanceByDoc: Map<string, number>;
  deliveredByDoc: Map<string, number>;
  remainingByDoc: Map<string, number>;
  dpNoByDoc: Map<string, string>;
  tripByDoc: Map<string, BoardTrip>;
  crewByDo: Map<string, CrewOut>;
  crewIdsByDo: Map<string, { driverIds: string[]; helperIds: string[] }>;
  poLockedDocs: Set<string>;
  poNosByDoc: Map<string, string[]>;
  acExpiryByDoc: Map<string, string>;
};

/* Per-line readiness + per-line warehouse + the SO-list-matching Branding pick.
   itemRows must arrive ordered (doc_no, line_no, created_at ASC) — IDENTICAL to
   the SO list's item fetch — so the FIRST line seen per doc_no is its earliest
   one. productRows = the catalog rows for the codes in view (company-scoped). */
export function foldItems(itemRows: BoardItemRow[], productRows: BoardProductRow[]) {
  const linesByDoc = new Map<string, ReadinessLine[]>();
  const warehousesByDoc = new Map<string, Set<string>>();
  const firstCat = new Map<string, string>();
  const firstBranding = new Map<string, string | null>();
  const firstItemCode = new Map<string, string | null>();
  for (const it of itemRows) {
    const dn = it.doc_no;
    if (!dn) continue;
    const arr = linesByDoc.get(dn) ?? [];
    arr.push({ item_group: it.item_group, item_code: it.item_code, stock_status: (it.stock_status ?? 'PENDING') as ReadinessLine['stock_status'], cancelled: it.cancelled });
    linesByDoc.set(dn, arr);
    if (it.warehouse_id) {
      const ws = warehousesByDoc.get(dn) ?? new Set<string>();
      ws.add(it.warehouse_id);
      warehousesByDoc.set(dn, ws);
    }
    if (!firstCat.has(dn)) {
      firstCat.set(dn, normCategory(it.item_group ?? ''));
      firstBranding.set(dn, it.branding ?? null);
      firstItemCode.set(dn, it.item_code ?? null);
    }
  }
  const productCategory = new Map<string, string>();
  const productBranding = new Map<string, string>();
  for (const p of productRows) {
    if (p.category) productCategory.set(p.code, normCategory(p.category));
    if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
  }
  const resolveLineCat = (code: string | null, group: string): string =>
    (code ? productCategory.get(code) : undefined) ?? normCategory(group);
  /* isServiceLine's strongest signal onto the lines — no extra read. See lib/so-readiness-category.ts. */
  attachLineCategories(linesByDoc.values(), productCategory);
  const MAIN_CATS = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
  /* First MAIN line per doc (catalog-resolved); falls back to the earliest line
     above when an SO has no sofa/bedframe/mattress line. */
  const repCat = new Map<string, string>();
  const repBranding = new Map<string, string | null>();
  const repCode = new Map<string, string | null>();
  for (const it of itemRows) {
    const dn = it.doc_no;
    if (!dn || repCat.has(dn)) continue;
    const cat = resolveLineCat(it.item_code, it.item_group ?? '');
    if (MAIN_CATS.has(cat)) {
      repCat.set(dn, cat);
      repBranding.set(dn, it.branding ?? null);
      repCode.set(dn, it.item_code ?? null);
    }
  }
  return { linesByDoc, warehousesByDoc, firstCat, firstBranding, firstItemCode, productBranding, repCat, repBranding, repCode };
}

/** The item codes whose catalog rows foldItems needs. */
export function itemCodesOf(itemRows: BoardItemRow[]): string[] {
  const all = new Set<string>();
  for (const it of itemRows) if (it.doc_no && it.item_code) all.add(it.item_code);
  return [...all];
}

/* DOs per SO (non-DRAFT/CANCELLED), oldest first, so the LAST is the newest: its
   crew and HC exec fields are the ones the row shows. dual-read camelCase (the
   pg driver camelCases result columns). */
export function foldDos(doRowsRaw: DeliveryOrderExecRow[]) {
  const doByDoc = new Map<string, BoardDo[]>();
  const doDriverById = new Map<string, string | null>();
  const doExecByDoc = new Map<string, DoExecOut>();
  const doIds: string[] = [];
  const typedCrewByDo = typedHeaderCrewByDo(doRowsRaw); // a DO-form typed driver with no crew row
  for (const d of doRowsRaw) {
    const st = (d.status ?? '').toUpperCase();
    if (st === 'DRAFT' || st === 'CANCELLED') continue;  // exclude uncommitted / voided
    const dn = d.so_doc_no ?? '';
    if (!dn) continue;
    const arr = doByDoc.get(dn) ?? [];
    arr.push({ id: d.id, doNumber: d.do_number ?? '—', status: st });
    doByDoc.set(dn, arr);
    doIds.push(d.id);
    doDriverById.set(d.id, d.driverId ?? d.driver_id ?? null);
    // overwrite so the LAST DO wins (matches the crew = latest-DO convention)
    doExecByDoc.set(dn, {
      time_range: d.timeRange ?? d.time_range ?? null,
      time_confirmed: d.timeConfirmed ?? d.time_confirmed ?? null,
      arrival_at: d.arrivalAt ?? d.arrival_at ?? null,
      departure_at: d.departureAt ?? d.departure_at ?? null,
      shipout_date: d.shipoutDate ?? d.shipout_date ?? null,
      customer_delivered_date: d.customerDeliveredDate ?? d.customer_delivered_date ?? null,
      eta_arriving_port: d.etaArrivingPort ?? d.eta_arriving_port ?? null,
      delivery_substatus: d.deliverySubstatus ?? d.delivery_substatus ?? null,
      arrives_em_warehouse_date: d.arrivesEmWarehouseDate ?? d.arrives_em_warehouse_date ?? null,
      em_delivery_status: d.emDeliveryStatus ?? d.em_delivery_status ?? null,
      consignment_no: d.consignmentNo ?? d.consignment_no ?? null,
      vessel_voyage: d.vesselVoyage ?? d.vessel_voyage ?? null,
      etd_port_klang: d.etdPortKlang ?? d.etd_port_klang ?? null,
      bs_delivery_date: d.bsDeliveryDate ?? d.bs_delivery_date ?? null,
      esb_remarks: d.esbRemarks ?? d.esb_remarks ?? null,
      bs_remarks: d.bsRemarks ?? d.bs_remarks ?? null,
      ctn: d.ctn ?? null,
      em_delivered_date: d.emDeliveredDate ?? d.em_delivered_date ?? null,
      do_date: d.doDate ?? d.do_date ?? null,
      delivered_at: d.deliveredAt ?? d.delivered_at ?? null,
      pod_r2_key: d.podR2Key ?? d.pod_r2_key ?? null,
      pod_lat: d.podLat ?? d.pod_lat ?? null,
      // Real POD leaves a photo or a GPS fix; an evidence-free "mark delivered"
      // (office advance / QR scan) leaves neither.
      has_pod: (d.podR2Key ?? d.pod_r2_key) != null || (d.podLat ?? d.pod_lat) != null,
    });
  }
  return { doByDoc, doDriverById, doExecByDoc, doIds, typedCrewByDo };
}

/* DP NUMBER and live trip per SO, both read back from the trip_stops keyed on
   the SO's DOs (an SO reaches a trip only via its DO: scm.mfg_sales_orders has no
   `id`, so trip_stops.so_id never points at one). Last write wins = the most
   recent schedule. A CANCELLED trip is no arrangement. */
export function foldStops(doByDoc: Map<string, BoardDo[]>, stopRows: BoardStopRow[], tripRows: BoardTripRow[]) {
  const dpNoByDoc = new Map<string, string>();
  const tripByDoc = new Map<string, BoardTrip>();
  const docByDoId = new Map<string, string>();
  for (const [dn, arr] of doByDoc) for (const d of arr) docByDoId.set(d.id, dn);
  for (const s of stopRows) {
    if (s.dp_no == null) continue;
    const no = s.dp_no;
    if (!no) continue;
    const dn = (s.do_id && docByDoId.get(s.do_id)) || null;
    if (dn) dpNoByDoc.set(dn, no);
  }
  const liveTripById = new Map<string, { id: string; trip_no: string | null; trip_date: string | null }>();
  for (const t of tripRows) {
    if (String(t.status ?? '').toUpperCase() === 'CANCELLED') continue;
    liveTripById.set(String(t.id), {
      id: String(t.id),
      trip_no: (t.tripNo ?? t.trip_no ?? null) as string | null,
      trip_date: (t.tripDate ?? t.trip_date ?? null) as string | null,
    });
  }
  for (const s of stopRows) {
    const tripId = (s.tripId ?? s.trip_id) as string | null;
    const trip = tripId ? liveTripById.get(tripId) : undefined;
    const dn = (s.do_id && docByDoId.get(s.do_id)) || null;
    if (dn && trip) tripByDoc.set(dn, {
      ...trip,
      stop_no: (s.stopNo ?? s.stop_no ?? null) as number | null,
      eta_offset_s: (s.etaOffsetS ?? s.eta_offset_s ?? null) as number | null,
    });
  }
  return { dpNoByDoc, tripByDoc };
}

/** The stops' trip ids, for the trips read. */
export function stopTripIds(stopRows: BoardStopRow[]): string[] {
  return [...new Set(stopRows.map((s) => (s.tripId ?? s.trip_id) as string | null).filter((x): x is string => !!x))];
}

/* Crew snapshot per DO (names for display) and crew ids (the row scope). */
export function foldCrew(crewRows: BoardCrewRow[]) {
  const crewByDo = new Map<string, CrewOut>();
  const crewIdsByDo = new Map<string, { driverIds: string[]; helperIds: string[] }>();
  for (const cr of crewRows) {
    crewIdsByDo.set(cr.do_id, {
      driverIds: [cr.driver1Id ?? cr.driver_1_id, cr.driver2Id ?? cr.driver_2_id].filter((x): x is string => !!x),
      helperIds: [cr.helper1Id ?? cr.helper_1_id, cr.helper2Id ?? cr.helper_2_id].filter((x): x is string => !!x),
    });
    crewByDo.set(cr.do_id, {
      driver: [cr.driver_1_name, cr.driver_2_name].filter(Boolean).join(' / ') || null,
      helper: [cr.helper_1_name, cr.helper_2_name].filter(Boolean).join(' / ') || null,
      lorry: cr.lorry_plate ?? null,
      driver_1_name: cr.driver_1_name ?? null,
      driver_1_ic: cr.driver_1_ic ?? null,
      driver_1_contact: cr.driver_1_contact ?? null,
      driver_2_name: cr.driver_2_name ?? null,
      helper_1_name: cr.helper_1_name ?? null,
      helper_2_name: cr.helper_2_name ?? null,
      lorry_plate: cr.lorry_plate ?? null,
    });
  }
  return { crewByDo, crewIdsByDo };
}

type BoardCtx = Context<{ Bindings: Env; Variables: Variables }>;
export type SoBoardHeader = { doc_no: string | null; company_id: number | null; linked_ac_docno?: string | null; linkedAcDocno?: string | null };

/* The PostgREST loader: the board's original reads, in their original order and
   with their original failure modes (delivered_sum fails the board; the others
   degrade). The four per-SO reads and the PO-number walk were kicked off by the
   handler, so they overlap the sub-board reads exactly as before. */
export async function loadSoBoardMapsRest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client
  sb: any,
  c: BoardCtx,
  input: {
    docNos: string[]; soRows: SoBoardHeader[]; display: boolean;
    reads: ReturnType<typeof kickOffBoardReads>;
    poNosByDocP: Promise<{ ok: Map<string, string[]> } | { err: unknown }>;
    lap: (name: string) => void;
  },
): Promise<{ ok: SoBoardMaps } | { stage: string; err: unknown }> {
  const { docNos, soRows, display, reads, lap } = input;
  /* LIVE balance per SO — same source of truth as the SO list Balance column
     (mfg_sales_orders_with_payment_totals.balance_sen_live). VIEW-TRAP: only the
     two view-native columns are read here (backend/docs/scm-view-trap-coe.md). */
  const liveBalanceByDoc = new Map<string, number>();
  {
    const { data: balRows, error: balErr } = await reads.liveBalanceReadP; lap('dp-balances');
    noteDegradedRead('live_balance', balErr);
    for (const b of balRows) {
      if (b.doc_no != null && b.balance_sen_live != null) liveBalanceByDoc.set(String(b.doc_no), Number(b.balance_sen_live));
    }
  }
  const { data: itemRowsRaw, error: itemErr } = await reads.itemRowsReadP; lap('dp-items');
  noteDegradedRead('so_lines', itemErr);
  /* Catalog category + branding by item_code — the SAME product-branding fetch
     the SO list runs, chunked by the codes in view (bounded .in). */
  const prodAll: BoardProductRow[] = [];
  {
    const codeList = itemCodesOf(itemRowsRaw);
    for (let i = 0; i < codeList.length; i += 300) {
      const chunk = codeList.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows, error: prodErr } = await paginateAll<BoardProductRow>((from, to) =>
        scopeToCompany(pgrestIn(sb.from('mfg_products').select('code, category, branding'), 'code', chunk), c).range(from, to),
      ); lap('dp-products');
      noteDegradedRead('products', prodErr);
      prodAll.push(...(prodRows ?? []));
    }
  }
  const items = foldItems(itemRowsRaw, prodAll);

  const dRes = await reads.deliverableReadP; lap('dp-deliverable');
  if ('err' in dRes) return { stage: 'delivered_sum', err: dRes.err };
  const { deliveredByDoc, remainingByDoc } = dRes.ok;

  const { data: doRowsRaw, error: doErr } = await reads.doRowsReadP; lap('dp-dos');
  noteDegradedRead('do_headers', doErr);
  const dos = foldDos(doRowsRaw);

  /* Best-effort like before: a failed stop/trip read leaves dp_no / trip null. */
  let stops: ReturnType<typeof foldStops> = { dpNoByDoc: new Map(), tripByDoc: new Map() };
  try {
    if (dos.doIds.length) {
      const { data: stopRows, error: stopErr } = await chunkIn<BoardStopRow>(dos.doIds, (batch, from, to) => sb.from('trip_stops')
        .select('dp_no, do_id, trip_id, stop_no, eta_offset_s').in('do_id', batch)
        .order('do_id').range(from, to)); lap('dp-trip-stops');
      noteDegradedRead('trip_stops', stopErr);
      const tripIds = stopTripIds(stopRows);
      let tripRows: BoardTripRow[] = [];
      if (tripIds.length) {
        const trips = await chunkIn<BoardTripRow>(tripIds, (batch, from, to) => sb.from('trips')
          .select('id, trip_no, trip_date, status').in('id', batch).order('id').range(from, to)); lap('dp-trips');
        noteDegradedRead('trips', trips.error);
        tripRows = trips.data;
      }
      stops = foldStops(dos.doByDoc, stopRows, tripRows);
    }
  } catch { /* leave the maps empty — rows render dp_no / trip null */ }

  let crew: ReturnType<typeof foldCrew> = { crewByDo: new Map(), crewIdsByDo: new Map() };
  if (dos.doIds.length > 0) {
    const { data: crewRows, error: crewErr } = await chunkIn<BoardCrewRow>(dos.doIds, (batch, from, to) =>
      sb.from('delivery_order_crew')
        .select('do_id, driver_1_id, driver_2_id, helper_1_id, helper_2_id, driver_1_name, driver_1_ic, driver_1_contact, driver_2_name, helper_1_name, helper_2_name, lorry_plate')
        .in('do_id', batch).order('do_id').range(from, to),
    ); lap('dp-crew');
    noteDegradedRead('do_crew', crewErr);
    crew = foldCrew(crewRows);
  }
  /* PO lock per row: ONE batched chain for the whole board (soPoLockedMany). */
  const poLockedDocs = await soPoLockedMany(sb, display ? docNos : []); lap('dp-po-locked');
  const poNosRes = await input.poNosByDocP; // "PO No." column (lib/planning-po-nos.ts), kicked off right after soRows
  if ('err' in poNosRes) throw poNosRes.err; lap('dp-po-nos');
  // Read for counts_only too: the expiry decides Overdue (derivePlanningState), so the tab counts need it.
  const acExpiryByDoc = await loadAcExemptionExpiryByDoc(sb, c, soRows); lap('dp-ac-exemption');
  return { ok: { liveBalanceByDoc, ...items, deliveredByDoc, remainingByDoc, ...dos, ...stops, ...crew, poLockedDocs, poNosByDoc: poNosRes.ok, acExpiryByDoc } };
}
