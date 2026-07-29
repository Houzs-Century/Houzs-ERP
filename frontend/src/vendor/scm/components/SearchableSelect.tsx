// SearchableSelect — a drop-in, type-to-filter replacement for a native
// <select> (owner 2026-07-27, "全部下拉的 option 都要加上搜索功能"). Built for the
// PO editor's long option lists (Fabrics has dozens of rows) but generic: it
// takes the SAME { value, label } options the <select> rendered and filters
// them client-side, so no server plumbing and identical write semantics
// (onChange(value) === the old onChange(e.target.value)).
//
// Behaviour, matching this codebase's proven pickers (SoLineCard's fabric
// combobox): the menu is body-portalled so it escapes a card's overflow clip
// and is pinned under the input on scroll/resize; the SELECTED label always
// shows when closed (a saved value never blanks); an empty search shows every
// option, so a short list still just opens-and-picks.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SearchableSelectOption = { value: string; label: string };

export function SearchableSelect({
  value,
  onChange,
  options,
  disabled = false,
  placeholder = "Select…",
  className,
  invalid = false,
  ariaLabel,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  disabled?: boolean;
  placeholder?: string;
  /** Applied to the input so it matches the surrounding form controls. */
  className?: string;
  invalid?: boolean;
  ariaLabel?: string;
  /** Hover tooltip (e.g. why a field is locked). Falls back to the selected label. */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // The label to show when closed — the selected option's, verbatim.
  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? "",
    [options, value],
  );

  // Client-side filter: empty search → every option (short lists still work).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, search]);

  // Pin the portalled menu under the input, tracking scroll/resize (escapes
  // the card's overflow:hidden clip — same idiom as the SKU/fabric pickers).
  useEffect(() => {
    if (!open || disabled) {
      setMenuPos(null);
      return;
    }
    const update = () => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, disabled]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        className={className}
        aria-label={ariaLabel}
        // Closed → the selected label; open → the live search term.
        value={open ? search : selectedLabel}
        placeholder={selectedLabel ? undefined : placeholder}
        disabled={disabled}
        onFocus={() => {
          setOpen(true);
          setSearch("");
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        title={title ?? (selectedLabel || undefined)}
        style={invalid && !disabled ? { borderColor: "var(--c-festive-b, #B8331F)" } : undefined}
      />
      {open && !disabled && menuPos &&
        createPortal(
          <ul
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              zIndex: 1000,
              maxHeight: 280,
              overflowY: "auto",
              margin: 0,
              padding: 4,
              listStyle: "none",
              background: "var(--c-paper, #fff)",
              border: "1px solid var(--line, #dcdcd2)",
              borderRadius: 8,
              boxShadow: "0 10px 28px rgba(17, 20, 15, 0.14)",
            }}
          >
            {filtered.length > 0 ? (
              filtered.map((o) => {
                const isSel = o.value === value;
                return (
                  <li
                    key={o.value}
                    // onMouseDown + preventDefault so the input doesn't blur-close
                    // before the pick lands.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange(o.value);
                      setSearch("");
                      setOpen(false);
                    }}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: "var(--fs-13, 13px)",
                      color: "var(--c-ink, #1a1a1a)",
                      background: isSel ? "var(--c-cream, #f3f0e9)" : "transparent",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "var(--c-cream, #f3f0e9)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = isSel
                        ? "var(--c-cream, #f3f0e9)"
                        : "transparent";
                    }}
                  >
                    {o.label}
                  </li>
                );
              })
            ) : (
              <li style={{ padding: "6px 10px", color: "var(--fg-muted, #888)", fontSize: "var(--fs-13, 13px)" }}>
                No match{search.trim() ? ` for "${search.trim()}"` : ""}.
              </li>
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
