// Verification step outcome picker: Accepted (green), Needs more info (yellow),
// Rejected (red). Kept out of ServiceCases.tsx, which is at its size ceiling.
import type { ReactElement } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";

export type VerificationOutcome = "accepted" | "needs_more_info" | "rejected";

export interface VerificationOutcomeChipsProps {
  outcome: string | null;
  isDisabled: boolean;
  onPick: (next: VerificationOutcome | null) => void;
}

const OPTIONS = [
  {
    value: "accepted",
    label: "Accepted",
    activeClass: "border-synced bg-synced-bg text-synced",
    idleClass: "hover:border-synced/50",
  },
  {
    value: "needs_more_info",
    label: "Needs more info",
    activeClass: "border-warning-text/50 bg-warning-bg text-warning-text",
    idleClass: "hover:border-warning-text/40",
  },
  {
    value: "rejected",
    label: "Rejected",
    activeClass: "border-err bg-err-bg text-err",
    idleClass: "hover:border-err/40",
  },
] as const;

export function VerificationOutcomeChips({ outcome, isDisabled, onPick }: VerificationOutcomeChipsProps): ReactElement {
  return (
    <div className="flex flex-wrap gap-1.5">
      {OPTIONS.map((option) => {
        const isActive = outcome === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isActive}
            disabled={isDisabled}
            onClick={() => onPick(isActive ? null : option.value)}
            className={cn(
              "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-4 py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-50",
              isActive ? option.activeClass : cn("border-border bg-surface text-ink-secondary", option.idleClass),
            )}
          >
            {isActive && <Check size={14} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
