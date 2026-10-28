// The operator + value editor for ONE SO list filter row, shared by the phone
// sheet and the desktop panel. It edits a draft row through `onChange`; whether
// the row is complete, and what it means, is the shared model's business.
import { useMemo, useState } from "react";
import {
  SO_DATE_PRESETS,
  SO_OP_LABELS,
  soFilterField,
  soRangeEnds,
  type SoFilterOp,
  type SoListFilter,
} from "../../vendor/shared/so-list-filter-model";
import { SoDateRangeCalendar } from "./SoDateRangeCalendar";
import { DateField } from "../../vendor/scm/components/DateField";
import { SO_FILTER_SKINS, type SoFilterSkin } from "./soFilterSkin";
import type { SoFilterLookups, SoFilterOption } from "./useSoFilterLookups";


const range = (a: string, b: string) => `${a.trim()}~${b.trim()}`;

export function SoFilterValueEditor({
  skin,
  row,
  lookups,
  today,
  onChange,
}: {
  skin: SoFilterSkin;
  row: SoListFilter;
  lookups: SoFilterLookups;
  today: string;
  onChange: (patch: Partial<Pick<SoListFilter, "op" | "value">>) => void;
}) {
  const k = SO_FILTER_SKINS[skin];
  const def = soFilterField(row.field);
  if (!def) return null;

  const opChips = (ops: readonly SoFilterOp[], labelOf: (op: SoFilterOp) => string = (op) => SO_OP_LABELS[op]) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {ops.map((op) => (
        <button key={op} type="button" className={k.chip(row.op === op)} aria-pressed={row.op === op}
          onClick={() => onChange({ op, value: op === row.op ? row.value : "" })}>
          {labelOf(op)}
        </button>
      ))}
    </div>
  );

  switch (def.kind) {
    case "person":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {opChips(def.ops, (op) => (op === "me" ? "Is me" : "Pick a person"))}
          {row.op === "is" && <OptionList skin={skin} options={lookups.people} noun="people" value={row.value} onPick={(id) => onChange({ value: id })} />}
        </div>
      );
    case "warehouse":
      return <OptionList skin={skin} options={lookups.warehouses} noun="warehouses" value={row.value} onPick={(id) => onChange({ value: id })} />;
    case "text":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {def.ops.length > 1 && opChips(def.ops)}
          <input autoFocus className={k.input} value={row.value} maxLength={80} aria-label={`${def.label} value`}
            placeholder={`${def.label}…`} onChange={(e) => onChange({ value: e.target.value })} />
        </div>
      );
    case "docRange": {
      const [a, b] = soRangeEnds(row.value);
      return (
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
            <span className={k.label}>From</span>
            <input className={k.input} value={a} maxLength={40} placeholder="e.g. HC-SO-013000" aria-label="From order no."
              onChange={(e) => onChange({ value: range(e.target.value, b) })} />
          </label>
          <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
            <span className={k.label}>To</span>
            <input className={k.input} value={b} maxLength={40} placeholder="e.g. HC-SO-013100" aria-label="To order no."
              onChange={(e) => onChange({ value: range(a, e.target.value) })} />
          </label>
        </div>
      );
    }
    case "date": {
      const [a, b] = row.op === "between" ? soRangeEnds(row.value) : ["", ""];
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {SO_DATE_PRESETS.map((p) => (
              <button key={p.value} type="button" className={k.chip(row.op === "preset" && row.value === p.value)}
                aria-pressed={row.op === "preset" && row.value === p.value}
                onClick={() => onChange({ op: "preset", value: p.value })}>
                {p.label}
              </button>
            ))}
            <button type="button" className={k.chip(row.op === "between")} aria-pressed={row.op === "between"}
              onClick={() => onChange({ op: "between", value: row.op === "between" ? row.value : "" })}>
              Pick range
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(["on", "before", "after"] as const).map((op) => (
              <button key={op} type="button" className={k.chip(row.op === op)} aria-pressed={row.op === op}
                onClick={() => onChange({ op, value: row.op === op ? row.value : today })}>
                {SO_OP_LABELS[op]}
              </button>
            ))}
          </div>
          {row.op === "between" && (
            <SoDateRangeCalendar from={a} to={b} today={today} months={skin === "desktop" ? 2 : 1}
              onChange={(from, to) => onChange({ value: from || to ? `${from}~${to}` : "" })} />
          )}
          {(row.op === "on" || row.op === "before" || row.op === "after") && (
            <DateField fullWidth value={row.value} aria-label={`${def.label} ${row.op}`}
              onChange={(iso) => onChange({ value: iso })} />
          )}
        </div>
      );
    }
    case "money": {
      const [a, b] = row.op === "between" ? soRangeEnds(row.value) : ["", ""];
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {opChips(def.ops)}
          {row.op === "between" ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input className={k.input} inputMode="decimal" value={a} placeholder="From RM" aria-label="From amount"
                onChange={(e) => onChange({ value: range(e.target.value, b) })} />
              <input className={k.input} inputMode="decimal" value={b} placeholder="To RM" aria-label="To amount"
                onChange={(e) => onChange({ value: range(a, e.target.value) })} />
            </div>
          ) : row.op !== "positive" ? (
            <input autoFocus className={k.input} inputMode="decimal" value={row.value} placeholder="Amount in RM"
              aria-label={`${def.label} amount`} onChange={(e) => onChange({ value: e.target.value })} />
          ) : null}
        </div>
      );
    }
    case "choice":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(def.choices ?? []).map((c) => (
            <button key={c.value} type="button" className={k.option(row.value === c.value)} aria-pressed={row.value === c.value}
              onClick={() => onChange({ value: c.value })}
              style={skin === "mobile" && row.value === c.value ? { borderColor: "var(--brand)", background: "var(--brand-bg)" } : undefined}>
              <span className="ml">{c.label}</span>
            </button>
          ))}
        </div>
      );
  }
}

function OptionList({ skin, options, noun, value, onPick }: {
  skin: SoFilterSkin;
  options: readonly SoFilterOption[];
  noun: string;
  value: string;
  onPick: (id: string) => void;
}) {
  const k = SO_FILTER_SKINS[skin];
  const [term, setTerm] = useState("");
  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    return options.filter((p) => !t || p.name.toLowerCase().includes(t)).slice(0, 40);
  }, [options, term]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input className={k.input} type="search" value={term} placeholder={`Search ${noun}`} aria-label={`Search ${noun}`}
        onChange={(e) => setTerm(e.target.value)} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
        {shown.map((p) => (
          <button key={p.id} type="button" className={k.option(p.id === value)} aria-pressed={p.id === value}
            onClick={() => onPick(p.id)}
            style={skin === "mobile" && p.id === value ? { borderColor: "var(--brand)", background: "var(--brand-bg)" } : undefined}>
            <span className="ml">{p.name}</span>
          </button>
        ))}
        {shown.length === 0 && <div className={k.muted}>No one matches.</div>}
      </div>
    </div>
  );
}
