import { ListSkeleton } from "autocount-sync-frontend";

// Stacked shimmer bars — loading state for sidebar pickers / sub-panels.

export const ThreeRows = () => (
  <div className="w-64">
    <ListSkeleton />
  </div>
);

export const SixRows = () => (
  <div className="w-64">
    <ListSkeleton rows={6} />
  </div>
);

export const InPanel = () => (
  <div className="w-72 rounded-lg border border-border bg-surface p-3 shadow-stone">
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
      Recent cases
    </div>
    <ListSkeleton rows={4} />
  </div>
);
