import { useState, type ReactElement, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface CaseSectionProps {
  title: string;
  badge: string | null;
  icon: ReactNode | null;
  action: ReactNode | null;
  isCollapsible: boolean;
  children: ReactNode;
}

export function CaseSection({ title, badge, icon, action, isCollapsible, children }: CaseSectionProps): ReactElement {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <section className="overflow-hidden rounded-md border border-border-subtle bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border-subtle bg-primary-soft px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-primary">
          {icon}
          <h4 className="truncate text-[11px] font-bold uppercase tracking-brand">{title}</h4>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {badge && (
            <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-primary">{badge}</span>
          )}
          {action}
          {isCollapsible && (
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={isOpen ? `Collapse ${title}` : `Expand ${title}`}
              onClick={() => setIsOpen((open) => !open)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-primary hover:bg-surface/60"
            >
              <ChevronDown size={16} className={cn("transition-transform", isOpen && "rotate-180")} />
            </button>
          )}
        </div>
      </header>
      {isOpen && <div className="space-y-2.5 px-3 py-3">{children}</div>}
    </section>
  );
}
