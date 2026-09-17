/**
 * The own-team / supplier toggle shared by a Service Case's three logistics
 * legs on mobile — inspection, pickup and delivery. Each leg reaches the HC
 * Delivery sheet only when its own-team option is chosen (the gate lives in the
 * backend feed); this is just the control that sets the marker.
 *
 * Extracted from MobileServiceCase.tsx so the three legs share one control and
 * that file stays under its size ceiling. Colours are local literals, as
 * elsewhere in the mobile tree (there is no shared mobile palette module).
 */
const INK_SEC = "#3f463a";
const BROWN = "#a16a2e";
const BROWN_SOFT = "#f6efd9";
const BROWN_FG = "#8a6a2e";
const LINE = "#d6d9d2";

export type LegOwnerOption = { v: string; label: string };

/** A two- or three-way toggle: the chosen value is passed to `onPick`, or
 *  `null` when the current option is tapped again (clearing it). */
export function LegOwnerToggle({
  label,
  options,
  current,
  onPick,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<LegOwnerOption>;
  current: unknown;
  onPick: (value: string | null) => void;
  disabled: boolean;
}) {
  const cur = String(current ?? "");
  return (
    <>
      <div className="fld-l" style={{ marginTop: 10, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        {options.map((o) => {
          const on = cur === o.v;
          return (
            <button
              key={o.v}
              onClick={() => { if (!disabled) onPick(on ? null : o.v); }}
              disabled={disabled}
              style={{
                flex: 1, height: 40, borderRadius: 10, cursor: disabled ? "default" : "pointer", fontFamily: "inherit",
                fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                border: `1px solid ${on ? BROWN : LINE}`, background: on ? BROWN_SOFT : "#fff", color: on ? BROWN_FG : INK_SEC,
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {on && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={BROWN_FG} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
              )}
              {o.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
