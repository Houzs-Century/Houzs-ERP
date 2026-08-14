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

/**
 * How many options reach the DOM at once. The menu is 280px tall — about ten
 * visible rows — so rendering the whole list builds thousands of pixels of <li>
 * inside it and rebuilds them on every keystroke. One page, extended on scroll.
 *
 * HOOKKA measured the identical component on their prod (2026-08-01): opening a
 * 360-option product picker cost a 1,383ms main-thread task and took the DOM
 * from 906 to 2,354 nodes, with another 1,024ms on the next keystroke.
 */
const OPTION_PAGE = 60;

/** Extend the window by one page, never past the end. Pure, so it is testable
 *  without a DOM. (Our menu has no keyboard navigation, so unlike HOOKKA's
 *  version this does not need to lead a highlight index — if arrow keys are
 *  ever added here, the slice must also stay ahead of the highlight or Enter
 *  will commit an option that was never rendered.) */
export function nextOptionWindow(current: number, total: number, step = OPTION_PAGE): number {
  if (total <= 0) return 0;
  const safeCurrent = Math.max(0, Math.floor(current));
  const safeStep = Math.max(1, Math.floor(step));
  return Math.min(total, safeCurrent + safeStep);
}

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
  // FILTERING stays over the full list; only what reaches the DOM is capped.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, search]);

  // How many of `filtered` are rendered. Rewound whenever the term or the open
  // state changes — DURING RENDER, not in an effect, so no frame ever shows the
  // previous term's scroll depth against the new term's results.
  const [shown, setShown] = useState(OPTION_PAGE);
  const windowKey = `${open ? "o" : "c"}:${search}`;
  const [lastWindowKey, setLastWindowKey] = useState(windowKey);
  if (windowKey !== lastWindowKey) {
    setLastWindowKey(windowKey);
    setShown(OPTION_PAGE);
  }
  const visible = filtered.length > shown ? filtered.slice(0, shown) : filtered;
  const hiddenCount = filtered.length - visible.length;

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
        /* House rule (owner 2026-08-09): opening a picker must KEEP the
           current value in view — seed the search with it, select-all so
           typing replaces. Blur without a pick restores via the value
           binding. Same non-lossy pattern as Divan/Gap native selects. */
        onFocus={(e) => {
          setOpen(true);
          setSearch(selectedLabel ?? "");
          e.currentTarget.select();
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
            onScroll={(e) => {
              if (hiddenCount === 0) return;
              const el = e.currentTarget;
              // One page ahead of the viewport, so the extension lands before
              // the operator reaches the bottom.
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
                setShown((s) => nextOptionWindow(s, filtered.length));
              }
            }}
          >
            {filtered.length > 0 ? (
              visible.map((o) => {
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
            {hiddenCount > 0 && (
              // Without this the list looks complete at 60 and the operator
              // types a term they could have scrolled to.
              <li
                aria-live="polite"
                style={{
                  padding: "6px 10px",
                  color: "var(--fg-muted, #888)",
                  fontSize: "var(--fs-12, 12px)",
                  borderTop: "1px solid var(--line, #dcdcd2)",
                  marginTop: 2,
                }}
              >
                {hiddenCount} more — keep scrolling, or type to narrow.
              </li>
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
