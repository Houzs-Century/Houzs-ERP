import { useOptimisticChoice } from "../hooks/useOptimisticChoice";

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
  onPick: (value: string | null) => Promise<boolean>;
  disabled: boolean;
}) {
  const choice = useOptimisticChoice(current == null || current === "" ? null : String(current));
  const cur = choice.shownValue ?? "";
  return (
    <>
      <div className="fld-l" style={{ marginTop: 10, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        {options.map((o) => {
          const on = cur === o.v;
          return (
            <button
              key={o.v}
              onClick={() => {
                if (disabled) return;
                const nextValue = on ? null : o.v;
                void choice.choose(nextValue, () => onPick(nextValue));
              }}
              disabled={disabled}
              style={{
                flex: 1, height: 40, borderRadius: 10, cursor: disabled ? "default" : "pointer", fontFamily: "inherit",
                fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                border: `1px solid ${on ? BROWN : LINE}`, background: on ? BROWN_SOFT : "var(--hz-c-surface)", color: on ? BROWN_FG : INK_SEC,
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
