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
// The search box text, same visit scope: a name typed above the board came back
// empty after opening a record (owner 2026-10-05), while the funnels beside it
// were remembered.
const searchStore = new Map<string, string>();

// Test seam: seed the store to simulate "a funnel set earlier this visit", and
// reset it to simulate a fresh page load. Not called by production code.
export function primeInVisitColFilters(idKey: string, filters: ColFilters): void {
  store.set(idKey, filters);
}
export function resetInVisitColFilters(): void {
  store.clear();
  searchStore.clear();
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

/** The client search text, in-visit like the funnels. `enabled` false (per-mount
 *  tables) keeps it in plain component state and never touches the store. */
export function useInVisitClientSearch(
  idKey: string,
  enabled: boolean,
): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => (enabled ? searchStore.get(idKey) ?? "" : ""));
  const keyRef = useRef(idKey);
  useEffect(() => {
    if (!enabled) return;
    if (keyRef.current !== idKey) {
      keyRef.current = idKey;
      setValue(searchStore.get(idKey) ?? "");
      return;
    }
    if (value === "") searchStore.delete(idKey);
    else searchStore.set(idKey, value);
  }, [idKey, value, enabled]);
  return [value, setValue];
}

/* Funnels a table KEEPS across page loads (`persistFilters="always"`): the
   delivery planning boards, where the owner wants the queue he narrowed
   yesterday to still be narrowed today (2026-10-05). A device pref in the same
   `dt:` family as the column layout, read on mount, removed when cleared. The
   key is deliberately not `dt:filters:` — DataTable erases that pre-2026-09-16
   family on every mount. */
const KEPT_PREFIX = "dt:funnels:";

function sanitizeColFilters(raw: unknown): ColFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ColFilters = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) out[k] = v as string[];
  }
  return out;
}

function readKeptColFilters(idKey: string): ColFilters {
  try {
    const raw = localStorage.getItem(KEPT_PREFIX + idKey);
    return raw ? sanitizeColFilters(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function useKeptColFilters(
  idKey: string,
  enabled: boolean,
): [ColFilters, (v: ColFilters | ((prev: ColFilters) => ColFilters)) => void] {
  const [value, setValue] = useState<ColFilters>(() => (enabled ? readKeptColFilters(idKey) : {}));
  const keyRef = useRef(idKey);
  useEffect(() => {
    if (!enabled) return;
    if (keyRef.current !== idKey) {
      keyRef.current = idKey;
      setValue(readKeptColFilters(idKey));
      return;
    }
    try {
      if (Object.keys(value).length === 0) localStorage.removeItem(KEPT_PREFIX + idKey);
      else localStorage.setItem(KEPT_PREFIX + idKey, JSON.stringify(value));
    } catch {
      // quota / privacy mode: the funnel still applies for this visit
    }
  }, [idKey, value, enabled]);

  const update = useCallback(
    (v: ColFilters | ((prev: ColFilters) => ColFilters)) =>
      setValue((prev) => (typeof v === "function" ? (v as (p: ColFilters) => ColFilters)(prev) : v)),
    [],
  );

  return [value, update];
}
