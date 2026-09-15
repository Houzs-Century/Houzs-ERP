import { ChevronDown } from "lucide-react";
import { PROJECT_STATUS_OPTIONS } from "../../vendor/scm/lib/pms-project-status";
import { cn } from "../../lib/utils";
import type { ProjectStatus } from "./types";

// Project status palette — drives the calendar tint, the spec strip
// pill, and the header dropdown.
// Premium earth-tone status palette — pine / brass / clay — tuned for the
// cream canvas + Nature Black brand. Replaces the generic primary
// blue/amber/red. `hex` drives the calendar bar tint+rail and legend dots;
// `chip`/`ring` are the matching pill tints used by the list view + the
// status dropdown.
// WHICH statuses exist and what they are CALLED live in pms-project-status.ts,
// shared with mobile. Only the palette is desktop's — mobile styles inline, so
// the value->label contract is the part that must not drift (the same split
// pms-status.ts uses for stages).
const STATUS_TINT: Record<ProjectStatus, { hex: string; chip: string; ring: string }> = {
  confirmed: { hex: "#3f6b53", chip: "bg-[#e8efe9] text-[#2f5341]", ring: "ring-[#3f6b53]/30" },
  pending:   { hex: "#c2740f", chip: "bg-[#f7e8d2] text-[#8a4e0e]", ring: "ring-[#c2740f]/30" },
  cancelled: { hex: "#b23b3b", chip: "bg-[#f4dede] text-[#8a2f2f]", ring: "ring-[#b23b3b]/30" },
};
export const STATUS_OPTIONS = PROJECT_STATUS_OPTIONS.map((o) => ({ ...o, ...STATUS_TINT[o.value] }));

// Partial on purpose: a row can carry a status outside the union, and every
// lookup's `?? STATUS_BY_VALUE.pending` is what renders it instead of crashing.
export const STATUS_BY_VALUE: Partial<Record<ProjectStatus, typeof STATUS_OPTIONS[number]>> &
  Record<"pending", typeof STATUS_OPTIONS[number]> = STATUS_OPTIONS.reduce(
  (acc, s) => ({ ...acc, [s.value]: s }),
  {} as Record<ProjectStatus, typeof STATUS_OPTIONS[number]>
);

export function statusBarStyle(status: ProjectStatus | null | undefined): React.CSSProperties {
  const opt = STATUS_BY_VALUE[status ?? "pending"] ?? STATUS_BY_VALUE.pending;
  // Colour is driven by the `.cal-bar` class off this `--bar` custom
  // property: a soft tint + status rail + ink text at rest, deepening to
  // the solid status fill on hover. Keeps the month grid calm/scannable
  // while preserving the bold colour on the bar you're pointing at.
  return { ["--bar" as string]: opt.hex } as React.CSSProperties;
}

export function ProjectStatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: ProjectStatus;
  onChange: (next: ProjectStatus) => void;
  disabled?: boolean;
}) {
  const cur = STATUS_BY_VALUE[value] ?? STATUS_BY_VALUE.pending;
  return (
    <div className="relative inline-flex">
      <span
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
        style={{ background: cur.hex, width: 8, height: 8, borderRadius: 999 }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ProjectStatus)}
        disabled={disabled}
        className={cn(
          "appearance-none rounded-md border border-border bg-surface py-1.5 pl-6 pr-7 text-[12px] font-semibold uppercase tracking-wide text-ink outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60",
          cur.chip
        )}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted" />
    </div>
  );
}
