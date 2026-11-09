import type { ReactElement, ReactNode } from "react";

export interface CaseSectionProps {
  title: string;
  badge: string | null;
  children: ReactNode;
}

export function CaseSection({ title, badge, children }: CaseSectionProps): ReactElement {
  return (
    <section className="overflow-hidden rounded-md border border-border-subtle bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border-subtle bg-primary-soft px-3 py-2">
        <h4 className="text-[11px] font-bold uppercase tracking-brand text-primary">{title}</h4>
        {badge && (
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-primary">{badge}</span>
        )}
      </header>
      <div className="space-y-2.5 px-3 py-3">{children}</div>
    </section>
  );
}
