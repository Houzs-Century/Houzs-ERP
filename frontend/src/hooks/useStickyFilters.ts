import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { identityStorageKey } from "../lib/storageIdentity";

/**
 * Persists a page's filters / tabs / sort choice across navigation.
 *
 * Layered persistence:
 *   1. URL (useSearchParams) is authoritative — survives refresh,
 *      back / forward, and is shareable as a link.
 *   2. sessionStorage mirrors the URL per scope so navigating away via
 *      the navbar (or into a detail page and back) restores the last view.
 *
 * SESSION-scoped, not local (owner 2026-08-24: "i want make it my filter didnt
 * close until i manually clear filter or close erp then filter will auto
 * clear"). So a filter survives every navigation inside the app and is dropped
 * when the tab closes; Clear-all still empties it immediately. This matches
 * `houzs.scmListReturn.v1` / `houzs.assrListFilter.v1`, which already keep a
 * filtered list across a detail round-trip in sessionStorage.
 *
 * Restore happens once per mount and only when the URL has no params.
 * A user landing on a bookmarked /sales?status=draft therefore always
 * sees that state, regardless of what they had stored locally.
 *
 * @param scope  Storage key suffix; pass a stable per-page slug
 *               (e.g. "sales", "orders").
 * @param keys   Optional allow-list of params to mirror. Anything else
 *               in the URL (e.g. `?focus=123` from a deep-link) won't
 *               be persisted. When omitted, every param is persisted.
 * @param opts.idleTtlMs  When set, the stored filter is dropped once this many
 *               ms have passed since the page was last used (owner 2026-09-30:
 *               the calendar filter should "remain unless u log out or leave the
 *               page without touching for 1 hour"). Opening the page restores the
 *               filter AND re-stamps the clock, so the TTL measures time AWAY
 *               from the page, not time since an edit. Logout clears it outright
 *               (AuthContext sweeps `filters:*`).
 */
export function useStickyFilters(
  scope: string,
  keys?: readonly string[],
  opts?: { idleTtlMs?: number }
): ReturnType<typeof useSearchParams> {
  const [params, setParams] = useSearchParams();
  const storageKey = identityStorageKey(`filters:${scope}`);
  const idleTtlMs = opts?.idleTtlMs;
  const restored = useRef(false);

  function pluck(src: URLSearchParams): URLSearchParams {
    if (!keys) return new URLSearchParams(src);
    const out = new URLSearchParams();
    for (const k of keys) {
      const v = src.get(k);
      if (v !== null && v !== "") out.set(k, v);
    }
    return out;
  }

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const current = pluck(params);
    if (current.toString() !== "") return;
    try {
      if (!storageKey) return;
      localStorage.removeItem(storageKey);
      const saved = sessionStorage.getItem(storageKey);
      if (!saved) return;
      let snapStr = saved;
      if (idleTtlMs != null) {
        let parsed: unknown;
        try { parsed = JSON.parse(saved); } catch { parsed = null; }
        const rec = parsed as { v?: unknown; t?: unknown } | null;
        if (!rec || typeof rec.v !== "string" || typeof rec.t !== "number" || Date.now() - rec.t > idleTtlMs) {
          sessionStorage.removeItem(storageKey);
          return;
        }
        snapStr = rec.v;
      }
      const next = pluck(new URLSearchParams(snapStr));
      if (next.toString() === "") return;
      const merged = new URLSearchParams(params);
      for (const [k, v] of next) merged.set(k, v);
      setParams(merged, { replace: true });
    } catch {
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      if (!storageKey) return;
      const snap = pluck(params).toString();
      if (snap === "") { sessionStorage.removeItem(storageKey); return; }
      if (idleTtlMs != null) {
        // Stamp the time on every write — mounting/using the page (which restores
        // the filter and re-mirrors it) counts as "touching" it, so the 1-hour
        // idle clock measures time AWAY from the page. Owner 2026-09-30: "leave
        // the page without touching for 1 hour".
        sessionStorage.setItem(storageKey, JSON.stringify({ v: snap, t: Date.now() }));
      } else {
        sessionStorage.setItem(storageKey, snap);
      }
    } catch {
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  return [params, setParams];
}
