// "MORE FILTERS" — the draft rows [field ▾][value ▾][delete] and "+ Add filter",
// shared by the phone sheet and the desktop panel. It edits a DRAFT; applying
// it (and previewing its count) belongs to the surface that hosts it.
import { useState } from "react";
import {
  SO_FILTER_MAX_ROWS,
  soFilterField,
  soFilterIsComplete,
  soFilterSummary,
  type SoListFilter,
} from "../../vendor/shared/so-list-filter-model";
import { draftAdd, draftChangeField, draftRemove, draftUpdate } from "../../vendor/scm/lib/so-list-filter-state";
import { SoFilterFieldPicker } from "./SoFilterFieldPicker";
import { SoFilterValueEditor } from "./SoFilterValueEditor";
import type { SoFilterLookups } from "./useSoFilterLookups";
import { SO_FILTER_SKINS, type SoFilterSkin } from "./soFilterSkin";

type PickerState = null | { mode: "add" } | { mode: "change"; index: number };

export function SoFilterRowsEditor({
  skin,
  draft,
  onDraftChange,
  lookups,
  today,
}: {
  skin: SoFilterSkin;
  draft: readonly SoListFilter[];
  onDraftChange: (next: SoListFilter[]) => void;
  lookups: SoFilterLookups;
  today: string;
}) {
  const k = SO_FILTER_SKINS[skin];
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [picker, setPicker] = useState<PickerState>(null);

  if (picker) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button type="button" className={k.chip(false)} style={{ alignSelf: "flex-start" }} onClick={() => setPicker(null)}>
          &lsaquo; Back
        </button>
        <SoFilterFieldPicker
          skin={skin}
          onPick={(field) => {
            if (picker.mode === "add") {
              onDraftChange(draftAdd(draft, field));
              setOpenRow(draft.length);
            } else {
              onDraftChange(draftChangeField(draft, picker.index, field));
              setOpenRow(picker.index);
            }
            setPicker(null);
          }}
        />
      </div>
    );
  }

  const rowBox = skin === "mobile"
    ? { className: "", style: { display: "flex", alignItems: "stretch", gap: 6 } }
    : { className: "flex items-stretch gap-2", style: undefined };
  const fieldBtn = skin === "mobile"
    ? "mcard"
    : "flex min-w-[150px] items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-left text-[13px] font-semibold text-ink hover:border-primary/60";
  const valueBtn = skin === "mobile"
    ? "mcard"
    : "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-left text-[13px] text-ink hover:border-primary/60";
  const trashBtn = skin === "mobile"
    ? "iconbtn"
    : "inline-flex w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-muted hover:border-err hover:text-err";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {draft.map((row, i) => {
        const def = soFilterField(row.field);
        const complete = soFilterIsComplete(row);
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="so-filter-row">
            <div className={rowBox.className} style={rowBox.style}>
              <button type="button" className={fieldBtn} aria-label={`Change field ${def?.label ?? row.field}`}
                style={skin === "mobile" ? { flex: "0 0 38%", justifyContent: "space-between", padding: "9px 10px" } : undefined}
                onClick={() => setPicker({ mode: "change", index: i })}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700, fontSize: 12.5 }}>{def?.label ?? row.field}</span>
                <Caret />
              </button>
              <button type="button" className={valueBtn} aria-expanded={openRow === i} aria-label={`Edit ${def?.label ?? row.field} value`}
                style={skin === "mobile" ? { flex: 1, minWidth: 0, justifyContent: "space-between", padding: "9px 10px", ...(complete ? null : { borderColor: "var(--gold)" }) } : undefined}
                onClick={() => setOpenRow(openRow === i ? null : i)}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, color: complete ? undefined : "#a16a2e" }}>
                  {soFilterSummary(row, lookups.labels)}
                </span>
                <Caret />
              </button>
              <button type="button" className={trashBtn} aria-label={`Remove ${def?.label ?? row.field} filter`}
                onClick={() => { onDraftChange(draftRemove(draft, i)); setOpenRow(null); }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
              </button>
            </div>
            {openRow === i && (
              <div style={{ padding: skin === "mobile" ? "4px 2px 6px" : "4px 0 8px" }}>
                <SoFilterValueEditor skin={skin} row={row} lookups={lookups} today={today}
                  onChange={(patch) => onDraftChange(draftUpdate(draft, i, patch))} />
              </div>
            )}
          </div>
        );
      })}
      {draft.length < SO_FILTER_MAX_ROWS ? (
        <button type="button" className={skin === "mobile" ? "chip" : k.chip(false)}
          style={{ alignSelf: "flex-start", fontWeight: 700 }} onClick={() => setPicker({ mode: "add" })}>
          + Add filter
        </button>
      ) : (
        <div className={k.muted}>Up to {SO_FILTER_MAX_ROWS} filters.</div>
      )}
    </div>
  );
}

function Caret() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", opacity: 0.6 }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
