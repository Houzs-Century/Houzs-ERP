// The phone Sales Orders "Filter" sheet — owner-approved layout 2026-09-14:
//   · the status list stays the FIRST filter, each with its count (counts come
//     from the server and already reflect the APPLIED second-level filters);
//     zero-count statuses fold into one compact line;
//   · "MORE FILTERS · n" rows [field ▾][value ▾][delete] and "+ Add filter";
//   · footer [Clear] [Apply · n orders], the n previewing the DRAFT.
// Presentation only. What a row means, the URL, the preview request and the
// server predicates are the shared layer (vendor/scm/lib/so-list-filter-state.ts
// + vendor/shared/so-list-filter-model.ts), which the desktop bar uses too.
import { useState } from "react";
import { soFilterIsComplete, soTodayYmd, type SoListFilter } from "../vendor/shared/so-list-filter-model";
import { useSoListCountPreview } from "../vendor/scm/lib/so-list-filter-state";
import { SoFilterRowsEditor } from "../components/so-list-filter/SoFilterRowsEditor";
import { useSoFilterLookups } from "../components/so-list-filter/useSoFilterLookups";

export function MobileSoFilterSheet({
  appliedStatus,
  appliedFilters,
  statusOptions,
  statusCounts,
  q,
  onApply,
  onClear,
  onClose,
}: {
  appliedStatus: string;
  appliedFilters: readonly SoListFilter[];
  statusOptions: ReadonlyArray<{ key: string; label: string }>;
  /** Server counts for the APPLIED filters; undefined on an old backend. */
  statusCounts: Record<string, number> | undefined;
  q: string;
  onApply: (next: { status: string; filters: SoListFilter[] }) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState(appliedStatus);
  const [draft, setDraft] = useState<SoListFilter[]>(() => [...appliedFilters]);
  const lookups = useSoFilterLookups(draft);
  const preview = useSoListCountPreview({ status, q, filters: draft, enabled: true });
  const complete = draft.filter(soFilterIsComplete);
  const today = soTodayYmd(new Date());

  const full = statusOptions.filter(
    (o) => !statusCounts || o.key === "all" || o.key === status || (statusCounts[o.key] ?? 0) > 0,
  );
  const zero = statusCounts ? statusOptions.filter((o) => !full.includes(o)) : [];

  return (
    <div className="sheet-bd" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxHeight: "88%" }}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="eyebrow">Filter</div>
            <div className="scr-title" style={{ fontSize: 17 }}>Order status</div>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="sheet-scroll" style={{ gap: 8 }}>
          {full.map(({ key, label }) => {
            const on = status === key;
            return (
              <button key={key} type="button" onClick={() => setStatus(key)} className="mcard" aria-pressed={on}
                style={{ justifyContent: "space-between", ...(on ? { borderColor: "var(--brand)", background: "var(--brand-bg)" } : null) }}>
                <span className="ml" style={on ? { color: "var(--brand-d)" } : undefined}>{label}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                  {statusCounts && (
                    <span className="money" style={{ fontSize: 12, fontWeight: 700, color: on ? "var(--brand-d)" : "var(--mut)" }}>
                      {statusCounts[key] ?? 0}
                    </span>
                  )}
                  {on && <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-d)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
                </span>
              </button>
            );
          })}
          {zero.length > 0 && (
            <div data-testid="so-status-zero-line" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--mut)", padding: "2px 4px" }}>
              <span aria-hidden>+</span>
              {zero.map(({ key, label }, i) => (
                <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <button type="button" onClick={() => setStatus(key)}
                    style={{ border: "none", background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline dotted" }}>
                    {label} 0
                  </button>
                  {i < zero.length - 1 && <span aria-hidden style={{ opacity: 0.5 }}>·</span>}
                </span>
              ))}
            </div>
          )}

          <div className="mgh" style={{ padding: "10px 3px 2px" }}>
            <span className="gl">More filters · {complete.length}</span>
            <span className="gr" />
          </div>
          <SoFilterRowsEditor skin="mobile" draft={draft} onDraftChange={setDraft} lookups={lookups} today={today} />
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn-ghost" style={{ flex: "0 0 34%" }} onClick={onClear}>Clear</button>
          <button type="button" className="btn" style={{ flex: 1 }}
            onClick={() => onApply({ status, filters: complete })}>
            Apply · {preview.count === undefined ? "…" : `${preview.count.toLocaleString("en-MY")} orders`}
          </button>
        </div>
      </div>
    </div>
  );
}
