/**
 * The HC Delivery sheet's Service-Case (ASSR) leg feed — the SQL and row shape.
 *
 * A Service Case's three physical logistics legs — inspection, pickup and
 * delivery-back — belong on the delivery sheet ONLY when OUR OWN team drives
 * them (owner 2026-09-17). The gate is per leg, on `assr_cases`:
 *
 *   INSPECT  : inspection_by = 'own'      AND inspection_visit_at IS NOT NULL
 *   PICKUP   : pickup_by     = 'customer' AND customer_pickup_at  IS NOT NULL
 *   DELIVERY : delivery_by   = 'own'      AND do_date             IS NOT NULL
 *
 * A supplier / 3PL / not-yet-confirmed leg is never emitted — the own-team
 * marker IS the confirmation to sync.
 *
 * This mirrors the Delivery Planning board's leg model
 * (`scm/lib/assr-board-scope.ts` `assrBoardUnionSql`) but is DELIBERATELY
 * own-team-gated where the board shows every dated leg: the owner ruled the
 * board stays as-is and only the sheet is gated, so the two surfaces
 * intentionally differ for now.
 *
 * One case yields up to three leg records; each is emitted in the SAME field
 * shape the sheet's regional-tab writer already consumes for Sales Orders
 * (`reference/Helper.gs` writeDataToTargetSheet), keyed on the ASSR Case
 * linkage's own convention — col B `DocNo = "<S/O>-<SERVICE|PICKUP|INSPECTION>"`
 * and col C (`TransferTo`) the ASSR number — so `syncDeliveryDateToASSR` can
 * write a scheduled date back to the case, and an ERP-pulled leg lands on the
 * same row an old Farra edit would have, not a duplicate. SERVICE is the
 * delivery-back leg's word (see LEG_KEY_WORD).
 *
 * `assr_cases` lives in the PUBLIC schema (raw `env.DB` SQL), not `scm`.
 *
 * Kept free of Hono so the SQL runs in tests-pg against real Postgres and the
 * mapper runs in a plain unit test.
 */
import { LOCATION_MAP } from "../services/autocount-master-maps";
import { bookSpellingOrOwn } from "../services/autocount-writeback";
import { tidy } from "../services/autocount-address-fit";
import { caseAddressFourLines } from "../scm/shared/assr-case-address";
import { sheetRegion, sheetStateSpelling, type DeliverySheetRecord } from "./delivery-sheet-feed";

export type AssrLegKind = "INSPECT" | "PICKUP" | "DELIVERY";

/** One case row as the feed SQL returns it. Every date is `::text` for the same
 *  reason as the SO feed: postgres.js leaves `date`/text as strings but turns
 *  `timestamptz` into Date objects, and the sheet wants strings. */
export type AssrFeedRow = {
  assr_no: string;
  doc_no: string | null;
  complained_date: string | null;
  ref_no: string | null;
  po_no: string | null;
  status: string | null;
  stage: string | null;
  customer_name: string | null;
  phone: string | null;
  location: string | null;
  sales_agent: string | null;
  delivery_order: string | null;
  addr1: string | null;
  addr2: string | null;
  addr3: string | null;
  addr4: string | null;
  inspection_by: string | null;
  inspection_visit_at: string | null;
  pickup_by: string | null;
  customer_pickup_at: string | null;
  delivery_by: string | null;
  do_date: string | null;
  /** The case's own Postcode / City / State (assr_case_address, owner 2026-11-17). */
  case_postcode: string | null;
  case_city: string | null;
  case_state: string | null;
  customer_country: string | null;
  so_postcode: string | null;
  so_city: string | null;
  so_state: string | null;
  last_modified_text: string;
};

/** A leg emitted to the sheet: the SO record fields the writer needs, plus the
 *  leg discriminator (`Kind`) the Apps Script can group / colour by. */
export type AssrLegRecord = DeliverySheetRecord & { Kind: AssrLegKind };

/**
 * Binds, in order: ?1 since (timestamptz text), ?2 limit.
 *
 * NOT company-scoped (owner 2026-10-01: a Service Case is not split HOUZS / 2990).
 * `assr_cases.company_id` follows the creator's active company, so a HOUZS order's
 * case raised under 2990 (ASSR/2608-016, SO-012823) never reached the sheet.
 *
 * Open cases (`closed_at` / `archived_at` NULL) carrying at least one OWN-TEAM
 * leg with a date, changed since the cursor. Ordered by the cursor so the page
 * is resumable; the LIMIT is a CASE count (each expands to up to three legs).
 *
 * `updated_at` is the whole cursor: every leg field lives on `assr_cases` and
 * `PATCH /api/assr/:id` stamps `updated_at`, so a leg's own-team flag or date
 * changing always moves it — no GREATEST() over children is needed (unlike the
 * SO feed, whose payments and DOs do not touch the header).
 *
 * `assr_cases.updated_at` is stored as TEXT in production (not timestamptz), so
 * the cursor predicate and ORDER BY cast it: comparing the raw text column
 * against `?2::timestamptz` is `text > timestamptz`, which Postgres rejects
 * (42883), and the route surfaced that as a 502 the first time the sheet
 * actually pulled this feed. The pg fixture mirrors the TEXT column so the cast
 * is under test. Every `updated_at` is qualified `assr_cases.updated_at`:
 * `assr_case_address` (joined for the case's own postcode / city / state) also
 * has an `updated_at`, so a bare reference is ambiguous (42702) and 502s both
 * this feed and /em-transporter — the fixture gives the address table its own
 * `updated_at` so that ambiguity is under test.
 *
 * `customer_country` comes from the linked Sales Order: a Singapore case's
 * address line 3 often lacks the word (locality-master addresses read "600314
 * Jurong East"), so the region needs the SO's country (BUG-52's leg twin).
 * Exact doc_no first, then the AutoCount number. The same order also lends its
 * postcode / city / state: a case often holds its whole address in addr1 with
 * addr3 / addr4 blank (ASSR/2610-013), so the sheet's Address 3 / Address 4
 * came out empty; caseTownLines fills ONLY the blank ones, and not at all when
 * the case names a different postcode (a service address is not always the
 * delivery address). This note lives HERE, not as a
 * `--` comment in the SQL: toPgPlaceholders reads an apostrophe in a SQL comment
 * as an open string and then leaves ?1 / ?2 unconverted.
 */
const ASSR_FEED_SELECT = `
SELECT assr_no,
       doc_no,
       complained_date,
       ref_no,
       po_no,
       status,
       stage,
       customer_name,
       phone,
       location,
       sales_agent,
       delivery_order,
       addr1, addr2, addr3, addr4,
       ca.postcode AS case_postcode, ca.city AS case_city, ca.state AS case_state,
       inspection_by, inspection_visit_at,
       pickup_by, customer_pickup_at,
       delivery_by, do_date,
       so.customer_country, so.so_postcode, so.so_city, so.so_state,
       assr_cases.updated_at::text AS last_modified_text
  FROM assr_cases
  LEFT JOIN assr_case_address ca ON ca.assr_id = assr_cases.id
  LEFT JOIN LATERAL (
       SELECT o.customer_country, o.postcode AS so_postcode, o.city AS so_city, o.customer_state AS so_state
         FROM scm.mfg_sales_orders o
        WHERE o.doc_no = assr_cases.doc_no OR o.linked_ac_docno = assr_cases.doc_no
        ORDER BY (o.doc_no = assr_cases.doc_no) DESC
        LIMIT 1) so ON TRUE
 WHERE closed_at IS NULL
   AND archived_at IS NULL`;

const ASSR_FEED_PAGE = `
   AND assr_cases.updated_at::timestamptz > ?1::timestamptz
 ORDER BY assr_cases.updated_at::timestamptz, assr_no
 LIMIT ?2`;

export const FEED_ASSR_LEGS_SQL = `${ASSR_FEED_SELECT}
   AND (
        (inspection_by = 'own'      AND inspection_visit_at IS NOT NULL) OR
        (pickup_by     = 'customer' AND customer_pickup_at  IS NOT NULL) OR
        (delivery_by   = 'own'      AND do_date             IS NOT NULL)
       )${ASSR_FEED_PAGE}`;

/**
 * Same binds and cursor as FEED_ASSR_LEGS_SQL, WITHOUT the own-team gate.
 *
 * BUG-54: a leg row reaches the sheet from the sheet's own ASSR linkage too
 * (ASSRDeliverySync.gs copies the case's phone once, when it makes the row), so
 * a case whose leg is not yet own-team AND dated was never re-sent and a phone
 * corrected in the ERP stayed stale on the sheet (ASSR/2608-064: inspection
 * 'own', no visit date). This feed only REFRESHES contact cells on rows the
 * sheet already has; the Apps Script never appends from it, so the owner's
 * own-team gate on which legs enter the sheet is unchanged.
 */
export const FEED_ASSR_CONTACTS_SQL = `${ASSR_FEED_SELECT}${ASSR_FEED_PAGE}`;

const blankToNull = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

/** The four address cells of a leg. A case with its own Postcode / City / State
 *  prints like a Sales Order: its lines, then "<postcode> <city>", then the state
 *  (caseAddressFourLines, never naming a part twice). Otherwise lines 1 / 2 as
 *  typed and caseTownLines for 3 / 4. */
export function caseSheetLines(row: AssrFeedRow): [string | null, string | null, string | null, string | null] {
  if (tidy(row.case_postcode) || tidy(row.case_city) || tidy(row.case_state)) {
    return caseAddressFourLines({ ...row, postcode: row.case_postcode, city: row.case_city, state: row.case_state });
  }
  const [addr3, addr4] = caseTownLines(row);
  return [blankToNull(row.addr1), blankToNull(row.addr2), addr3, addr4];
}

/** Address lines 3 / 4 for a leg with no Postcode / City / State of its own: the
 *  case's lines, else the linked order's "<postcode> <city>" / state, unless the
 *  case's address names a postcode the order does not have (then the order's
 *  town would describe another place). */
export function caseTownLines(row: AssrFeedRow): [string | null, string | null] {
  const own3 = tidy(row.addr3);
  const own4 = tidy(row.addr4);
  const postcode = tidy(row.so_postcode);
  const named = [row.addr1, row.addr2, row.addr3, row.addr4].flatMap((v) => (tidy(v) ?? "").match(/\b\d{5,6}\b/g) ?? []);
  if (named.length > 0 && (postcode == null || !named.includes(postcode))) return [own3, own4];
  const town = [postcode, tidy(row.so_city)].filter(Boolean).join(" ") || null;
  return [own3 ?? town, own4 ?? tidy(row.so_state)];
}

function legBase(row: AssrFeedRow): Omit<AssrLegRecord, "Kind" | "DocNo" | "TransferTo" | "Remark2" | "SalesExemptionExpiryDate"> {
  const salesLocation = bookSpellingOrOwn(row.location, LOCATION_MAP);
  const [addr1, addr2, addr3, rawAddr4] = caseSheetLines(row);
  return {
    ErpDocNo: row.assr_no,
    DocDate: blankToNull(row.complained_date),
    Ref: null,
    SOUDF_BRANDING: null,
    DebtorName: blankToNull(row.customer_name),
    Phone1: blankToNull(row.phone),
    SalesLocation: salesLocation,
    SalesAgent: blankToNull(row.sales_agent),
    Total: 0,
    SOUDF_BALANCE: 0,
    SOUDF_PDate: null,
    Remark4: null,
    Remark3: null,
    SOUDF_Note: null,
    SOUDF_ToPONo: blankToNull(row.po_no),
    InvAddr1: addr1,
    InvAddr2: addr2,
    InvAddr3: addr3,
    InvAddr4: sheetStateSpelling(rawAddr4),
    Attention: null,
    SOUDF_VENUE: null,
    ShipoutDate: null,
    DeliveryMessageStatus: null,
    DpRemark: null,
    Ctn: null,
    EmDeliveryStatus: null,
    Status: "PENDING",
    Ready: false,
    Region: sheetRegion(salesLocation, addr3, row.customer_country),
    LastModified: row.last_modified_text,
  };
}

const LEG_KEY_WORD: Record<AssrLegKind, "INSPECTION" | "PICKUP" | "SERVICE"> = {
  INSPECT: "INSPECTION",
  PICKUP: "PICKUP",
  DELIVERY: "SERVICE",
};

function legKey(row: AssrFeedRow, kind: AssrLegKind): string {
  return `${blankToNull(row.doc_no) ?? row.assr_no}-${LEG_KEY_WORD[kind]}`;
}

/** BUG-95: stages where the item is already back from the customer. Any edit
 *  stamps updated_at and re-sends the case, and the sheet appends a missing key,
 *  so a done pickup / inspection leg came back as a new row when Farra moved the
 *  case to Pending Delivery/Service. There is no "pickup done" field; the stage
 *  is the only marker. */
export const PAST_PICKUP_STAGES = new Set(["pending_item_ready", "pending_delivery_service", "completed", "voided"]);

export function toAssrLegRecords(row: AssrFeedRow): AssrLegRecord[] {
  const base = legBase(row);
  const ref = blankToNull(row.ref_no);
  const legRef = (kind: AssrLegKind): string => (ref ? `${ref}-${LEG_KEY_WORD[kind]}` : LEG_KEY_WORD[kind]);
  const legs: AssrLegRecord[] = [];
  const pickupPast = PAST_PICKUP_STAGES.has(row.stage ?? "");
  if (!pickupPast && row.inspection_by === "own" && blankToNull(row.inspection_visit_at)) {
    legs.push({ ...base, Kind: "INSPECT", DocNo: legKey(row, "INSPECT"), TransferTo: row.assr_no, Ref: legRef("INSPECT"), SOUDF_BRANDING: LEG_KEY_WORD.INSPECT, Remark2: "SERVICE INSPECTION", SalesExemptionExpiryDate: row.inspection_visit_at });
  }
  if (!pickupPast && row.pickup_by === "customer" && blankToNull(row.customer_pickup_at)) {
    legs.push({ ...base, Kind: "PICKUP", DocNo: legKey(row, "PICKUP"), TransferTo: row.assr_no, Ref: legRef("PICKUP"), SOUDF_BRANDING: LEG_KEY_WORD.PICKUP, Remark2: "SERVICE PICKUP", SalesExemptionExpiryDate: row.customer_pickup_at });
  }
  if (row.delivery_by === "own" && blankToNull(row.do_date)) {
    legs.push({ ...base, Kind: "DELIVERY", DocNo: legKey(row, "DELIVERY"), TransferTo: row.assr_no, Ref: legRef("DELIVERY"), SOUDF_BRANDING: LEG_KEY_WORD.DELIVERY, Remark2: "SERVICE DELIVERY", SalesExemptionExpiryDate: row.do_date });
  }
  return legs;
}

/** One case's contact cells, for the rows the sheet already carries. `Keys` are
 *  every leg key the case could own; the Apps Script writes only to a row whose
 *  col B is one of them AND whose col C is `AssrNo` (several cases can share an
 *  S/O, so the key alone could name another customer's row). */
export type AssrContactRecord = Pick<DeliverySheetRecord, "DebtorName" | "Phone1" | "InvAddr1" | "InvAddr2" | "InvAddr3" | "InvAddr4" | "LastModified"> & {
  AssrNo: string;
  Keys: string[];
};

export function toAssrContactRecord(row: AssrFeedRow): AssrContactRecord {
  const base = legBase(row);
  return {
    AssrNo: row.assr_no,
    Keys: (["INSPECT", "PICKUP", "DELIVERY"] as const).map((k) => legKey(row, k)),
    DebtorName: base.DebtorName,
    Phone1: base.Phone1,
    InvAddr1: base.InvAddr1,
    InvAddr2: base.InvAddr2,
    InvAddr3: base.InvAddr3,
    InvAddr4: base.InvAddr4,
    LastModified: base.LastModified,
  };
}
