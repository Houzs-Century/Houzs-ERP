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
      })).filter((x) => x.fields.length > 0),
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
      {groups.map(({ g, fields }) => (
        <div key={g} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className={k.label}>{SO_FILTER_GROUP_LABELS[g]}</div>
          {fields.map((f) => (
            <button key={f.key} type="button" className={k.option(false)} onClick={() => onPick(f.key)}
              style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span style={{ fontWeight: 700 }}>{f.label}</span>
              {f.hint && <span style={{ fontSize: 11, color: "#8a8f84", fontWeight: 400 }}>{f.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
