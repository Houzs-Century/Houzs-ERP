/* ---------------------------------------------------------------------------
   so-ref-search — every search box finds a record by its Sales Order's
   reference number (owner 2026-09-25: 「整个系统的search button都能搜到SO的ref
   number」).

   The reference itself is resolved by customerRefOf (ref || customer_so_no), the
   one display rule — never re-derived here. What this module adds is the two
   shapes the server STAMPS the order's raw pair in when a row is not the order
   itself (backend/src/scm/lib/so-ref-lookup.ts), plus the loaded-rows matcher
   the client-side searches share.
   --------------------------------------------------------------------------- */

import { customerRefOf } from './customer-ref';

/** The Sales Order's raw reference pair, stamped onto a snake_case row. */
export type SoRefStamp = { so_ref?: string | null; so_customer_so_no?: string | null };

/** The same pair on a camelCase payload. */
export type SoRefStampCamel = { soRef?: string | null; soCustomerSoNo?: string | null };

/** The SO reference a stamped snake_case row carries ('' when none). */
export const soRefOfStamp = (r: SoRefStamp | null | undefined): string =>
  customerRefOf({ ref: r?.so_ref ?? null, customer_so_no: r?.so_customer_so_no ?? null });

/** The SO reference a stamped camelCase row carries ('' when none). */
export const soRefOfCamelStamp = (r: SoRefStampCamel | null | undefined): string =>
  customerRefOf({ ref: r?.soRef ?? null, customer_so_no: r?.soCustomerSoNo ?? null });

type SearchPart = string | number | null | undefined;

/** The lower-cased text a row search runs over. Parts are joined with a
 *  newline so two adjacent fields cannot form a match neither holds. */
export const searchText = (parts: ReadonlyArray<SearchPart>): string =>
  parts
    .filter((p) => p != null && p !== '')
    .map((p) => String(p).toLowerCase())
    .join('\n');

/** Case-insensitive substring match of `term` against the parts. A blank term
 *  matches everything. */
export function matchesSearch(parts: ReadonlyArray<SearchPart>, term: string): boolean {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  return searchText(parts).includes(q);
}

/** A Delivery Return list row, as much of it as its search reads. */
export type DeliveryReturnSearchRow = {
  return_number?: string | null;
  do_doc_no?: string | null;
  debtor_name?: string | null;
  debtor_code?: string | null;
  salesperson_id?: string | number | null;
  ref?: string | null;
  customer_so_no?: string | null;
  branding?: string | null;
  sales_location?: string | null;
  reason?: string | null;
  venue?: string | null;
};

/** The fields the Delivery Returns list search matches — ONE list for the
 *  desktop page and the phone, so the two cannot answer the same term
 *  differently (the phone used to skip the reference). */
export const deliveryReturnSearchParts = (r: DeliveryReturnSearchRow): SearchPart[] => [
  r.return_number,
  r.do_doc_no,
  r.debtor_name,
  r.debtor_code,
  r.salesperson_id,
  customerRefOf(r),
  r.branding,
  r.sales_location,
  r.reason,
  r.venue,
];

export const deliveryReturnSearchText = (r: DeliveryReturnSearchRow): string =>
  searchText(deliveryReturnSearchParts(r));

export const deliveryReturnMatchesSearch = (r: DeliveryReturnSearchRow, term: string): boolean =>
  matchesSearch(deliveryReturnSearchParts(r), term);
