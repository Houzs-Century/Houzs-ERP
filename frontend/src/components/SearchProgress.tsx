import { Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

export function SearchProgress({
  active,
  label = "Searching…",
  className,
}: {
  active: boolean;
  label?: string;
  className?: string;
}) {
  if (!active) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn("inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary", className)}
    >
      <Loader2 size={12} className="animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function SearchPendingPanel({ label }: { label?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-12 text-center shadow-stone" aria-busy="true">
      <SearchProgress active label={label} className="justify-center" />
    </div>
  );
}

export function ListErrorPanel({ message = "Couldn't load these results." }: { message?: string }) {
  return (
    <div role="alert" className="rounded-lg border border-err/40 bg-err/5 px-4 py-10 text-center text-sm text-err">
      <div className="font-semibold">Failed to load</div>
      <div className="mt-1 text-xs text-ink-muted">{message}</div>
    </div>
  );
}
