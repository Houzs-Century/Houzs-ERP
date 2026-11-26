import { heldPlaceParams } from "./leaveGuard";

export interface Place {
  pathname: string;
  search: string;
}

/** Another page, by pathname, or another value of a query parameter a holder
 *  named. Any other query-string change on the same page (a tab, a filter, a
 *  wizard step) is the same place and is never asked about. */
export function leavesPlace(from: Place, to: Partial<Place>): boolean {
  if (to.pathname !== undefined && to.pathname !== "" && normalise(to.pathname) !== normalise(from.pathname)) {
    return true;
  }
  const a = new URLSearchParams(from.search);
  const b = new URLSearchParams(to.search ?? "");
  for (const params of heldPlaceParams()) {
    if (params.some((k) => a.get(k) !== b.get(k))) return true;
  }
  return false;
}

function normalise(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Where the current entry sits in the browser history (react-router writes `idx`). */
export function historyIndex(): number | null {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null && "idx" in state && typeof state.idx === "number"
    ? state.idx
    : null;
}
