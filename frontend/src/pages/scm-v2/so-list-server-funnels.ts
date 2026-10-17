// ----------------------------------------------------------------------------
// so-list-server-funnels — which Sales Order list column funnels the SERVER
// answers, and what the page does when any funnel changes.
//
// Owner reports 2026-10-17: ticking BRANDING = ZANOTTI left 9 of the page's 50
// rows while the footer still read "1-50 of 3,465 · 70 pages", and every other
// column funnel did the same. A funnel is client-side, so on this server-paged
// list a column the list query does not carry only ever narrows the loaded page.
// Customer Name, Currency and Branding ride their own params; every column in
// SO_COLUMN_FUNNEL_KEYS rides one `cols` param (backend
// lib/so-list-column-funnels.ts, which holds the matching rule per column).
//
// Still page-local: the columns read from other tables per page (PO / DO
// numbers, stock status, shipped progress, payment method, approval codes,
// sales exemption expiry), every line column and custom fields, and a
// date-range / number-range condition on any column.
// ----------------------------------------------------------------------------

export type SoColFilters = Record<string, string[] | undefined>;

export type SoServerFunnels = {
  debtorNames: string[] | undefined;
  currencies: string[] | undefined;
  brandings: string[] | undefined;
  cols: Record<string, string[]> | undefined;
};

/** Grid column key -> list query param, for the funnels with their own param. */
export const SO_SERVER_FUNNEL_COLUMNS = {
  debtor_name: "debtorNames",
  currency: "currencies",
  branding: "brandings",
} as const satisfies Record<string, Exclude<keyof SoServerFunnels, "cols">>;

// eslint-disable-next-line no-restricted-syntax -- the grid's finance COLUMN keys (so-do-list-columns financeColumns + the Deposit column), mirrored for the cols param; the backend gates them with SO_FINANCE_KEYS
const FINANCE_COLUMN_KEYS = ["mattress_sofa_sen", "bedframe_sen", "accessories_sen", "others_sen", "service_sen", "mattress_sofa_cost_sen", "bedframe_cost_sen", "accessories_cost_sen", "others_cost_sen", "service_cost_sen", "total_cost_sen", "total_margin_sen", "margin_pct_basis", "deposit_sen"];

/** Grid column keys the backend matches through `cols` (mirrors
 *  SO_COLUMN_FUNNELS in backend lib/so-list-column-funnels.ts). */
export const SO_COLUMN_FUNNEL_KEYS: readonly string[] = [
  "doc_no", "erp_doc_no", "so_date", "salesperson", "sales_location", "reference", "status", "amount",
  "phone", "email", "debtor_code", "address1", "address2", "city", "postcode", "customer_state",
  "paid", "balance", "venue", "processing_date", "customer_delivery_date", "note", "customer_type",
  "building_type", "customer_country",
  // Finance columns: the backend honours these for a finance viewer only.
  ...FINANCE_COLUMN_KEYS,
];

/* The grid's date-range / number-range condition tokens start with \u0001
   (components/dataTableConditionFilters); the server matches values only. */
const isCondition = (v: string): boolean => v.startsWith("\u0001");

const ticked = (cf: SoColFilters, key: string): string[] | undefined => {
  const v = (cf[key] ?? []).filter((x) => !isCondition(x));
  return v.length > 0 ? v : undefined;
};

export function soServerFunnels(cf: SoColFilters): SoServerFunnels {
  const cols: Record<string, string[]> = {};
  for (const key of SO_COLUMN_FUNNEL_KEYS) {
    const v = ticked(cf, key);
    if (v) cols[key] = v;
  }
  return {
    debtorNames: ticked(cf, "debtor_name"),
    currencies: ticked(cf, "currency"),
    brandings: ticked(cf, "branding"),
    cols: Object.keys(cols).length > 0 ? cols : undefined,
  };
}

const SERVER_KEYS = new Set<string>([...Object.keys(SO_SERVER_FUNNEL_COLUMNS), ...SO_COLUMN_FUNNEL_KEYS]);

/** Column keys whose funnel is set but the server does not answer (a
 *  page-local column, or a condition token on any column). A change to one
 *  still sends the list back to page 1. */
export function soPageOnlyFunnelKeys(cf: SoColFilters): string[] {
  return Object.keys(cf).filter((k) => {
    const v = cf[k] ?? [];
    return v.length > 0 && (!SERVER_KEYS.has(k) || v.some(isCondition));
  });
}

/** Seed each server column's funnel with every value the server listed for it
 *  (GET /mfg-sales-orders/funnel-values). A column that already carries its own
 *  seed (Customer Name, Branding) keeps it. */
export function withSoFunnelSeeds<C extends { key: string; filterSeedValues?: readonly string[] }>(
  values: Record<string, string[]> | undefined,
  columns: C[],
): C[] {
  if (!values) return columns;
  return columns.map((col) => (col.filterSeedValues || !(col.key in values) ? col : { ...col, filterSeedValues: values[col.key] }));
}

/** The 0-based page to show once the filtered total is known: a page past the
 *  last one (page 70 of a 3-page filtered set) falls back to the last page. */
export function clampSoPage(page: number, total: number, pageSize: number): number {
  const last = Math.max(0, Math.ceil(total / Math.max(1, pageSize)) - 1);
  return Math.min(Math.max(0, page), last);
}
