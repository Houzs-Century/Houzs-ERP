import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Search, Check } from "lucide-react";
import { cn } from "../lib/utils";
import { useAnchoredPanel, anchoredPanelStyle } from "../lib/anchoredPanel";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";

export interface UserOptionItem {
  id: number;
  name: string | null;
  email?: string | null;
  department_name?: string | null;
}

/* Perf cap — bound the rendered option DOM. The server already caps the
   typeahead result set (limit 50); this is a belt-and-braces client bound so
   the dropdown can never balloon. (parity with FabricPicker / MobileSkuPicker.) */
const RENDER_CAP = 60;

/* How tall the people list wants to be when there is room (what the old
   `max-h-64` class asked for). lib/anchoredPanel shortens it to the space
   actually available and flips it above the chips when there is more room
   there, so the last person on the list is never off the bottom of the
   window. */
const MENU_MAX_H = 256;

// Minimum characters before the server typeahead fires. Below this we show a
// "type to search" prompt instead of hammering the endpoint on every keystroke.
const MIN_QUERY = 2;

/**
 * Server-side typeahead over /api/users?q=… Keyed on the TRIMMED query so
 * "ali", "ali " and " ali" share one cache entry, and hard-gated below
 * MIN_QUERY chars (enabled:false) so no fetch fires until the user commits to
 * a search. keepPreviousData holds the last matches on screen while the next
 * keystroke's slice loads, avoiding a flash of "No matches".
 */
export function useUsersSearch(
  q: string,
  opts?: { enabled?: boolean },
) {
  const term = q.trim();
  const enabled = (opts?.enabled ?? true) && term.length >= MIN_QUERY;
  return useQuery<{ users: UserOptionItem[] }>("/api/users?q=:",
    () => api.get(`/api/users?q=${encodeURIComponent(term)}`),
    [term],
    { enabled, keepPreviousData: true },
  );
}

/**
 * Searchable, A→Z sorted, multi-select people picker (Nick 2026-07-06:
 * "选人的做成 sort A to Z + 搜索 + multi-select"). Selected people render
 * as removable chips; the dropdown is driven by a SERVER typeahead so a large
 * people directory is never fetched or rendered whole. `max` caps the
 * selection (e.g. 2 for primary + co-assignee) — at the cap, picking another
 * person is ignored until one chip is removed.
 *
 * Selection ORDER is meaningful to callers (first = primary), so chips keep
 * insertion order while the dropdown stays alphabetical.
 *
 * SELECTED DISPLAY: the chips render from `selectedItems` (the caller's
 * resolved objects for the current `value`) UNION every option ever surfaced
 * through search/pick — never from the live typeahead results alone. A
 * selected person outside the current search results is therefore never
 * dropped. The onChange payload stays a plain `number[]` of ids, unchanged.
 *
 * `filterOption` optionally narrows which typeahead RESULTS are pickable
 * (e.g. Operations-only PIC picking). It never hides an already-selected
 * chip — those always display and stay removable.
 *
 * The dropdown renders through a PORTAL with fixed positioning so it escapes
 * any card/panel overflow clipping.
 */
export function UserMultiSelect({
  value,
  onChange,
  selectedItems,
  filterOption,
  max,
  placeholder = "Search people…",
  disabled,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
  /** Resolved objects for the currently-selected ids (for chip display). */
  selectedItems?: UserOptionItem[];
  /** Narrows pickable typeahead results; does not affect selected chips. */
  filterOption?: (u: UserOptionItem) => boolean;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const controlRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const trimmed = query.trim();
  const searchActive = trimmed.length >= MIN_QUERY;
  const search = useUsersSearch(query, { enabled: open });

  // Remember every user object we have ever seen for an id — seeded from the
  // caller's `selectedItems` and topped up from each search result — so a
  // selected chip always has a label even after the typeahead moves on.
  const [known, setKnown] = useState<Record<number, UserOptionItem>>({});
  // Value-idempotent merge: callers rebuild `selectedItems` (and the typeahead
  // rebuilds its rows) on every render, so a reference-only merge would loop.
  // Bail out returning `prev` when nothing actually changed by value.
  const mergeKnown = (rows: readonly UserOptionItem[] | undefined) => {
    if (!rows?.length) return;
    setKnown((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const it of rows) {
        const cur = prev[it.id];
        if (
          !cur ||
          cur.name !== it.name ||
          (cur.email ?? null) !== (it.email ?? null) ||
          (cur.department_name ?? null) !== (it.department_name ?? null)
        ) {
          next[it.id] = it;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  };
  useEffect(() => {
    mergeKnown(selectedItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItems]);
  useEffect(() => {
    mergeKnown(search.data?.users);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.data]);

  // Track the control's viewport position while open so the portalled menu
  // follows it through scrolling panels and window resizes — shared geometry,
  // so this menu flips and clamps exactly like every other one here.
  const rect = useAnchoredPanel(controlRef, open, MENU_MAX_H);

  // Close on outside click — the menu lives in a portal, so check both.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (controlRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
      setQuery("");
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const labelOf = (o: UserOptionItem) => o.name || o.email || `user #${o.id}`;

  // Dropdown options: the server typeahead results, optionally narrowed by
  // filterOption, then A→Z sorted and capped.
  const options = useMemo(() => {
    if (!searchActive) return [];
    let rows = search.data?.users ?? [];
    if (filterOption) rows = rows.filter(filterOption);
    return [...rows].sort((a, b) =>
      labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: "base" }),
    );
  }, [search.data, searchActive, filterOption]);

  // Selected chips — resolved from `known` (never from the live results), so a
  // selected person absent from the current search is still shown & removable.
  const selected = value.map((id) => known[id] ?? { id, name: null });
  const atMax = max != null && value.length >= max;

  function pick(o: UserOptionItem) {
    setKnown((prev) => ({ ...prev, [o.id]: o }));
    if (value.includes(o.id)) {
      onChange(value.filter((v) => v !== o.id));
    } else {
      if (atMax) return;
      onChange([...value, o.id]);
    }
    setQuery("");
    inputRef.current?.focus();
  }

  function removeId(id: number) {
    onChange(value.filter((v) => v !== id));
    inputRef.current?.focus();
  }

  const menu =
    rect
      ? createPortal(
          <div
            ref={menuRef}
            /* zIndex stays this component's own 90 — it is not one of the
               drawer-backdrop pickers the shared 1000 exists for. */
            style={{ ...anchoredPanelStyle(rect), zIndex: 90 }}
            className="overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-stone"
          >
            {max != null && (
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Up to {max} {max === 1 ? "person" : "people"}
                {atMax ? " — remove one to change" : ""}
              </div>
            )}
            {!searchActive && (
              <div className="px-3 py-2 text-[12px] text-ink-muted">
                Type at least {MIN_QUERY} letters to search people…
              </div>
            )}
            {searchActive && search.loading && (
              <div className="px-3 py-2 text-[12px] text-ink-muted">Searching…</div>
            )}
            {searchActive && !search.loading && options.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-ink-muted">No matches</div>
            )}
            {options.slice(0, RENDER_CAP).map((o) => {
              const isSel = value.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => pick(o)}
                  disabled={!isSel && atMax}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-bg",
                    isSel && "font-semibold text-primary",
                    !isSel && atMax && "cursor-not-allowed opacity-45"
                  )}
                >
                  <span className="truncate">{labelOf(o)}</span>
                  {isSel && <Check size={13} className="shrink-0" />}
                </button>
              );
            })}
            {options.length > RENDER_CAP && (
              <div className="px-3 py-1.5 text-[11px] text-ink-muted">
                Showing first {RENDER_CAP} of {options.length} — keep typing to narrow.
              </div>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <div ref={controlRef} className="relative">
      <div
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] transition-colors",
          open && "border-primary ring-2 ring-primary/20",
          disabled && "pointer-events-none opacity-60"
        )}
      >
        {selected.map((o) => (
          <span
            key={o.id}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[12px] font-medium text-primary"
          >
            {labelOf(o)}
            <button
              type="button"
              aria-label={`Remove ${labelOf(o)}`}
              onClick={(e) => {
                e.stopPropagation();
                removeId(o.id);
              }}
              className="rounded-full p-0.5 hover:bg-primary/15"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <span className="flex flex-1 items-center gap-1.5 min-w-[120px]">
          {selected.length === 0 && <Search size={13} className="shrink-0 text-ink-muted" />}
          <input
            ref={inputRef}
            value={query}
            disabled={disabled}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={selected.length === 0 ? placeholder : atMax ? "" : "Add another…"}
            className="w-full min-w-[80px] bg-transparent py-0.5 outline-none placeholder:text-ink-muted"
          />
        </span>
      </div>
      {menu}
    </div>
  );
}
