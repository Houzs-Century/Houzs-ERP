import {
  categoryChipList,
  toggleCategory,
} from "../lib/assrProductCategories";
import "./mobile.css";

/* Product-category chips for a service case, on the phone.
 *
 * The desktop twin is `CategoryChips` in `frontend/src/pages/ServiceCases.tsx`.
 * Only the MARKUP differs — desktop is Tailwind inside the app shell, this is
 * the `.hz-m` phone design. Every RULE (which chips exist, that a retired value
 * stays selectable, what a toggle produces) comes from
 * `frontend/src/lib/assrProductCategories.ts`, which both files import. That
 * split is deliberate: re-deriving the rule beside the markup is what put free
 * text on this column in the first place.
 *
 * `onChange` fires per toggle with the FULL next array, matching desktop —
 * `PATCH /api/assr/:id` takes the complete set and rewrites the
 * `assr_case_categories` join rows from it, so a partial list would delete
 * categories the operator did not deselect. */
export function MobileAssrCategoryChips({
  options,
  value,
  onChange,
  disabled,
}: {
  /** Names from `assr_product_categories`, in the lookup's own sort order. */
  options: string[];
  /** The case's current categories. */
  value: string[];
  /** Receives the complete next set. */
  onChange: (next: string[]) => void;
  /** REQUIRED: whether the case is locked / a save is in flight. Not optional —
   *  an omitted "is this editable" flag defaulting to editable is the
   *  optional-param-noop class this repo keeps paying for. */
  disabled: boolean;
}) {
  const chips = categoryChipList(options, value);
  if (chips.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "#9aa093" }}>
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
              color: on ? "#16695f" : "#767b6e",
            }}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
