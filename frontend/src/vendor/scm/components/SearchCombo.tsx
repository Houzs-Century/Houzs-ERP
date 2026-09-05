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
import { createPortal } from 'react-dom';

export type ComboOption = { value: string; label: string; group?: string };

/* Where the list lives, opens, and how tall it may be.

   Round 1 (owner 2026-09-04: 为什么我能选的这么少 / 选account 时会无法看到
   下面的): the panel opened DOWN unconditionally at 280px — viewport math
   was added so it could flip up. Round 2, same day, 还是一样 — because the
   REAL clipper was never the viewport: the panel rendered absolute INSIDE
   the form card, and .card carries overflow:hidden for its rounded corners
   (SalesOrderDetail.module.css), so anything past the card's edge was cut,
   scrollbar included, whatever the viewport said. Eight "adver" matches
   existed; the card showed four.

   So the panel now PORTALS to document.body and positions FIXED off the
   input's live rect: no ancestor overflow, transform or stacking context
   can clip it. While open it re-measures on scroll (capture phase, so any
   scroller counts) and on resize; it flips UP when the space below can't
   fit the panel and above offers more, and caps its height to the side
   actually available — the whole list, its own scrollbar included, always
   on screen. */
const PANEL_MAX = 280;
const PANEL_MIN = 120;
const EDGE_GAP = 8;
/* Round 3 (owner 2026-09-05: 选择时要优化,你看现在挤在一起这样): the panel
   used to inherit the INPUT's width, so inside a tight table column (~180px)
   every account label wrapped to three lines. The panel now takes at least
   PANEL_MIN_W, shifting left when that would run off the viewport's right
   edge — the input anchors it, it no longer straitjackets it. */
const PANEL_MIN_W = 320;

type PanelPos = { up: boolean; maxH: number; left: number; width: number; top: number; bottom: number };

function measurePanel(input: HTMLElement): PanelPos {
  const r = input.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - EDGE_GAP;
  const above = r.top - EDGE_GAP;
  const up = below < PANEL_MAX && above > below;
  const width = Math.min(Math.max(r.width, PANEL_MIN_W), window.innerWidth - EDGE_GAP * 2);
  return {
    up,
    maxH: Math.max(PANEL_MIN, Math.min(PANEL_MAX, up ? above : below)),
    left: Math.max(EDGE_GAP, Math.min(r.left, window.innerWidth - width - EDGE_GAP)),
    width,
    top: r.top,
    bottom: r.bottom,
  };
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

  /* Measured at open (layout effect: before paint, so the panel never
     flashes on the wrong side) and KEPT true while open — a scroll in any
     ancestor (capture phase) or a resize moves the input, and a fixed
     panel must follow it. */
  const [pos, setPos] = useState<PanelPos | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const el = inputRef.current;
    if (!el) return;
    const update = () => { setPos(measurePanel(el)); };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
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
      {open && !disabled && pos && createPortal(
        <div
          role="listbox"
          /* preventDefault on the CONTAINER too: grabbing the panel's own
             scrollbar must not steal focus from the input — a blur here
             closes the panel mid-scroll. */
          onMouseDown={(e) => { e.preventDefault(); }}
          style={{
            position: 'fixed', zIndex: 1000, left: pos.left, width: pos.width,
            ...(pos.up
              ? { bottom: window.innerHeight - pos.top + 2 }
              : { top: pos.bottom + 2 }),
            maxHeight: pos.maxH, overflowY: 'auto',
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
              title={r.o.label}
              style={{
                padding: '6px 12px', cursor: 'pointer',
                /* One option, one line — a wrapped label reads as two rows
                   and the panel is wide enough now (Round 3, see PANEL_MIN_W). */
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                background: r.i === highlight ? 'var(--c-cream, #f5f1ea)' : 'transparent',
                fontWeight: r.o.value === value ? 600 : 400,
              }}
            >
              {r.o.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
