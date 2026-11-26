import {
  categoryChipList,
  toggleCategory,
} from "../lib/assrProductCategories";
import "./mobile.css";

export function MobileAssrCategoryChips({
  options,
  value,
  onChange,
  disabled,
}: {
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const chips = categoryChipList(options, value);
  if (chips.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--hz-c-ink-soft)" }}>
        No product categories are configured yet.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {chips.map((name) => {
        const on = value.includes(name);
        return (
          <button
            key={name}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(toggleCategory(value, name))}
            style={{
              borderRadius: 999,
              padding: "5px 11px",
              fontSize: 11.5,
              fontWeight: 700,
              fontFamily: "inherit",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.5 : 1,
              border: `1px solid ${on ? "#16695f" : "#e3e6e0"}`,
              background: on ? "rgba(22,105,95,0.10)" : "#fff",
              color: on ? "var(--hz-c-primary)" : "var(--hz-c-ink-muted)",
            }}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
