import { useCallback, useEffect, useRef, useState } from "react";
import { identityStorageKey } from "../lib/storageIdentity";

// A small filter object persisted in sessionStorage for state that is NOT in the
// URL — the mobile calendar's brand / section / organizer selects, which are
// plain React state, not react-router params, so useStickyFilters cannot hold
// them.
//
// Same contract as useStickyFilters' idle mode (owner 2026-09-30): the filter
// survives navigation into a project and back, and is dropped once `idleTtlMs`
// has passed since it was last CHANGED — restoring it on navigation does NOT
// restart that clock, only editing a value does. It is stored under the shared
// `filters:<scope>:u<user>:c<company>` key family, so the AuthContext logout
// sweep of `filters:*` clears it too, and the storage registry's `list-filters`
// rule already covers the key.
export function useIdleSessionFilter<T extends Record<string, string>>(
  scope: string,
  initial: T,
  idleTtlMs: number,
): [T, (patch: Partial<T>) => void] {
  const key = identityStorageKey(`filters:${scope}`);

  const [value, setValue] = useState<T>(() => {
    if (!key) return initial;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return initial;
      const rec = JSON.parse(raw) as { v?: unknown; t?: unknown } | null;
      if (!rec || typeof rec.t !== "number" || typeof rec.v !== "object" || rec.v == null || Date.now() - rec.t > idleTtlMs) {
        sessionStorage.removeItem(key);
        return initial;
      }
      return { ...initial, ...(rec.v as Partial<T>) };
    } catch {
      return initial;
    }
  });

  const touched = useRef(false);
  useEffect(() => {
    if (touched.current || !key) return;
    touched.current = true;
    try {
      if (sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, JSON.stringify({ v: value, t: Date.now() }));
      }
    } catch {
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = useCallback(
    (p: Partial<T>) => {
      setValue((prev) => {
        const next = { ...prev, ...p };
        try {
          if (key) sessionStorage.setItem(key, JSON.stringify({ v: next, t: Date.now() }));
        } catch {
        }
        return next;
      });
    },
    [key],
  );

  return [value, patch];
}
