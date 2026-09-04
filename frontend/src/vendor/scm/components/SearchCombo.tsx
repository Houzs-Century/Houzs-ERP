// ----------------------------------------------------------------------------
// SearchCombo — a type-to-filter replacement for a long native <select>.
//
// Born 2026-09-02 from the owner typing into a 40-account dropdown: 我无法快速
// 打关键字眼搜索account. A native select cannot filter; this is an input that
// shows the chosen option's label, opens a listbox on focus, and narrows it as
// you type — every space-separated token must match somewhere in the label,
// case-insensitively, so "hong current" finds "331-0000 · Bank — Hong Leong
// Current".
//
// Contract with callers: value in / value out (never the label), '' = nothing
// chosen. Closing without picking RESTORES the chosen label — typing is how
// you search, never how you set a value, so a half-typed word can't leave the
// field lying about what is selected. Keyboard: ↑/↓ move, Enter picks, Esc
// closes.
// ----------------------------------------------------------------------------

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export type ComboOption = { value: string; label: string; group?: string };

/* Where the list opens, and how tall it may be. The panel used to open DOWN
   unconditionally at maxHeight 280 — on a form low on the page it ran off the
   bottom of the viewport, taking its own scrollbar with it, and the operator
   could only pick from the rows that happened to be visible (the owner,
   2026-09-04, typing "adver" into a PV line: 为什么我能选的这么少 / 选account
   时会无法看到下面的 — eight matches existed, four were on screen). Now the
   OPEN measures the input against the viewport: flip UP when below can't fit
   the full panel and above offers more room, and cap the height to the side
   actually available — so the whole list, scrollbar included, always sits on
   screen. */
const PANEL_MAX = 280;
const PANEL_MIN = 120;
const EDGE_GAP = 8;

function measureDrop(input: HTMLElement): { up: boolean; maxH: number } {
  const r = input.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - EDGE_GAP;
  const above = r.top - EDGE_GAP;
  const up = below < PANEL_MAX && above > below;
  return { up, maxH: Math.max(PANEL_MIN, Math.min(PANEL_MAX, up ? above : below)) };
}

export function SearchCombo({
  options,
  value,
  onChange,
  className,
  placeholder = '— type to search —',
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}) {
  const chosen = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null = showing the chosen label
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Measured at open (layout effect: before paint, so the panel never flashes
     on the wrong side). Closed-state default matches the historic downward
     panel, which is also what jsdom's zero-rect measures back to. */
  const [drop, setDrop] = useState<{ up: boolean; maxH: number }>({ up: false, maxH: PANEL_MAX });
  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    setDrop(measureDrop(inputRef.current));
  }, [open]);

  const shown = query ?? chosen?.label ?? '';

  const hits = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return options;
    const tokens = q.split(/\s+/);
    return options.filter((o) => {
      const hay = o.label.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [options, query]);

  /* Reset the highlight whenever the list changes shape. */
  useEffect(() => { setHighlight(0); }, [query, open]);

  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) setQuery(null);
  };
  const pick = (v: string) => {
    onChange(v);
    setQuery(null);
    setOpen(false);
  };

  /* Group headers interleaved into the flat hit list for rendering. */
  const rows = useMemo(() => {
    const out: Array<{ t: 'head'; label: string } | { t: 'opt'; o: ComboOption; i: number }> = [];
    let lastGroup: string | undefined;
    hits.forEach((o, i) => {
      if (o.group && o.group !== lastGroup) { out.push({ t: 'head', label: o.group }); lastGroup = o.group; }
      out.push({ t: 'opt', o, i });
    });
    return out;
  }, [hits]);

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative' }}
      onBlur={(e) => {
        /* Focus leaving the whole widget (not moving into the list). */
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) close(true);
      }}
    >
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        autoComplete="off"
        className={className}
        placeholder={placeholder}
        disabled={disabled}
        value={shown}
        onFocus={(e) => { setOpen(true); e.target.select(); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, hits.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') { if (open && hits[highlight]) { e.preventDefault(); pick(hits[highlight].value); } }
          else if (e.key === 'Escape') { close(true); }
        }}
      />
      {open && !disabled && (
        <div
          role="listbox"
          style={{
            position: 'absolute', zIndex: 30, left: 0, right: 0,
            ...(drop.up ? { bottom: '100%', marginBottom: 2 } : { top: '100%', marginTop: 2 }),
            maxHeight: drop.maxH, overflowY: 'auto',
            background: 'var(--c-paper, #fff)', border: '1px solid var(--line, rgba(34,31,32,0.2))',
            borderRadius: 'var(--radius-md, 8px)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            fontSize: 'var(--fs-13)',
          }}
        >
          {rows.length === 0 && (
            <div style={{ padding: '8px 12px', color: 'var(--fg-muted, #777)' }}>No account matches &ldquo;{query}&rdquo;</div>
          )}
          {rows.map((r) => r.t === 'head' ? (
            <div key={`h-${r.label}`} style={{ padding: '6px 12px 2px', fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted, #777)' }}>
              {r.label}
            </div>
          ) : (
            <div
              key={r.o.value}
              role="option"
              aria-selected={r.o.value === value}
              /* mousedown, not click: click fires after blur has already
                 closed the list and restored the label. */
              onMouseDown={(e) => { e.preventDefault(); pick(r.o.value); }}
              onMouseEnter={() => setHighlight(r.i)}
              style={{
                padding: '6px 12px', cursor: 'pointer',
                background: r.i === highlight ? 'var(--c-cream, #f5f1ea)' : 'transparent',
                fontWeight: r.o.value === value ? 600 : 400,
              }}
            >
              {r.o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
