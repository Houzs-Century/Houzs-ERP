// Session-scoped memory for the Service Cases (ASSR) list's search term + stage
// filter — so opening a case and clicking Back returns to the list still
// filtered (owner 2026-07-24).
//
// The other ASSR list filters (view, page size, show-archived, my-cases,
// hide-completed) already persist via useIdentityPreference (localStorage,
// durable). The free-text SEARCH and the STAGE tab were plain useState, so they
// reset the moment the list unmounted to show a case. Persisting them here — in
// sessionStorage, per TAB — restores them on Back within the session, WITHOUT
// leaving a stale search haunting the next day (owner's choice: 本次会话).
//
// One key, per browser tab. Same-origin values only; nothing sensitive.

export const ASSR_LIST_FILTER_KEY = "houzs.assrListFilter.v1";

export interface AssrListFilter {
  search: string;
  /** "ALL" | AssrStage — kept as a plain string here; the page owns the enum. */
  stage: string;
}

const EMPTY: AssrListFilter = { search: "", stage: "ALL" };

export function readAssrListFilter(): AssrListFilter {
  try {
    const raw = sessionStorage.getItem(ASSR_LIST_FILTER_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const p = parsed as Partial<AssrListFilter>;
    const search = typeof p.search === "string" && p.search.length <= 200 ? p.search : "";
    const stage = typeof p.stage === "string" && p.stage.length <= 40 ? p.stage : "ALL";
    return { search, stage };
  } catch {
    return EMPTY;
  }
}

export function writeAssrListFilter(next: AssrListFilter): void {
  try {
    if (next.search === "" && (next.stage === "ALL" || next.stage === "")) {
      // Nothing to remember — keep storage clean so a fresh session starts empty.
      sessionStorage.removeItem(ASSR_LIST_FILTER_KEY);
      return;
    }
    sessionStorage.setItem(
      ASSR_LIST_FILTER_KEY,
      JSON.stringify({ search: next.search, stage: next.stage }),
    );
  } catch {
    // storage disabled (private mode) — the filter just won't survive Back
  }
}
