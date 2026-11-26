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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, legacyKey, value]);

  const update = useCallback((v: T | ((prev: T) => T)) => {
    setValue((prev) => (typeof v === "function" ? (v as (p: T) => T)(prev) : v));
  }, []);

  return [value, update];
}
