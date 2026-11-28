import { cn } from "../lib/utils";

interface Pill<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface Props<T extends string> {
  options: Pill<T>[];
  value: T;
  onChange: (v: T) => void;
}

/**
 * In-page filter chip group. Visually paired with <TabStrip/> — both
 * use brass as the active colour, but FilterPills stays compact and
 * self-contained (rounded slab) so it reads as "filter the current
 * view" while TabStrip reads as "switch views".
 */
export function FilterPills<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <div className="inline-block max-w-full overflow-hidden rounded-md border border-border bg-surface shadow-stone align-middle">
      <div
        className={cn(
          "no-scrollbar flex items-center gap-0.5 overflow-x-auto p-1",
          "[&>*]:shrink-0"
        )}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={cn(
                "whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-all duration-150",
                active
                  ? "bg-primary text-white shadow-sm"
                  : "text-ink-secondary hover:bg-primary-soft hover:text-primary"
              )}
            >
              {opt.label}
              {typeof opt.count === "number" && (
                <span
                  className={cn(
                    "ml-1.5 inline-block rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums align-middle",
                    active ? "bg-white/20 text-white" : "bg-bg text-ink-muted"
                  )}
                >
                  {opt.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
