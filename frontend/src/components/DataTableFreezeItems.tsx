import { Pin, PinOff } from "lucide-react";

/* "Freeze up to here" / "Unfreeze all" — the same two items in the header
   right-click menu and the funnel menu (owner 2026-09-27: freeze the first
   5-6 columns in one step). */
export function DataTableFreezeItems({ className, anyFrozen, onFreezeUpTo, onUnfreezeAll }: {
  className: string;
  anyFrozen: boolean;
  onFreezeUpTo: () => void;
  onUnfreezeAll: () => void;
}) {
  return (
    <>
      <button type="button" className={className} onClick={onFreezeUpTo}>
        <Pin size={13} className="shrink-0 text-ink-muted" />
        Freeze up to here
      </button>
      {anyFrozen && (
        <button type="button" className={className} onClick={onUnfreezeAll}>
          <PinOff size={13} className="shrink-0 text-ink-muted" />
          Unfreeze all
        </button>
      )}
    </>
  );
}
