import { cn } from "../../lib/utils";
import type { PortalStatusColor } from "../types";

// Status colour tokens — server-authoritative (the portal API returns
// `status_color`). Keeping the mapping here ensures the UI cannot
// diverge from the business rule if a new stage is added.
const COLOR_CLASS: Record<PortalStatusColor, string> = {
  grey:   "bg-ink-muted/10 text-ink-secondary border-ink-muted/20",
  blue:   "bg-blue-500/10 text-blue-700 border-blue-500/30",
  amber:  "bg-amber-500/10 text-amber-700 border-amber-500/30",
  violet: "bg-violet-500/10 text-violet-700 border-violet-500/30",
  green:  "bg-synced/10 text-synced border-synced/30",
};

export function StatusPill({ color, label }: { color: PortalStatusColor; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        COLOR_CLASS[color] ?? COLOR_CLASS.grey
      )}
    >
      {label}
    </span>
  );
}
