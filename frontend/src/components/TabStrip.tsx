import { cn } from "../lib/utils";

/**
 * Page-level tab strip — underlined, brass-accent on active.
 *
 * Matches the tab style used in the Trips page so every module that
 * splits its own surface into tabs (Projects: List/Calendar,
 * Service Cases: Cases/Quality Metrics, Trips: Queue/Drafts/…)
 * looks the same. Filter chips inside a page keep using
 * <FilterPills> — those are for value selection, not navigation.
 */

export interface TabOption<V extends string> {
  value: V;
  label: string;
  /** Hide this tab entirely when false. Omit to always show. */
  show?: boolean;
  /** Optional trailing count badge. */
  count?: number;
}

interface Props<V extends string> {
  value: V;
  onChange: (next: V) => void;
  options: TabOption<V>[];
  className?: string;
}

export function TabStrip<V extends string>({
  value,
  onChange,
  options,
  className,
}: Props<V>) {
  const visible = options.filter((o) => o.show !== false);
  return (
    <div
      className={cn(
        // Outer wrapper owns the bottom border so it spans the full
        // viewport even while the inner row scrolls horizontally — the
        // edge stays anchored when tabs overflow.
        "mb-4 border-b border-border",
        className
      )}
    >
      <div
        className={cn(
          // Negative margin + matching padding lets the scrollable area
          // bleed to the screen edge on phones (where the page itself
          // has px-4) without breaking out of its container on larger
          // screens. Hidden scrollbar keeps the brass aesthetic.
          "no-scrollbar -mx-4 flex items-center gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0",
          // Stop the row from compressing children; let them keep
          // their natural width so long labels never get clipped.
          "[&>*]:shrink-0"
        )}
      >
        {visible.map((t) => {
          const active = t.value === value;
          return (
            <button
              key={t.value}
              onClick={() => onChange(t.value)}
              className={cn(
                "relative -mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-[12px] font-semibold transition-colors",
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-ink-secondary hover:text-ink"
              )}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span
                  className={cn(
                    "inline-flex h-4 min-w-[18px] items-center justify-center rounded-full px-1.5 font-mono text-[9px] font-bold",
                    active
                      ? "bg-primary text-white"
                      : "bg-surface-dim text-ink-muted"
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
