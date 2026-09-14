// The desktop Sales Orders list's second-level filters — the status pills stay
// the FIRST filter; this bar sits beside them: one chip per applied row (click
// to edit, x to remove) and a "Filters" button opening a panel with the same
// MORE FILTERS rows, grouped field picker and [Clear] [Apply · n orders] footer
// the phone sheet has. Presentation only: the rows, URL state, count preview and
// server predicates are the shared layer (vendor/scm/lib/so-list-filter-state.ts
// + vendor/shared/so-list-filter-model.ts), identical to mobile's.
import { useEffect, useRef, useState } from "react";
import {
  soFilterField,
  soFilterIsComplete,
  soFilterSummary,
  soTodayYmd,
  type SoListFilter,
} from "../../vendor/shared/so-list-filter-model";
import { draftRemove, useSoListCountPreview, useSoListFilters } from "../../vendor/scm/lib/so-list-filter-state";
import { SoFilterRowsEditor } from "../../components/so-list-filter/SoFilterRowsEditor";
import { useSoFilterLookups } from "../../components/so-list-filter/useSoFilterLookups";
import { SO_FILTER_SKINS } from "../../components/so-list-filter/soFilterSkin";

export function SoListFilterBar({ q }: { q: string }) {
  const { filters, status, apply } = useSoListFilters();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SoListFilter[]>([]);
  const lookups = useSoFilterLookups(open ? draft : filters);
  const preview = useSoListCountPreview({ status, q, filters: draft, enabled: open });
  const boxRef = useRef<HTMLDivElement>(null);
  const k = SO_FILTER_SKINS.desktop;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const openPanel = () => { setDraft([...filters]); setOpen(true); };
  const complete = draft.filter(soFilterIsComplete);

  return (
    <div ref={boxRef} className="relative flex flex-wrap items-center gap-2">
      {filters.map((f, i) => (
        <span key={`${f.field}-${i}`} className="inline-flex items-center gap-1 rounded-full border border-primary/50 bg-primary-soft py-1 pl-3 pr-1 text-[12px] text-primary-ink">
          <button type="button" className="font-semibold" onClick={openPanel}>
            {soFilterField(f.field)?.label}: <span className="font-normal">{soFilterSummary(f, lookups.labels)}</span>
          </button>
          <button type="button" aria-label={`Remove ${soFilterField(f.field)?.label} filter`}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-primary/15"
            onClick={() => apply({ filters: draftRemove(filters, i) })}>
            &times;
          </button>
        </span>
      ))}
      <button type="button" onClick={() => (open ? setOpen(false) : openPanel())} aria-expanded={open}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12px] font-semibold uppercase tracking-wider text-ink-secondary hover:border-primary/60 hover:text-primary">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
        {filters.length > 0 ? `Filters · ${filters.length}` : "More filters"}
      </button>
      {open && (
        <div role="dialog" aria-label="More filters"
          className="absolute left-0 top-full z-30 mt-2 flex max-h-[70vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border bg-surface shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span className={k.label}>More filters · {complete.length}</span>
          </div>
          <div className="overflow-y-auto px-4 py-3">
            <SoFilterRowsEditor skin="desktop" draft={draft} onDraftChange={setDraft} lookups={lookups} today={soTodayYmd(new Date())} />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            <button type="button" className={k.ghostButton} onClick={() => { apply({ filters: [] }); setOpen(false); }}>Clear</button>
            <button type="button" className={k.primaryButton} onClick={() => { apply({ filters: complete }); setOpen(false); }}>
              Apply · {preview.count === undefined ? "…" : `${preview.count.toLocaleString("en-MY")} orders`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
