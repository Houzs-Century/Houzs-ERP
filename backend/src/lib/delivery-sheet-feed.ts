/**
 * The HC Delivery sheet's ERP feed — the SQL and the row shape.
 *
 * The "HC Delivery Updated" Google Sheet used to pull its Sales Order rows from
 * AutoCount (`reference/GetAutoCountData.gs`: `GET /SalesOrder/getSince/{ts}`)
 * and push the dispatch team's edits back (`PUT /SalesOrder/updateFromSheet`).
 * The owner ruled on 2026-09-15 that the sheet reads from the ERP instead. The
 * sheet's writer (`Helper.gs` writeDataToTargetSheet) is keyed on the AutoCount
 * field NAMES, so this module emits exactly those names and the Apps Script
 * only changes its URL.
 *
 * Kept free of Hono so the SQL runs in tests-pg against real Postgres and the
 * mapper runs in a plain unit test.
 */
import { LOCATION_MAP } from "../services/autocount-master-maps";
import { bookSpellingOrOwn, resolveAcAgent } from "../services/autocount-writeback";
import { summariseReadiness } from "../scm/lib/so-readiness";

/** One head row, as the feed SQL below returns it. Every date is `::text`
 *  because postgres.js leaves `date` columns as strings but turns
 *  `timestamptz` into Date objects, and the sheet wants strings for both. */
export type FeedHeadRow = {
  doc_no: string;
  linked_ac_docno: string | null;
  so_date: string | null;
  ref: string | null;
  branding: string | null;
  debtor_name: string | null;
  phone: string | null;
  sales_location: string | null;
  agent: string | null;
  salesperson_name: string | null;
  local_total_sen: number | null;
  balance_sen_live: number | null;
  remark2: string | null;
  remark3: string | null;
  remark4: string | null;
  note: string | null;
  processing_date: string | null;
  customer_delivery_date: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  postcode: string | null;
  city: string | null;
  customer_state: string | null;
  venue: string | null;
  status: string;
  do_numbers: string | null;
  po_numbers: string | null;
  last_modified_text: string;
};

export type FeedLineRow = {
  doc_no: string;
  item_group: string | null;
  item_code: string | null;
  stock_status: string;
  cancelled: boolean | null;
};

/** The record the sheet's writer reads — AutoCount's field names, on purpose. */
export type DeliverySheetRecord = {
  DocNo: string;
  ErpDocNo: string;
  TransferTo: string | null;
  DocDate: string | null;
  Ref: string | null;
  SOUDF_BRANDING: string | null;
  DebtorName: string | null;
  Phone1: string | null;
  SalesLocation: string | null;
  SalesAgent: string | null;
  Total: number;
  SOUDF_BALANCE: number;
  Remark2: string | null;
  SOUDF_PDate: string | null;
  SalesExemptionExpiryDate: string | null;
  Remark4: string | null;
  Remark3: string | null;
  SOUDF_Note: string | null;
  SOUDF_ToPONo: string | null;
  InvAddr1: string | null;
  InvAddr2: string | null;
  InvAddr3: string | null;
  InvAddr4: string | null;
  Attention: string | null;
  SOUDF_VENUE: string | null;
  Status: string;
  Region: "WEST" | "EAST" | "SG" | null;
  LastModified: string;
};

export const FEED_DEFAULT_LIMIT = 300;
export const FEED_MAX_LIMIT = 1000;
/** The old script's default when ScriptProperties held no checkpoint. */
export const FEED_EPOCH = "2000-01-01 00:00:00";
export const UPDATES_MAX = 300;

/**
 * The checkpoint the sheet sends back is the `LastModified` text of the last
 * row it wrote — Postgres's own `timestamptz::text` (microseconds and offset),
 * or the old script's `yyyy-MM-dd HH:mm:ss`. Anything else is refused so a
 * malformed value fails the request instead of reaching `::timestamptz`.
 */
const SINCE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

export function parseSince(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  if (!s) return FEED_EPOCH;
  return SINCE_RE.test(s) ? s : null;
}

export function parseLimit(raw: string | undefined | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return FEED_DEFAULT_LIMIT;
  return Math.min(n, FEED_MAX_LIMIT);
}

/**
 * Binds, in order: ?1 company_id, ?2 since (timestamptz text), ?3 limit.
 *
 * `LastModified` is the LATEST of the header's own `updated_at`, the newest
 * payment and the newest delivery order — measured 2026-09-15, 116 of 2,958
 * Houzs orders had a payment newer than `updated_at` (POST /:docNo/payments
 * never touches the header), so a feed keyed on `updated_at` alone would never
 * tell the sheet a balance was collected.
 *
 * DRAFT and CANCELLED orders are not sent, as on the delivery board. A row the
 * sheet already carries keeps its last state when its order is cancelled.
 */
/** The head rows every feed reads, for ONE company (`?1`), live orders only.
 *  Each feed wraps this and adds its own outer predicate and order. */
const FEED_BASE_SQL = `
  SELECT so.doc_no, so.linked_ac_docno,
         so.so_date::text AS so_date, so.ref, so.branding, so.debtor_name, so.phone,
         so.sales_location, so.agent, sp.name AS salesperson_name,
         so.local_total_sen,
         so.local_total_sen - COALESCE(pay.paid_sen, 0) AS balance_sen_live,
         so.remark2, so.remark3, so.remark4, so.note,
         so.processing_date::text AS processing_date,
         so.customer_delivery_date::text AS customer_delivery_date,
         so.address1, so.address2, so.address3, so.address4,
         so.postcode, so.city, so.customer_state, so.venue,
         so.status::text AS status,
         dos.do_numbers, pos.po_numbers,
         GREATEST(so.updated_at, pay.last_paid_at, dos.last_do_at) AS last_modified
    FROM scm.mfg_sales_orders so
    LEFT JOIN (SELECT so_doc_no, SUM(amount_sen) AS paid_sen, MAX(created_at) AS last_paid_at
                 FROM scm.mfg_sales_order_payments GROUP BY so_doc_no) pay ON pay.so_doc_no = so.doc_no
    LEFT JOIN (SELECT so_doc_no,
                      string_agg(do_number, ', ' ORDER BY do_number) FILTER (WHERE status::text <> 'CANCELLED') AS do_numbers,
                      MAX(updated_at) AS last_do_at
                 FROM scm.delivery_orders GROUP BY so_doc_no) dos ON dos.so_doc_no = so.doc_no
    LEFT JOIN (SELECT i.doc_no, string_agg(DISTINCT po.po_number, ', ') AS po_numbers
                 FROM scm.mfg_sales_order_items i
                 JOIN scm.purchase_order_items pi ON pi.so_item_id = i.id
                 JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
                WHERE po.cancelled_at IS NULL AND po.status::text <> 'CANCELLED' AND po.po_number IS NOT NULL
                GROUP BY i.doc_no) pos ON pos.doc_no = so.doc_no
    LEFT JOIN scm.staff sp ON sp.id = so.salesperson_id
   WHERE so.company_id = ?1
     AND so.status::text NOT IN ('DRAFT', 'CANCELLED')`;

export const FEED_SINCE_SQL = `
SELECT t.*, t.last_modified::text AS last_modified_text
FROM (${FEED_BASE_SQL}
) t
WHERE t.last_modified > ?2::timestamptz
ORDER BY t.last_modified, t.doc_no
LIMIT ?3`;

/** The statuses that mean the goods have left — the book's "fully transferred".
 *  "Undelivered" is deliberately NOT a second list here: the base SELECT already
 *  drops DRAFT and CANCELLED, so an undelivered order is simply one that is not
 *  in this set (so-delivery-sync.ts's DELIVERABLE_FROM is the auto-advance rule,
 *  a different question, and excludes ON_HOLD for its own reason). */
export const DELIVERED_STATUSES = ["DELIVERED", "INVOICED", "CLOSED"] as const;

const inList = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(", ");

/**
 * The Overdue History feed (replaces AutoCount `/SalesOrder/getOverdue`,
 * owner rulings 2026-09-16): an undelivered order (held ones included) whose
 * customer delivery date has passed, Malaysian calendar day. Bind: ?1
 * company_id. Oldest date first. No age cap (the >90-day ones are included on
 * purpose).
 */
export const FEED_OVERDUE_SQL = `
SELECT t.*, t.last_modified::text AS last_modified_text
FROM (${FEED_BASE_SQL}
) t
WHERE t.status NOT IN (${inList(DELIVERED_STATUSES)})
  AND t.customer_delivery_date::date < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
ORDER BY t.customer_delivery_date, t.doc_no`;

/**
 * The Balance Collection feed (replaces AutoCount `/SalesOrder/getBalanceCollection`):
 * the goods have left but money is still owed — what the book called "fully
 * transferred with UDF_BALANCE > 0" (every order on the old tab was absent
 * from the ERP's outstanding import for exactly that reason). Bind: ?1
 * company_id. Oldest delivery date first, undated last.
 */
export const FEED_BALANCE_COLLECTION_SQL = `
SELECT t.*, t.last_modified::text AS last_modified_text
FROM (${FEED_BASE_SQL}
) t
WHERE t.status IN (${inList(DELIVERED_STATUSES)})
  AND t.balance_sen_live > 0
ORDER BY t.customer_delivery_date NULLS LAST, t.doc_no`;

/** The lines behind a page of heads, for the Remarks-2 readiness wording.
 *  Bare `?` per doc number; bind the doc numbers in the same order. */
export function feedLinesSql(docCount: number): string {
  const marks = Array.from({ length: docCount }, () => "?").join(", ");
  return `SELECT doc_no, item_group, item_code, stock_status, cancelled
            FROM scm.mfg_sales_order_items WHERE doc_no IN (${marks})`;
}

/**
 * The write leg — ONE statement for a whole batch. Bare `?` binds, in order:
 * for each row `(sheet doc no, remark4 or null = keep, yyyy-mm-dd or null =
 * keep)`, then the company_id last.
 *
 * One statement, not one per row: the sheet's Apps Script calls from Google's
 * US servers, so the Worker runs there and every database round trip crosses
 * to Singapore. Measured 2026-09-15 on the first seed: 300 single-row updates
 * took 116 s (~400 ms each), which puts a 4,000-row seed past Apps Script's
 * 6-minute limit. A VALUES join makes a batch one round trip.
 *
 * The sheet keys its rows on the AutoCount number — `SO-013495` for a migrated
 * order, whose ERP number is `HC-SO-013495` and whose `linked_ac_docno` is the
 * sheet's key; a native order carries the same number on both. So the row is
 * found by EITHER column, within the secret's company. RETURNING carries the
 * sheet's key back so the caller can answer per row.
 */
export function updateFromSheetSql(rowCount: number): string {
  const values = Array.from({ length: rowCount }, () => "(?::text, ?::text, ?::date)").join(", ");
  return `
UPDATE scm.mfg_sales_orders so
   SET remark4 = COALESCE(v.remark4, so.remark4),
       customer_delivery_date = COALESCE(v.delivery_date, so.customer_delivery_date),
       updated_at = now()
  FROM (VALUES ${values}) AS v(sheet_doc_no, remark4, delivery_date)
 WHERE so.company_id = ?
   AND (so.linked_ac_docno = v.sheet_doc_no OR so.doc_no = v.sheet_doc_no)
   AND so.status::text NOT IN ('DRAFT', 'CANCELLED')
 RETURNING so.doc_no, v.sheet_doc_no`;
}

const senToAmount = (sen: number | null | undefined): number =>
  Number((Number(sen ?? 0) / 100).toFixed(2));

const blankToNull = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

/** Same rule as the Apps Script and services/autocount.ts routeRegion, plus
 *  HQ (the 2023-era Balakong code) on the West side. */
export function sheetRegion(salesLocation: string | null, addr3: string | null): DeliverySheetRecord["Region"] {
  if ((addr3 ?? "").toUpperCase().includes("SINGAPORE")) return "SG";
  const loc = (salesLocation ?? "").toUpperCase();
  if (loc === "KL" || loc === "PG" || loc === "HQ") return "WEST";
  if (loc === "SBH" || loc === "SRW") return "EAST";
  return null;
}

export function toSheetRecord(row: FeedHeadRow, lines: ReadonlyArray<FeedLineRow>): DeliverySheetRecord {
  const salesLocation = bookSpellingOrOwn(row.sales_location, LOCATION_MAP);
  const addr3 = blankToNull(row.address3) ?? blankToNull([row.postcode, row.city].filter(Boolean).join(" "));
  const addr4 = blankToNull(row.address4) ?? blankToNull(row.customer_state);
  // The sheet's Remarks 2 is the stock-readiness wording ("READY", "PARTIAL",
  // "MATTRESS"). A migrated order carries the book's text; an order without
  // one gets the same derivation the SO list and /so-export use.
  const readiness = lines.length ? summariseReadiness([...lines]).stockRemark : "";
  return {
    DocNo: row.linked_ac_docno ?? row.doc_no,
    ErpDocNo: row.doc_no,
    TransferTo: blankToNull(row.do_numbers),
    DocDate: row.so_date,
    Ref: blankToNull(row.ref),
    SOUDF_BRANDING: blankToNull(row.branding),
    DebtorName: blankToNull(row.debtor_name),
    Phone1: blankToNull(row.phone),
    SalesLocation: salesLocation,
    SalesAgent: resolveAcAgent(row.agent, row.salesperson_name),
    Total: senToAmount(row.local_total_sen),
    SOUDF_BALANCE: senToAmount(row.balance_sen_live),
    Remark2: blankToNull(row.remark2) ?? blankToNull(readiness),
    SOUDF_PDate: row.processing_date,
    SalesExemptionExpiryDate: row.customer_delivery_date,
    Remark4: blankToNull(row.remark4),
    Remark3: blankToNull(row.remark3),
    SOUDF_Note: blankToNull(row.note),
    SOUDF_ToPONo: blankToNull(row.po_numbers),
    InvAddr1: blankToNull(row.address1),
    InvAddr2: blankToNull(row.address2),
    InvAddr3: addr3,
    InvAddr4: addr4,
    Attention: null,
    SOUDF_VENUE: blankToNull(row.venue),
    Status: row.status,
    Region: sheetRegion(salesLocation, addr3),
    LastModified: row.last_modified_text,
  };
}

/** The sheet sends `yyyy-MM-dd` (normalised by the script) or `yyyy/MM/dd`
 *  (the column's own format); a blank means "leave the date alone". */
export function normSheetDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
