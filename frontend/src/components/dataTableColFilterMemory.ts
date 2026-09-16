import { useCallback, useEffect, useRef, useState } from "react";

// In-visit memory for DataTable's per-column funnel filters.
//
// The funnel value-sets live in a MODULE-SCOPED Map, keyed by the same
// company-scoped idKey the dt:* layout prefs use. Module scope is the whole
// point: it survives a client-side route change (opening a record and coming
// back remounts the table, but Vite keeps the module loaded), so a funnel set
// this visit is NOT lost — the owner's 2026-08-19 rule ("漏斗一 reload 就没了很烦").
// It is WIPED on a full page load / new tab / F5, because the bundle
// re-evaluates and this Map starts empty again — the owner's 2026-09-16 rule
// that a list opens with NO funnel on a fresh entry ("全套系统进入那个东西都是不要
// filter先的").
//
// Deliberately NOT localStorage (that survived across sessions — the original
// stale-funnel bug) and NOT sessionStorage (that survives an F5, which the
// owner wants clean). Layout prefs (widths, pinned, hidden, sort, saved views)
// stay in localStorage; only the funnel VALUE filters moved here.

export type ColFilters = Record<string, string[]>;

const store = new Map<string, ColFilters>();

// Test seam: seed the store to simulate "a funnel set earlier this visit", and
// reset it to simulate a fresh page load. Not called by production code.
export function primeInVisitColFilters(idKey: string, filters: ColFilters): void {
  store.set(idKey, filters);
}
export function resetInVisitColFilters(): void {
  store.clear();
}

/** Funnel state backed by the in-visit Map, with the same `[value, setValue]`
 *  shape `useLocalStorage` returns so DataTable's call site is a drop-in swap. */
export function useInVisitColFilters(
  idKey: string,
): [ColFilters, (v: ColFilters | ((prev: ColFilters) => ColFilters)) => void] {
  const [value, setValue] = useState<ColFilters>(() => store.get(idKey) ?? {});

  /* The idKey can MOVE after mount: it gains a `c<company>:` prefix once the
     active company resolves (after /auth/me returns). Mirror useLocalStorage —
     on a genuine key change re-read the new bucket and skip the write, so a
     same-key edit on screen is never clobbered by the old key's value. */
  const keyRef = useRef(idKey);
  useEffect(() => {
    if (keyRef.current !== idKey) {
      keyRef.current = idKey;
      setValue(store.get(idKey) ?? {});
      return;
    }
    // Empty = no filter: drop the bucket so a remount reads clean rather than
    // finding a "{}" that would still count as a remembered (empty) view.
    if (Object.keys(value).length === 0) store.delete(idKey);
    else store.set(idKey, value);
  }, [idKey, value]);

  const update = useCallback(
    (v: ColFilters | ((prev: ColFilters) => ColFilters)) =>
      setValue((prev) => (typeof v === "function" ? (v as (p: ColFilters) => ColFilters)(prev) : v)),
    [],
  );

  return [value, update];
}
