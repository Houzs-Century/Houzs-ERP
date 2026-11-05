// DateRangeButton — the owner's redesign date-range picker (Claude Design,
// Finance › Money in › Outstanding; the Finance reports reuse it). A button
// that names the range, and a popover with the presets, From / To fields and a
// month calendar: the first click on a day sets From, the second sets To.
//
// The range is ISO `YYYY-MM-DD` in and out, '' for an open end; both ends ''
// is "All dates". Every date a reader sees goes through fmtDate and every typed
// one through DateField, so the picker cannot invent a date format of its own.
// The presets come from lib/dateRangePresets (one home for every picker).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { placePopover } from '../lib/popoverPlacement';
import { fmtDate } from '../vendor/shared/format';
import { DateField } from '../vendor/scm/components/DateField';
import {
  addDays, daysInRange, monthStart, presetLabel, presetOf, presetRange, type RangePresetKey,
} from '../lib/dateRangePresets';
import styles from './DateRangeButton.module.css';

/* Weekday letters from the calendar itself (2024-01-07 was a Sunday) rather
   than a typed list: Sunday first, as the design draws it. */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(Date.UTC(2024, 0, 7 + i)).toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2));

const monthTitle = (first: string): string =>
  new Date(`${first}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const dayWord = (n: number): string => (n === 1 ? '1 day' : `${n.toLocaleString('en-MY')} days`);

/** The 42 days (six weeks, Sunday first) the month starting `first` is drawn on. */
function gridDays(first: string): string[] {
  const lead = new Date(`${first}T00:00:00Z`).getUTCDay();
  return Array.from({ length: 42 }, (_, i) => addDays(first, i - lead));
}

export type DateRangeButtonProps = {
  /** ISO `YYYY-MM-DD`, or '' for an open end. */
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  /** The presets offered, in order (lib/dateRangePresets). */
  presets: readonly RangePresetKey[];
  /** Today, ISO — the presets count back from it and the calendar rings it. */
  today: string;
  /** What the dates filter, for screen readers ("Invoice dates"). */
  label?: string;
};

export function DateRangeButton({ from, to, onChange, presets, today, label = 'Dates' }: DateRangeButtonProps) {
  const [open, setOpen] = useState(false);
  /* Which end the next calendar click sets; `picking` while the second click is
     awaited after the first, `hover` the day the band previews to. */
  const [end, setEnd] = useState<'from' | 'to'>('from');
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState(() => monthStart(from || today));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /* The popover lives on <body> (a portal) at a measured spot, so no sidebar or
     clipping card can cover it (lib/popoverPlacement). */
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const allDates = from === '' && to === '';
  const oneEndMissing = (from === '') !== (to === '');
  const reversed = from !== '' && to !== '' && from > to;
  const bad = oneEndMissing || reversed;
  const days = !bad && !allDates ? daysInRange(from, to) : 0;
  const active = presetOf({ from, to }, presets, today);

  const close = () => { setOpen(false); setPicking(false); setHover(null); };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const p = popRef.current;
      if (!t || !p) return;
      setPos(placePopover(t, p.offsetWidth, p.offsetHeight, window.innerWidth, window.innerHeight));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) { close(); return; }
    setView(monthStart(from || today));
    setEnd('from');
    setPicking(false);
    setHover(null);
    setOpen(true);
  };

  const triggerLabel = allDates
    ? presetLabel('all')
    : bad
      ? `${from ? fmtDate(from) : '—'} – ${to ? fmtDate(to) : '—'}`
      : from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
  const triggerSub = bad ? 'check the dates' : active ? (active === 'all' ? '' : presetLabel(active)) : dayWord(days);

  const hint = allDates
    ? 'Every date'
    : oneEndMissing
      ? `Type dates as ${fmtDate(monthStart(today))}`
      : reversed
        ? '“From” is after “To”'
        : `${dayWord(days)}${picking && end === 'to' ? ' · now pick the end date' : ''}`;

  /* First click (or a day before From) starts the range — keeping To when the
     new From is still before it, else a single day — and waits for the end;
     the second click sets To. */
  const pickDay = (day: string) => {
    if (end === 'from' || from === '' || day < from) {
      onChange(day, end === 'from' && to !== '' && day <= to ? to : day);
      setEnd('to');
      setPicking(true);
      setHover(null);
      return;
    }
    onChange(from, day);
    setEnd('from');
    setPicking(false);
    setHover(null);
  };

  const pickPreset = (key: RangePresetKey) => {
    const r = presetRange(key, today);
    onChange(r.from, r.to);
    setEnd('from');
    setPicking(false);
    setHover(null);
    setView(monthStart(r.from || today));
  };

  const focusEnd = (key: 'from' | 'to') => {
    if (end === key && !picking) return;
    setEnd(key);
    setPicking(false);
    setHover(null);
  };

  // The band: From to To, or From to the hovered day while the end is picked.
  const lo = from || null;
  const hi = picking && end === 'to' && from && hover ? (hover < from ? from : hover) : to || null;
  const fromBad = !allDates && from === '';
  const toBad = !allDates && (to === '' || reversed);
  const viewMonth = view.slice(0, 7);

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${bad ? styles.triggerBad : open ? styles.triggerOpen : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${triggerLabel}${triggerSub ? `, ${triggerSub}` : ''}`}
        onClick={toggle}
      >
        <Calendar size={14} strokeWidth={1.75} aria-hidden className={styles.triggerIcon} />
        <span className={styles.triggerLabel}>{triggerLabel}</span>
        {triggerSub && <span className={styles.triggerSub}>{triggerSub}</span>}
        <ChevronDown size={13} strokeWidth={1.75} aria-hidden className={styles.triggerIcon} />
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className={styles.pop}
          role="dialog"
          aria-label={`Pick ${label.toLowerCase()}`}
          style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        >
          <div className={styles.presets} role="group" aria-label="Presets">
            {presets.map((k) => (
              <button
                key={k}
                type="button"
                className={`${styles.preset} ${active === k ? styles.presetOn : ''}`}
                aria-pressed={active === k}
                onClick={() => pickPreset(k)}
              >
                <span className={styles.grow}>{presetLabel(k)}</span>
                {active === k && <Check size={13} strokeWidth={2.5} aria-hidden />}
              </button>
            ))}
          </div>

          <div className={styles.side}>
            <div className={styles.fields}>
              {(['from', 'to'] as const).map((key) => {
                const isBad = key === 'from' ? fromBad : toBad;
                return (
                  <div
                    key={key}
                    className={`${styles.field} ${isBad ? styles.fieldBad : end === key ? styles.fieldOn : ''}`}
                    onClick={() => focusEnd(key)}
                  >
                    <span className={styles.fieldLabel}>{key === 'from' ? 'From' : 'To'}</span>
                    <DateField
                      className={styles.fieldInput}
                      fullWidth
                      value={key === 'from' ? from : to}
                      placeholder={fmtDate(monthStart(today))}
                      aria-label={key === 'from' ? 'From' : 'To'}
                      invalid={isBad}
                      onChange={(iso) => (key === 'from' ? onChange(iso, to) : onChange(from, iso))}
                    />
                  </div>
                );
              })}
            </div>

            <div className={styles.monthRow}>
              <span className={styles.monthTitle}>{monthTitle(view)}</span>
              <button type="button" className={styles.navBtn} title="Previous month" aria-label="Previous month"
                onClick={() => setView(monthStart(view, -1))}>
                <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
              </button>
              <button type="button" className={styles.navBtn} title="Next month" aria-label="Next month"
                onClick={() => setView(monthStart(view, 1))}>
                <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </div>

            <div className={styles.grid} onMouseLeave={() => setHover(null)}>
              {WEEKDAYS.map((w, i) => (
                <span key={w} className={`${styles.weekday} ${i === 0 || i === 6 ? styles.weekend : ''}`}>{w}</span>
              ))}
              {gridDays(view).map((day, i) => {
                const col = i % 7;
                const isLo = lo === day;
                const isHi = hi === day;
                const edge = isLo || isHi;
                const single = isLo && isHi;
                const inside = lo != null && hi != null && day > lo && day < hi;
                const banded = inside || (edge && !single && lo != null && hi != null && lo !== hi);
                /* The band rounds where the range starts or ends, and at the
                   ends of each week row it runs through. */
                const roundStart = banded && (isLo || (inside && col === 0));
                const roundEnd = banded && (isHi || (inside && col === 6));
                const outside = day.slice(0, 7) !== viewMonth;
                return (
                  <button
                    key={day}
                    type="button"
                    className={[
                      styles.day,
                      banded ? styles.band : '',
                      roundStart ? styles.bandStart : '',
                      roundEnd ? styles.bandEnd : '',
                    ].join(' ')}
                    aria-label={fmtDate(day)}
                    aria-pressed={edge}
                    onClick={() => pickDay(day)}
                    onMouseEnter={() => { if (picking && end === 'to' && hover !== day) setHover(day); }}
                  >
                    <span
                      className={[
                        styles.dot,
                        edge ? styles.dotEdge : outside ? styles.dotOutside : col === 0 || col === 6 ? styles.weekend : '',
                        day === today && !edge ? styles.dotToday : '',
                      ].join(' ')}
                    >
                      {Number(day.slice(8, 10))}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={styles.foot}>
              <span className={`${styles.grow} ${styles.hint} ${bad ? styles.hintBad : ''}`} role="status">{hint}</span>
              <button type="button" className={styles.todayLink} onClick={() => setView(monthStart(today))}>Today</button>
              <button type="button" className={styles.done} onClick={close}>Done</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
