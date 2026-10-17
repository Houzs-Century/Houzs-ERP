// ----------------------------------------------------------------------------
// so-list-server-funnels — which Sales Order list column funnels the SERVER
// answers, and what the page does when any funnel changes.
//
// Owner report 2026-10-17: ticking BRANDING = ZANOTTI left 9 of the page's 50
// rows while the footer still read "1-50 of 3,465 · 70 pages". A funnel is
// client-side, so on this server-paged list a column the list query does not
// carry only ever narrows the loaded page. Customer Name, Currency and Branding
// are pushed into the query (backend lib/so-list-read.ts); every other funnel
// is page-local, and the pager says so instead of implying it covers the set.
// ----------------------------------------------------------------------------

export type SoColFilters = Record<string, string[] | undefined>;

export type SoServerFunnels = {
  debtorNames: string[] | undefined;
  currencies: string[] | undefined;
  brandings: string[] | undefined;
};

/** Grid column key -> list query param, for the funnels the server answers. */
export const SO_SERVER_FUNNEL_COLUMNS = {
  debtor_name: "debtorNames",
  currency: "currencies",
  branding: "brandings",
} as const satisfies Record<string, keyof SoServerFunnels>;

const ticked = (cf: SoColFilters, key: string): string[] | undefined => {
  const v = cf[key];
  return v && v.length > 0 ? v : undefined;
};

export function soServerFunnels(cf: SoColFilters): SoServerFunnels {
  return { debtorNames: ticked(cf, "debtor_name"), currencies: ticked(cf, "currency"), brandings: ticked(cf, "branding") };
}

/** Column keys whose funnel is set but the server cannot answer (page-local). */
export function soPageOnlyFunnelKeys(cf: SoColFilters): string[] {
  return Object.keys(cf).filter((k) => ticked(cf, k) && !(k in SO_SERVER_FUNNEL_COLUMNS));
}

/** The 0-based page to show once the filtered total is known: a page past the
 *  last one (page 70 of a 3-page filtered set) falls back to the last page. */
export function clampSoPage(page: number, total: number, pageSize: number): number {
  const last = Math.max(0, Math.ceil(total / Math.max(1, pageSize)) - 1);
  return Math.min(Math.max(0, page), last);
}
