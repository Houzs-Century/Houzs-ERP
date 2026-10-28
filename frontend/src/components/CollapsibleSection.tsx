// ----------------------------------------------------------------------------
// CollapsibleSection — one open/closable sub-module inside a maintenance page.
//
// WHY. Owner, 2026-08-01: the reference-data pages should be ONE module with
// each sub-module openable and closable, rather than a nav list of separate
// screens. A maintenance page is a scroll-tower of unrelated config surfaces;
// closing the five you are not editing is the difference between a page you can
// work in and one you scroll through.
//
// URL IS STATE (house rule). Which sections are open lives in ?open=, so a link
// to "the Fleet section of Delivery Maintenance" is a real link and a reload
// keeps what you had open. localStorage would make it personal-only and
// unshareable.
//
// A CLOSED SECTION DOES NOT RENDER ITS BODY. These bodies each fire their own
// queries, so mounting all six would fan out a dozen requests to draw one table.
// Closed means unmounted, and opening refetches — the lists are small and every
// one of them is already staleTime-cached.
// ----------------------------------------------------------------------------

import { type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';

const PARAM = 'open';

/** The set of open section keys, read from ?open=a,b,c. */
export function useOpenSections(defaultOpen: string[] = []): {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  /** Open without closing — what a jump-to-section control needs. */
  ensureOpen: (key: string) => void;
  setAll: (keys: string[]) => void;
} {
  const [params, setParams] = useSearchParams();
  const raw = params.get(PARAM);
  /* No ?open= at all means "first visit" -> the caller's default. An EMPTY
     ?open= is a deliberate "collapse everything" and must not spring back. */
  const open = new Set(raw === null ? defaultOpen : raw.split(',').filter(Boolean));

  const write = (next: Set<string>) => {
    const p = new URLSearchParams(params);
    p.set(PARAM, [...next].join(','));
    setParams(p, { replace: true });
  };

  return {
    isOpen: (key) => open.has(key),
    toggle: (key) => {
      const next = new Set(open);
      if (next.has(key)) next.delete(key); else next.add(key);
      write(next);
    },
    ensureOpen: (key) => {
      if (open.has(key)) return;
      write(new Set(open).add(key));
    },
    setAll: (keys) => write(new Set(keys)),
  };
}

export const CollapsibleSection = ({ id, title, hint, count, open, onToggle, children }: {
  id: string;
  title: string;
  hint?: string;
  /** A short right-aligned summary shown while closed, e.g. "5 regions". */
  count?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) => (
  <section id={id} className="overflow-hidden rounded-lg border border-border bg-surface">
    {/* The toggle and the trailing slot are SIBLINGS, not nested: `count` is
        allowed to carry a link, and an interactive element inside a <button> is
        invalid HTML that browsers resolve inconsistently. */}
    <div className="flex items-center gap-2.5 px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${id}-body`}
        className="flex flex-1 items-center gap-2.5 text-left transition-colors hover:text-primary"
      >
        <span className="text-ink-muted">
          {open ? <ChevronDown size={16} strokeWidth={1.75} /> : <ChevronRight size={16} strokeWidth={1.75} />}
        </span>
        <span className="font-display text-[12.5px] font-bold uppercase tracking-brand text-primary">{title}</span>
        {hint && <span className="hidden text-[11.5px] text-ink-muted sm:inline">{hint}</span>}
      </button>
      {count != null && <span className="shrink-0 text-[11.5px] text-ink-muted">{count}</span>}
    </div>
    {open && (
      <div id={`${id}-body`} className="border-t border-border px-4 py-4">
        {children}
      </div>
    )}
  </section>
);

export default CollapsibleSection;
