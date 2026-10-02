// Form primitives of the mobile New-SO screen, moved out of MobileNewSO.tsx
// unchanged so that file stays under its size ceiling.

export type Opt = { value: string; label: string };

export function Field({ label, error, scanned, onClear, style, children }: { label: string; error?: boolean; scanned?: boolean; onClear?: () => void; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <label className="fld" style={style}>
      <span className="fld-l" style={{ display: "flex", alignItems: "center", gap: 6, ...(error ? { color: "#b23a3a" } : null) }}>
        {label}
        {scanned && <ScannedTag />}
        {/* A native date input has no way back once a value is set — the iOS
            wheel cannot land on "nothing". Owner, 2026-08-03: "当他不小心选了一个
            日期，它不能 reset 的吗?". A label-level Clear costs no row width, which
            the three-across line row has none of. */}
        {onClear && (
          <span
            role="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
            style={{ marginLeft: "auto", color: "#9aa093", fontSize: 9, fontWeight: 700, letterSpacing: ".04em", cursor: "pointer", padding: "0 2px" }}
          >
            CLEAR
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

function ScannedTag() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 999, background: "#eaf2f0", color: "#16695f", fontSize: 8, fontWeight: 700, letterSpacing: ".04em" }}>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
      SCANNED
    </span>
  );
}

/* SpecSel — a labelled <select> bound to a real option list. */
export function SpecSel({ label, value, opts, onChange, required = false, invalid = false, emptyHint }: {
  label: string; value: string; opts: Opt[]; onChange: (v: string) => void;
  required?: boolean; invalid?: boolean; emptyHint?: string;
}) {
  const hasCurrent = Boolean(value) && opts.some((o) => o.value === value);
  return (
    <Field label={label + (required ? " *" : "")} style={{ flex: 1, minWidth: 0 }}>
      <select
        className="fld-i"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={invalid ? { borderColor: "#b23a3a", boxShadow: "0 0 0 2px rgba(178,58,58,.12)" } : undefined}
      >
        <option value="" disabled>{opts.length === 0 && emptyHint ? emptyHint : "Select…"}</option>
        {value && !hasCurrent && <option value={value}>{value} (current)</option>}
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}
