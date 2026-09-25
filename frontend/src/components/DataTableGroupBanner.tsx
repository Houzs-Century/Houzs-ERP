import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * "Drag a column header here to group" (SCM DataGrid parity, owner chose full
 * parity 2026-09-25). Headers are already HTML5-draggable for reordering; the
 * banner accepts the same drag, so the page's `dragKey` is the column in flight.
 */
export function DataTableGroupBanner({
  groups,
  labelOf,
  dragKey,
  canGroup,
  onAdd,
  onRemove,
}: {
  groups: string[];
  labelOf: (key: string) => string;
  dragKey: string | null;
  canGroup: (key: string) => boolean;
  onAdd: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const [over, setOver] = useState(false);
  const accepts = dragKey != null && canGroup(dragKey) && !groups.includes(dragKey);
  return (
    <div
      data-testid="group-banner"
      onDragOver={(e) => {
        if (!accepts) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!accepts) return;
        e.preventDefault();
        onAdd(dragKey);
      }}
      className={cn(
        "mb-2 flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-[12px] text-ink-muted transition-colors",
        over ? "border-primary bg-primary-soft" : "border-border bg-surface-dim/40",
      )}
    >
      {groups.length === 0 ? (
        <span>Drag a column header here to group by that column.</span>
      ) : (
        <>
          <span className="font-semibold text-ink-secondary">Grouped by:</span>
          {groups.map((k, i) => (
            <span key={k} className="inline-flex items-center gap-1">
              {i > 0 && <span aria-hidden>›</span>}
              <span className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-ink">
                {labelOf(k)}
                <button
                  type="button"
                  aria-label={`Stop grouping by ${labelOf(k)}`}
                  onClick={() => onRemove(k)}
                  className="rounded text-ink-muted hover:text-primary"
                >
                  <X size={12} />
                </button>
              </span>
            </span>
          ))}
        </>
      )}
    </div>
  );
}
