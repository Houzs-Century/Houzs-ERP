import { Pin, PinOff } from "lucide-react";

/** Keys of the movable columns from the first through `key`, in screen
 *  order: what "Freeze up to here" pins. Empty when `key` is not on screen. */
export function keysThrough(columns: readonly { key: string; alwaysVisible?: boolean }[], key: string): string[] {
  const at = columns.findIndex((c) => c.key === key);
  return at < 0 ? [] : columns.slice(0, at + 1).filter((c) => !c.alwaysVisible).map((c) => c.key);
}

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
