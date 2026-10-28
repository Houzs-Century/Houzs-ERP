import type { LucideIcon } from "lucide-react";
import { prefetchRoute } from "../lib/prefetch-routes";

export interface HubCard {
  key: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  /** Optional trailing count chip (e.g. open cases). */
  count?: number;
  onClick: () => void;
}

/**
 * Section-hub card grid — the landing pattern used by Supply Chain / Team /
 * Service Cases / Projects: each card jumps to a sub-section. Petrol hover
 * (lift + border) matches Theme C. Pure presentational; the caller wires up
 * the cards (label, icon, click).
 */
export function HubGrid({ cards }: { cards: HubCard[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <button
            key={c.key}
            onClick={c.onClick}
            // Warm the destination chunk on hover, mirroring the sidebar: the SCM
            // hubs key each card by its route path, so the click lands on an
            // already-fetched chunk instead of the skeleton flash. A no-op for a
            // card whose key isn't a known route (other hubs), so it's safe here.
            onMouseEnter={() => prefetchRoute(c.key)}
            className="group flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4 text-left shadow-stone transition-all duration-150 hover:-translate-y-px hover:border-primary hover:shadow-slab"
          >
            <div className="flex w-full items-start justify-between">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-surface-2 text-ink-secondary transition-colors group-hover:bg-primary-soft group-hover:text-primary">
                <Icon size={17} />
              </span>
              {c.count != null && c.count > 0 && (
                <span className="rounded-full bg-primary-soft px-1.5 py-0.5 font-mono text-[10px] font-bold text-primary-ink">
                  {c.count}
                </span>
              )}
            </div>
            <span className="text-[13px] font-bold text-ink">{c.label}</span>
            {c.description && (
              <span className="text-[11px] leading-snug text-ink-muted">{c.description}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
