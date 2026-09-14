// "+ Add filter" — the searchable, grouped field list (WHO / WHERE / WHEN /
// ORDER AND MONEY), shared by the phone sheet and the desktop panel.
import { useMemo, useState } from "react";
import {
  SO_FILTER_FIELDS,
  SO_FILTER_GROUP_LABELS,
  type SoFilterFieldKey,
  type SoFilterGroup,
} from "../../vendor/shared/so-list-filter-model";
import { SO_FILTER_SKINS, type SoFilterSkin } from "./soFilterSkin";

/* Fields the owner's mockup places in the picker that the list endpoint cannot
   filter yet. Each is a fact about an order's LINES (or a separate table), not
   its header, and the list reads a header view — see the shared model's header.
   Shown switched OFF, with the reason, rather than hidden or faked. */
const NOT_YET: ReadonlyArray<{ label: string; group: SoFilterGroup; why: string }> = [
  { label: "Warehouse", group: "where", why: "Read from the order lines - coming next" },
  { label: "Branding", group: "where", why: "Read from the order lines - coming next" },
  { label: "Item category", group: "order", why: "Read from the order lines - coming next" },
  { label: "Has pending amendment", group: "order", why: "Read from amendments - coming next" },
];

const GROUP_ORDER: SoFilterGroup[] = ["who", "where", "when", "order"];

export function SoFilterFieldPicker({
  skin,
  onPick,
}: {
  skin: SoFilterSkin;
  onPick: (field: SoFilterFieldKey) => void;
}) {
  const k = SO_FILTER_SKINS[skin];
  const [term, setTerm] = useState("");
  const t = term.trim().toLowerCase();
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((g) => ({
        g,
        fields: SO_FILTER_FIELDS.filter((f) => f.group === g && (!t || f.label.toLowerCase().includes(t))),
        off: NOT_YET.filter((f) => f.group === g && (!t || f.label.toLowerCase().includes(t))),
      })).filter((x) => x.fields.length + x.off.length > 0),
    [t],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <input
        autoFocus
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search fields"
        aria-label="Search fields"
        className={k.input}
      />
      {groups.length === 0 && <div className={k.muted}>No field matches "{term}".</div>}
      {groups.map(({ g, fields, off }) => (
        <div key={g} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className={k.label}>{SO_FILTER_GROUP_LABELS[g]}</div>
          {fields.map((f) => (
            <button key={f.key} type="button" className={k.option(false)} onClick={() => onPick(f.key)}
              style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span style={{ fontWeight: 700 }}>{f.label}</span>
              {f.hint && <span style={{ fontSize: 11, color: "#8a8f84", fontWeight: 400 }}>{f.hint}</span>}
            </button>
          ))}
          {off.map((f) => (
            <button key={f.label} type="button" disabled className={k.option(false)}
              style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, opacity: 0.55, cursor: "not-allowed" }}>
              <span style={{ fontWeight: 700 }}>{f.label}</span>
              <span style={{ fontSize: 11, color: "#8a8f84", fontWeight: 400 }}>{f.why}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
