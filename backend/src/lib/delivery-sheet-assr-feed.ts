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
import { sheetRegion, type DeliverySheetRecord } from "./delivery-sheet-feed";

export type AssrLegKind = "INSPECT" | "PICKUP" | "DELIVERY";

/** One case row as the feed SQL returns it. Every date is `::text` for the same
 *  reason as the SO feed: postgres.js leaves `date`/text as strings but turns
 *  `timestamptz` into Date objects, and the sheet wants strings. */
export type AssrFeedRow = {
  assr_no: string;
  doc_no: string | null;
  status: string | null;
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
  last_modified_text: string;
};

/** A leg emitted to the sheet: the SO record fields the writer needs, plus the
 *  leg discriminator (`Kind`) the Apps Script can group / colour by. */
export type AssrLegRecord = DeliverySheetRecord & { Kind: AssrLegKind };

/**
 * Binds, in order: ?1 company_id, ?2 since (timestamptz text), ?3 limit.
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
 * is under test.
 */
export const FEED_ASSR_LEGS_SQL = `
SELECT assr_no,
       doc_no,
       status,
       customer_name,
       phone,
       location,
       sales_agent,
       delivery_order,
       addr1, addr2, addr3, addr4,
       inspection_by, inspection_visit_at,
       pickup_by, customer_pickup_at,
       delivery_by, do_date,
       updated_at::text AS last_modified_text
  FROM assr_cases
 WHERE company_id = ?1
   AND closed_at IS NULL
   AND archived_at IS NULL
   AND (
        (inspection_by = 'own'      AND inspection_visit_at IS NOT NULL) OR
        (pickup_by     = 'customer' AND customer_pickup_at  IS NOT NULL) OR
        (delivery_by   = 'own'      AND do_date             IS NOT NULL)
       )
   AND updated_at::timestamptz > ?2::timestamptz
 ORDER BY updated_at::timestamptz, assr_no
 LIMIT ?3`;

const blankToNull = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

/** The fields shared by every leg of one case — the customer, the address and
 *  the region the leg routes to. `SalesLocation` is book-normalised exactly as
 *  the SO feed does, so `sheetRegion` lands the leg in the same regional tab a
 *  Sales Order for that customer would. */
function legBase(row: AssrFeedRow): Omit<AssrLegRecord, "Kind" | "DocNo" | "TransferTo" | "Remark2" | "SalesExemptionExpiryDate"> {
  const salesLocation = bookSpellingOrOwn(row.location, LOCATION_MAP);
  const addr3 = blankToNull(row.addr3);
  return {
    ErpDocNo: row.assr_no,
    DocDate: null,
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
    SOUDF_ToPONo: null,
    InvAddr1: blankToNull(row.addr1),
    InvAddr2: blankToNull(row.addr2),
    InvAddr3: addr3,
    InvAddr4: blankToNull(row.addr4),
    Attention: null,
    SOUDF_VENUE: null,
    Status: "PENDING",
    // Readiness is an SO concept; an ASSR leg's entry condition is the own-team
    // gate, already applied by the SQL — so it is never withheld for readiness.
    Ready: false,
    Region: sheetRegion(salesLocation, addr3),
    LastModified: row.last_modified_text,
  };
}

/**
 * Expand one case row into its own-team leg records (0–3). The SQL guarantees
 * at least one, but a case can carry all three; each leg schedules on the sheet
 * independently, so the delivery-back leg is the only one that carries the DO
 * number (`TransferTo`). `SalesExemptionExpiryDate` (the sheet's dispatch date,
 * col O) is the leg's own date — the day the team is due to go.
 */
/** The word each leg carries in its sheet key. The delivery-back leg is
 *  "SERVICE" (not "DELIVERY"): the delivery tabs already run on the ASSR Case
 *  linkage's vocabulary — key `<S/O>-<SERVICE|PICKUP|INSPECTION>` in col B and
 *  the ASSR number in col C — and `syncDeliveryDateToASSR` in ASSRDeliverySync.gs
 *  keys off exactly those (`ASSR_LINK_PATTERN`, then col C) to write a scheduled
 *  date back to the case and the ERP. Matching that convention makes an
 *  ERP-pulled leg the SAME row an old Farra edit would have made, not a
 *  duplicate, and keeps the date write-back working. */
const LEG_KEY_WORD: Record<AssrLegKind, "INSPECTION" | "PICKUP" | "SERVICE"> = {
  INSPECT: "INSPECTION",
  PICKUP: "PICKUP",
  DELIVERY: "SERVICE",
};

export function toAssrLegRecords(row: AssrFeedRow): AssrLegRecord[] {
  const base = legBase(row);
  // The S/O carries the leg key; fall back to the ASSR number only if a case
  // somehow has no doc_no (NOT NULL in the schema, so this is belt-and-braces).
  const keyDoc = blankToNull(row.doc_no) ?? row.assr_no;
  const legKey = (kind: AssrLegKind): string => `${keyDoc}-${LEG_KEY_WORD[kind]}`;
  const legs: AssrLegRecord[] = [];
  if (row.inspection_by === "own" && blankToNull(row.inspection_visit_at)) {
    legs.push({ ...base, Kind: "INSPECT", DocNo: legKey("INSPECT"), TransferTo: row.assr_no, Remark2: "SERVICE INSPECTION", SalesExemptionExpiryDate: row.inspection_visit_at });
  }
  if (row.pickup_by === "customer" && blankToNull(row.customer_pickup_at)) {
    legs.push({ ...base, Kind: "PICKUP", DocNo: legKey("PICKUP"), TransferTo: row.assr_no, Remark2: "SERVICE PICKUP", SalesExemptionExpiryDate: row.customer_pickup_at });
  }
  if (row.delivery_by === "own" && blankToNull(row.do_date)) {
    legs.push({ ...base, Kind: "DELIVERY", DocNo: legKey("DELIVERY"), TransferTo: row.assr_no, Remark2: "SERVICE DELIVERY", SalesExemptionExpiryDate: row.do_date });
  }
  return legs;
}
