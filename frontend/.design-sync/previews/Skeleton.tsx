import { Skeleton } from "autocount-sync-frontend";

// Base shimmer bar — size it with h-*/w-* utilities. ListSkeleton and
// TableSkeleton (same file) have their own previews.

export const Bars = () => (
  <div className="w-72 space-y-2">
    <Skeleton className="h-3 w-24" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-2/3" />
  </div>
);

export const Shapes = () => (
  <div className="flex w-72 items-center gap-3">
    <Skeleton className="h-10 w-10 rounded-full" />
    <div className="flex-1 space-y-1.5">
      <Skeleton className="h-3.5 w-32" />
      <Skeleton className="h-3 w-44" />
    </div>
    <Skeleton className="h-6 w-14 rounded-full" />
  </div>
);

export const InContext = () => (
  <div className="w-72 rounded-lg border border-border bg-surface p-3 shadow-stone">
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
      Loading DO-01842…
    </div>
    <div className="space-y-2">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-5/6" />
      <div className="flex gap-2 pt-1">
        <Skeleton className="h-8 w-24 rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
    </div>
  </div>
);
