import { useCallback, useEffect, useRef, useState } from "react";

export function useLocalStorage<T>(
  key: string,
  initial: T,
  legacyKey?: string,
  sanitize?: (value: unknown) => T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const read = () => {
    try {
      const raw = localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return sanitize ? sanitize(parsed) : parsed as T;
    } catch {
      return initial;
    }
  };
  const [value, setValue] = useState<T>(read);

  /* The key can MOVE after mount: DataTable's layout keys gain a `c<company>:`
     prefix once the active company resolves (after /auth/me returns). With a
     one-shot initialiser the state kept whatever the OLD key held, and the
     write below then copied it over the NEW key's saved value — the user's
     arrangement, overwritten on every open (DataGrid's twin, BUG-HISTORY
     2026-08-20). On a genuine key change, re-read and skip that write; a
     same-key re-render never re-reads, so an edit on screen is never
     clobbered. */
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      setValue(read());
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // quota / privacy mode — ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, legacyKey, value]);

  const update = useCallback((v: T | ((prev: T) => T)) => {
    setValue((prev) => (typeof v === "function" ? (v as (p: T) => T)(prev) : v));
  }, []);

  return [value, update];
}
