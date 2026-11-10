/* "MRP as of hh:mm" on the PO / GRN / PI / SO lists (owner 2026-11-10).

   The list enrichments read the 15-min stored MRP snapshot instead of running
   live MRP on every open (backend/src/scm/lib/list-mrp-source.ts). Each response
   says which answer it used in `mrp`; a list page fetches in chunks, so the
   chunks' answers are combined here into the one line the page shows. Pure, so
   desktop and mobile render the same words. */

import { fmtTime } from "../vendor/shared/format";

export type ListMrpFallback = "missing" | "stale" | "refresh";

/** Twin of ListMrpMeta in backend/src/scm/lib/list-mrp-source.ts. */
export type ListMrpMeta = {
  asOf: string | null;
  source: "snapshot" | "live";
  fallback: ListMrpFallback | null;
  failed: boolean;
};

/** What a list page holds: the combined answer plus the Refresh action. */
export type ListMrpStatus = {
  meta: ListMrpMeta | null;
  refresh: () => void;
  refreshing: boolean;
};

/* A stale / missing snapshot is the thing the page must say, so it wins over a
   chunk that happened to read a fresh one. */
const FALLBACK_RANK: Record<ListMrpFallback, number> = { stale: 3, missing: 2, refresh: 1 };

/** One line for the page from every chunk's answer: the OLDEST time, live if any chunk was live. */
export function combineListMrpMeta(metas: ReadonlyArray<ListMrpMeta | null | undefined>): ListMrpMeta | null {
  const got = metas.filter((m): m is ListMrpMeta => !!m);
  if (got.length === 0) return null;
  let asOf: string | null = null;
  let fallback: ListMrpFallback | null = null;
  for (const m of got) {
    if (m.asOf && (asOf === null || Date.parse(m.asOf) < Date.parse(asOf))) asOf = m.asOf;
    if (m.fallback && (fallback === null || FALLBACK_RANK[m.fallback] > FALLBACK_RANK[fallback])) fallback = m.fallback;
  }
  return {
    asOf,
    source: got.some((m) => m.source === "live") ? "live" : "snapshot",
    fallback,
    failed: got.some((m) => m.failed),
  };
}

/** The words the page shows, and whether they are a warning. */
export function listMrpLabel(meta: ListMrpMeta): { text: string; warn: boolean } {
  if (meta.failed || !meta.asOf) return { text: "MRP unavailable, Assigned SO may be blank", warn: true };
  const at = fmtTime(meta.asOf);
  if (meta.fallback === "stale") return { text: `MRP live at ${at} (stored plan over 30 min old)`, warn: true };
  if (meta.fallback === "missing") return { text: `MRP live at ${at} (no stored plan)`, warn: true };
  return { text: `MRP as of ${at}`, warn: false };
}

/** The enrichment URL, with `&refresh=1` while a Refresh is in flight. */
export function withListMrpRefresh(url: string, refresh: boolean): string {
  return refresh ? `${url}&refresh=1` : url;
}
