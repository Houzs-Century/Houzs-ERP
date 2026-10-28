import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  identityStorageKey,
  subscribeBrowserStorageIdentity,
} from "../lib/storageIdentity";

type Setter<T> = T | ((previous: T) => T);
export type PreferenceSanitizer<T> = (value: unknown) => T | undefined;

const EVENT = "houzs:identity-preference";

function rawSnapshot(baseKey: string): string {
  const key = identityStorageKey(baseKey);
  if (!key) return "";
  try {
    return `${key}\u0000${localStorage.getItem(key) ?? ""}`;
  } catch {
    return `${key}\u0000`;
  }
}

export function useIdentityPreference<T>(
  baseKey: string,
  initial: T,
  sanitize: PreferenceSanitizer<T>,
): [T, (next: Setter<T>) => void] {
  const subscribe = useCallback((notify: () => void) => {
    const unsubscribeIdentity = subscribeBrowserStorageIdentity(notify);
    const onStorage = (event: StorageEvent) => {
      const key = identityStorageKey(baseKey);
      if (event.key === null || (key && event.key === key)) notify();
    };
    const onLocal = (event: Event) => {
      if ((event as CustomEvent<{ baseKey?: string }>).detail?.baseKey === baseKey) notify();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENT, onLocal);
    return () => {
      unsubscribeIdentity();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENT, onLocal);
    };
  }, [baseKey]);

  const getSnapshot = useCallback(() => rawSnapshot(baseKey), [baseKey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => "");
  const separator = snapshot.indexOf("\u0000");
  const physicalKey = separator >= 0 ? snapshot.slice(0, separator) : "";
  const raw = separator >= 0 ? snapshot.slice(separator + 1) : "";

  const decoded = useMemo(() => {
    if (!physicalKey || !raw) return { value: initial, invalid: false };
    try {
      const value = sanitize(JSON.parse(raw));
      return value === undefined
        ? { value: initial, invalid: true }
        : { value, invalid: false };
    } catch {
      return { value: initial, invalid: true };
    }
  }, [initial, physicalKey, raw, sanitize]);

  useEffect(() => {
    if (!decoded.invalid || !physicalKey) return;
    try {
      localStorage.removeItem(physicalKey);
    } catch {
      // The default remains usable when storage is unavailable.
    }
  }, [decoded.invalid, physicalKey]);

  const setValue = useCallback((next: Setter<T>) => {
    const key = identityStorageKey(baseKey);
    if (!key) return;
    const previous = (() => {
      try {
        const rawValue = localStorage.getItem(key);
        if (!rawValue) return initial;
        return sanitize(JSON.parse(rawValue)) ?? initial;
      } catch {
        return initial;
      }
    })();
    const candidate = typeof next === "function"
      ? (next as (previous: T) => T)(previous)
      : next;
    const safe = sanitize(candidate) ?? initial;
    try {
      localStorage.setItem(key, JSON.stringify(safe));
    } catch {
      return;
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { baseKey } }));
  }, [baseKey, initial, sanitize]);

  return [decoded.value, setValue];
}

export const booleanPreference: PreferenceSanitizer<boolean> = (value) =>
  typeof value === "boolean" ? value : undefined;

export function enumPreference<const T extends string>(values: readonly T[]): PreferenceSanitizer<T> {
  const allowed = new Set<string>(values);
  return (value) => typeof value === "string" && allowed.has(value) ? value as T : undefined;
}

export function pageSizePreference(values: readonly number[]): PreferenceSanitizer<number> {
  const allowed = new Set(values);
  return (value) => typeof value === "number" && allowed.has(value) ? value : undefined;
}

export const booleanRecordPreference: PreferenceSanitizer<Record<string, boolean>> = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) return undefined;
  const result: Record<string, boolean> = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 100 || typeof item !== "boolean") return undefined;
    result[key] = item;
  }
  return result;
};
