import { RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";
import { listMrpLabel, type ListMrpStatus } from "../lib/listMrpStatus";

export function MrpAsOf({ status, className }: { status: ListMrpStatus; className?: string }) {
  const { meta, refresh, refreshing } = status;
  if (!meta && !refreshing) return null;
  const label = meta ? listMrpLabel(meta) : { text: "MRP", warn: false };
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[12px]",
        label.warn ? "text-warning-text" : "text-ink-muted",
        className,
      )}
      data-testid="mrp-as-of"
    >
      <span>{refreshing ? "Recomputing MRP…" : label.text}</span>
      <button
        type="button"
        onClick={refresh}
        disabled={refreshing}
        title="Recompute MRP now (at most once a minute)"
        aria-label="Refresh MRP"
        className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-black/5 disabled:opacity-50"
      >
        <RefreshCw size={12} strokeWidth={2} className={refreshing ? "animate-spin" : ""} />
      </button>
    </div>
  );
}
