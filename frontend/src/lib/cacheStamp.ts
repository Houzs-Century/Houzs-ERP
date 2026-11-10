// The overviews (Procurement, Logistic, Project, and the home page that reads
// them) are served from a copy kept up to two hours (backend scm/lib/kv-swr.ts),
// and they used to say "as of today" over it. The server now puts the copy's
// own time in the body as `cachedAt`; this says it out loud and lets the viewer
// ask for figures computed now (`?fresh=1`).
import { useCallback, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { serviceNotify } from "../vendor/scm/lib/dialog-service";

/** The `cachedAt` every cached overview answers with. */
export type Cached = { cachedAt?: string | null };

const HHMM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kuala_Lumpur" });

/** "Updated 14:05" (Malaysia time), or null when the answer carries no time. */
export function cacheStampLabel(cachedAt: string | null | undefined): string | null {
  if (!cachedAt) return null;
  const t = Date.parse(cachedAt);
  if (Number.isNaN(t)) return null;
  return `Updated ${HHMM.format(t)}`;
}

/** The OLDEST of several answers' times: a page built from several copies is only as current as its oldest. */
export function oldestCachedAt(times: Array<string | null | undefined>): string | null {
  const known = times.filter((x): x is string => !!x && !Number.isNaN(Date.parse(x)));
  if (!known.length) return null;
  return known.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/** The same request with `fresh=1`: recompute instead of serving the kept copy. */
export const withFresh = (url: string): string => `${url}${url.includes("?") ? "&" : "?"}fresh=1`;

export type RefreshTarget = { queryKey: QueryKey; load: () => Promise<unknown> };

/**
 * Refresh: fetch each target with `fresh=1` and put the answer in its cache
 * entry. A failed refresh keeps the figures on screen and SAYS they were not
 * refreshed, rather than leaving the old time beside them in silence.
 */
export function useCacheRefresh(): { refresh: (targets: RefreshTarget[]) => Promise<void>; refreshing: boolean } {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async (targets: RefreshTarget[]) => {
    setRefreshing(true);
    try {
      const answers = await Promise.all(targets.map((t) => t.load()));
      targets.forEach((t, i) => qc.setQueryData(t.queryKey, answers[i]));
    } catch (err) {
      void serviceNotify({
        title: "Could not refresh",
        body: `${err instanceof Error ? err.message : "Something went wrong."}\n\nThe figures on screen are still the earlier copy — check the Updated time.`,
        tone: "error",
      });
    } finally {
      setRefreshing(false);
    }
  }, [qc]);
  return { refresh, refreshing };
}
