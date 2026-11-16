// Verification step: who inspects the reported issue (own team or supplier).
// Kept out of ServiceCases.tsx, which is at its size ceiling.
import type { ReactElement } from "react";
import { Building2, Info, Users } from "lucide-react";
import { cn } from "../../lib/utils";

export type InspectBy = "own" | "supplier";

export interface InspectByToggleProps {
  value: string | null;
  isDisabled: boolean;
  onPick: (next: InspectBy | null) => void;
}

const OPTIONS = [
  { value: "own", label: "Own team", icon: <Users size={14} /> },
  { value: "supplier", label: "Supplier", icon: <Building2 size={14} /> },
] as const;

export function InspectByToggle({ value, isDisabled, onPick }: InspectByToggleProps): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[13px] font-semibold text-ink">Inspect by</span>
      <div className="flex gap-1.5">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onPick(value === option.value ? null : option.value)}
            disabled={isDisabled}
            className={cn(
              "inline-flex min-h-[36px] items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
              value === option.value
                ? "border-primary bg-primary-soft text-primary"
                : "border-border bg-surface text-ink-secondary hover:border-primary/40",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
      {value === "supplier" && (
        <div className="flex min-w-[220px] flex-1 items-start gap-2 rounded-md bg-bg/60 px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
          <Info size={14} className="mt-0.5 shrink-0" />
          Supplier performs the inspection — progress lands in the supplier portal's service note (see the Supplier
          Pickup / Item Ready rows).
        </div>
      )}
    </div>
  );
}
