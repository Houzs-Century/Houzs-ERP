import { cacheStampLabel } from "../lib/cacheStamp";

/** "Updated 14:05 · Refresh" beside a cached overview's figures. */
export function CacheStamp({ cachedAt, onRefresh, refreshing }: {
  cachedAt: string | null | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const label = cacheStampLabel(cachedAt);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted" data-testid="cache-stamp">
      {label && <span title="These figures are kept for up to 2 hours so the page opens fast. Refresh recomputes them now.">{label}</span>}
      <button type="button" onClick={onRefresh} disabled={refreshing}
        className="rounded px-1 font-semibold text-primary hover:underline disabled:opacity-60">
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </span>
  );
}
