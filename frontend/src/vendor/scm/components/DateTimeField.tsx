// DateTimeField — controlled wall-clock date+time input whose DATE half ALWAYS
// displays DD/MM/YYYY, regardless of the operating-system locale.
//
// Why this exists (2026-08-18): DateField (2026-06-18) fixed the "有时候
// MMDDYYYY" bug for `<input type="date">`, and #2390 finished the sweep — all
// 175 native date inputs now render through it. But `<input type="datetime-local">`
// renders its DATE half in the OS locale by exactly the same mechanism, and
// that type was never part of either pass. The result was visible on one
// screen: in the delivery-planning drawer, Arrival and Departure were native
// datetime-local while Shipout Date directly beneath them was a DateField, so
// the same drawer spelled a date two ways on a machine whose OS is not
// day-first. Same bug, same column, one field apart.
//
// The shape follows the split already proven in Projects.tsx's LogisticsDateTime
// (a DateField beside a native `type="time"`): a time input carries no
// day/month ambiguity — 14:30 and 2:30 PM name the same instant — so only the
// date half needs taking off the OS locale.
//
// THE WIRE CONTRACT IS UNCHANGED, deliberately and exactly: `value` is the
// same wall-clock `YYYY-MM-DDTHH:mm` string a native datetime-local reads and
// writes, and `onChange` emits the same. No timezone arithmetic happens here —
// this component only changes how the value is DISPLAYED, which is the whole
// point and the only safe scope. Callers that convert TIMESTAMPTZ to and from
// this shape keep doing it exactly as they did.

import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { DateField } from './DateField';

export type DateTimeFieldProps = {
  /** Wall-clock `YYYY-MM-DDTHH:mm` (or '' for empty). */
  value: string;
  /** Emits wall-clock `YYYY-MM-DDTHH:mm` (or '' when incomplete/cleared). */
  onChange: (value: string) => void;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  /** Stretch to fill the parent (form fields / drawer rows). */
  fullWidth?: boolean;
  title?: string;
  'aria-label'?: string;
};

/** `"2026-05-31T14:30"` → `{ date: '2026-05-31', time: '14:30' }`.
 *  Tolerates a space separator and any trailing seconds/ms/zone, because the
 *  callers slice a TIMESTAMPTZ down to 16 chars and one stray shape should
 *  degrade to "no time" rather than to a blank field. */
export function splitDateTimeLocal(value: string | null | undefined): { date: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(String(value ?? ''));
  return { date: m?.[1] ?? '', time: m?.[2] ?? '' };
}

/** `('2026-05-31', '14:30')` → `"2026-05-31T14:30"`; '' unless BOTH halves are
 *  present.
 *
 *  Emitting '' on a half-filled control is native datetime-local's own
 *  behaviour, and matching it byte-for-byte is deliberate: this change is
 *  meant to alter rendering and nothing else. Projects.tsx's LogisticsDateTime
 *  normalises a date-only value to midnight instead — that is a nicer rule and
 *  it stays where it is, owned by that component's own commit(); adopting it
 *  here would mean a field that used to save nothing starts saving 00:00, and
 *  a silently invented time is not a change to make inside a display fix. */
export function joinDateTimeLocal(date: string, time: string): string {
  return date && time ? `${date}T${time}` : '';
}

export function DateTimeField({
  value,
  onChange,
  className,
  style,
  disabled = false,
  fullWidth = false,
  title,
  'aria-label': ariaLabel,
}: DateTimeFieldProps) {
  /* The two halves are held locally, not derived from `value` on every render.
     A half-filled control emits '' (see joinDateTimeLocal), so deriving would
     make the date the operator just picked disappear the instant it round-
     tripped through the parent — while a native datetime-local keeps a
     half-filled segment on screen. Local state is what preserves that. */
  const [parts, setParts] = useState(() => splitDateTimeLocal(value));
  /* What we last sent up. An incoming `value` equal to it is our own echo and
     must NOT re-derive the halves (that is the wipe described above); anything
     else is a genuine external change — a form reset, a different row — and
     must. */
  const lastEmitted = useRef(value);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setParts(splitDateTimeLocal(value));
  }, [value]);

  /* HALF-FILLED DISCLOSURE. joinDateTimeLocal emits '' unless BOTH halves are
     present — native parity, deliberate, and asserted in this component's test.
     That contract is NOT changed here. What it lacked was a way to tell the
     operator, because the halves live in local state: the date they picked
     stays on screen while '' is what the form sends, so the screen and the
     payload disagree with nothing marking the difference.

     Found on the PMS stock-transfer form (2026-08-21): a date with a blank time
     saved a transfer with no date at all, and its auto-created schedule task
     with no due date. Flagging the EMPTY half makes the disagreement visible
     without inventing a time the operator never chose — which is the trade this
     component's own header refuses to make, and still refuses. */
  const incomplete = !!parts.date !== !!parts.time;
  const flagDate = incomplete && !parts.date;
  const flagTime = incomplete && !parts.time;
  const INCOMPLETE_HINT = 'Date and time are both needed — nothing is saved until both are filled in.';

  const push = (next: { date: string; time: string }) => {
    setParts(next);
    const joined = joinDateTimeLocal(next.date, next.time);
    lastEmitted.current = joined;
    onChange(joined);
  };

  return (
    <span
      style={{
        display: fullWidth ? 'flex' : 'inline-flex',
        alignItems: 'center',
        gap: 6,
        width: fullWidth ? '100%' : undefined,
      }}
    >
      <DateField
        fullWidth
        value={parts.date}
        onChange={(iso) => push({ date: iso, time: parts.time })}
        disabled={disabled}
        className={className}
        style={{ ...style, flex: '1 1 auto', minWidth: 0, width: 'auto' }}
        title={flagDate ? INCOMPLETE_HINT : title}
        invalid={flagDate}
        aria-label={ariaLabel ? `${ariaLabel} date` : undefined}
      />
      <input
        type="time"
        value={parts.time}
        disabled={disabled}
        className={className}
        style={
          flagTime
            ? { ...style, flex: '0 0 auto', width: 'auto', borderColor: 'var(--c-festive-b, #B8331F)' }
            : { ...style, flex: '0 0 auto', width: 'auto' }
        }
        title={flagTime ? INCOMPLETE_HINT : title}
        aria-invalid={flagTime || undefined}
        aria-label={ariaLabel ? `${ariaLabel} time` : undefined}
        onChange={(e) => push({ date: parts.date, time: e.target.value })}
      />
    </span>
  );
}
