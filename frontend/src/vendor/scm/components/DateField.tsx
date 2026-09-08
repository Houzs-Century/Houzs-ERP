// DateField — controlled date input that ALWAYS displays DD/MM/YYYY,
// regardless of the operating-system locale.
//
// Why this exists (Commander 2026-06-18): native <input type="date"> renders
// its value in the browser/OS locale — so the same field showed DD/MM/YYYY on
// one machine and MM/DD/YYYY on another. This is the literal "有时候 MMDDYYYY"
// bug on the MRP / Proceed-PO date fields. A controlled text field fixes the
// DISPLAY (always day-first) while a hidden native date input still provides
// the OS calendar picker. The on-the-wire contract is unchanged: `value` is an
// ISO `YYYY-MM-DD` string (or '') and `onChange` emits the same.

import { useState, useRef, useId, useEffect, type CSSProperties } from 'react';
import { Calendar } from 'lucide-react';
import styles from './DateField.module.css';

export type DateFieldProps = {
  /** ISO `YYYY-MM-DD` (or '' for empty). */
  value: string;
  /** Emits ISO `YYYY-MM-DD` (or '' when cleared). */
  onChange: (iso: string) => void;
  className?: string;
  id?: string;
  name?: string;
  /** ISO min/max for the native calendar. */
  min?: string;
  max?: string;
  disabled?: boolean;
  /** Stretch to fill the parent (form fields / dialog rows). */
  fullWidth?: boolean;
  placeholder?: string;
  title?: string;
  'aria-label'?: string;
  /** Show a validation-error border (replaces the inline red `style` the raw
   *  native inputs used, since DateField wraps in a span). */
  invalid?: boolean;
  /** Soft informational highlight (orange border + cream fill) — e.g. a value
   *  auto-inherited from a parent doc. Distinct from `invalid` (red error). */
  highlight?: boolean;
  /** Inline style, merged onto the wrapper. The raw `<input type="date">`
   *  sites this component replaced carried their validation and
   *  inherited-value borders as inline `style`, and carrying those over
   *  verbatim is what let 170-odd fields move in one pass without each one
   *  being re-designed. `invalid` / `highlight` still win where both are set,
   *  because they are the reviewed spellings of the same two states. */
  style?: CSSProperties;
  /** Fired when the text box loses focus, after the display snaps back to the
   *  canonical value. */
  onBlur?: () => void;
  required?: boolean;
};

/** Digits → the DD/MM/YYYY mask as far as they reach: "3" → "3", "3103" →
 *  "31/03", "310320" → "31/03/20", "31032026" → "31/03/2026". */
export function maskDmy(digits: string): string {
  const d = digits.slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** True when every `/` in `raw` sits where `maskDmy` itself would have written
 *  one (index 2 and index 5) — i.e. the separators on screen are the MASK's,
 *  not the operator's.
 *
 *  WHY THIS EXISTS. The mask re-derives the whole string from the digits on
 *  every keystroke, so a separator the operator typed himself was stripped and
 *  a fresh one re-inserted at a FIXED slot. With an unpadded day or month that
 *  slot is the wrong one: `7/9/2026` typed character by character became
 *  `79/20/26`, `parseDmy` refused it, `onChange` never fired, and blur snapped
 *  the field back to its old value without a word. Padded input hid it —
 *  `07/09/2026` re-lands on the same slots — which is why the mask test, which
 *  fires whole padded strings, never saw it.
 *
 *  `-` and `.` are deliberately NOT considered here: the mask only ever writes
 *  `/`, so a dash or a dot is always the operator's own and is already left
 *  alone by the `^[\d/]*$` guard at the call site. */
export function separatorsAreMaskOwn(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '/' && i !== 2 && i !== 5) return false;
  }
  return true;
}

/** True on a finger-first device. The calendar button is 20px and the native
 *  input behind it is `pointer-events: none`, so on a phone the picker had no
 *  reachable opener at all and the owner concluded typing was the only way in
 *  (2026-09-08: mobile 的 date 为什么没有 dropdown calender 是要 manual type 的).
 *  Guarded because jsdom and older embedded webviews have no `matchMedia`.
 *
 *  `pointer: coarse` is the PRIMARY pointer, deliberately not `any-pointer`: a
 *  touchscreen Windows laptop and an iPad with a Magic Keyboard both report a
 *  fine primary pointer, so neither loses its text box to the overlay below. */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** `isCoarsePointer()` as render state, re-read when the primary pointer
 *  changes — a tablet gaining a keyboard case, a phone driven by a desktop
 *  browser's device emulation. Read at render (not inside a handler) because
 *  the touch fix is a DIFFERENT ELEMENT GEOMETRY, not a different event
 *  handler, so it has to be decided while the tree is being built. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia('(pointer: coarse)');
    } catch {
      return;
    }
    const onChange = () => setCoarse(isCoarsePointer());
    onChange();
    // A MediaQueryList with no addEventListener is Safari < 14 and some older
    // embedded webviews. The read above has already run, so what is lost there
    // is only the LIVE update; the field still renders for the right pointer.
    // Typed non-nullish, so this is a runtime feature test, not a null check.
    if (typeof mql.addEventListener !== 'function') return;
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return coarse;
}

/** "2026-05-31" → "31/05/2026". Returns '' for empty/malformed. */
export function isoToDmy(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** "31/05/2026" → "2026-05-31". Returns null if not a real calendar date.
 *  Tolerates 1–2 digit day/month and `-`/`.` separators — and the digits
 *  typed straight through with no separator at all (31052026 / 310526),
 *  read day-first like the display: the owner types 06092026 and got a
 *  field that never accepted it (2026-09-06: 日期那边我要输入时会变这样). */
export function parseDmy(text: string): string | null {
  const t = text.trim();
  const compact = /^(\d{2})(\d{2})(\d{4}|\d{2})$/.exec(t);
  /* A two-digit year after separators too (31/03/26): the mask below writes
     the separators for the operator, so the six-digit shortcut must still
     read the same way it does typed straight through. */
  const spaced = compact ? null : /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})$/.exec(t);
  const m = compact ?? spaced;
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(String(m[3]).length === 2 ? `20${m[3]}` : m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  // Reject overflow (e.g. 31/02) by round-tripping through a UTC date.
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yyyy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function DateField({
  value,
  onChange,
  className,
  id,
  name,
  min,
  max,
  disabled = false,
  fullWidth = false,
  placeholder = 'dd/mm/yyyy',
  title,
  'aria-label': ariaLabel,
  invalid = false,
  highlight = false,
  style,
  onBlur,
  required = false,
}: DateFieldProps) {
  // `editing` is non-null only while the text box has focus; the rest of the
  // time the display is derived straight from the canonical ISO `value`, so the
  // field can never drift out of sync with the parent.
  const [editing, setEditing] = useState<string | null>(null);
  // Set on blur when the operator's own text does not parse. Before this the
  // field silently reverted to the previous date and the operator read that as
  // his own typo — the entry was lost with no border, no message and nothing
  // announced, because `aria-invalid` came only from the `invalid` PROP.
  const [draftInvalid, setDraftInvalid] = useState(false);
  const nativeRef = useRef<HTMLInputElement>(null);
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const coarse = useCoarsePointer();

  const display = editing ?? isoToDmy(value);
  const showInvalid = invalid || draftInvalid;
  const errorId = `${inputId}-date-error`;

  // MOUSE ONLY. showPicker() is the reliable opener on the desktop engines
  // (Chrome 99+, Edge, Firefox 101+) and it is what the calendar button uses.
  // It is NOT the touch path: see the .nativeOverlay comment in the stylesheet
  // — on a coarse pointer the native input is the tap target itself and no
  // script runs at all.
  const openPicker = () => {
    const el = nativeRef.current;
    if (!el || disabled) return;
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return; } catch { /* not allowed in this context */ }
    }
    el.focus();
    el.click();
  };

  return (
    <span
      className={`${styles.wrap} ${fullWidth ? styles.fullWidth : ''} ${disabled ? styles.disabled : ''} ${className ?? ''}`}
      style={
        showInvalid
          ? { ...style, borderColor: 'var(--c-festive-b, #B8331F)' }
          : highlight
            ? { ...style, borderColor: 'var(--c-orange)', background: 'var(--c-cream)' }
            : style
      }
    >
      <input
        id={inputId}
        name={name}
        className={styles.textInput}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder}
        title={title}
        aria-label={ariaLabel}
        // The red border above is the SEEN half of this state; without the
        // attribute it was invisible to a screen reader and unassertable in a
        // test. Painting and announcing must not be able to drift apart.
        aria-invalid={showInvalid || undefined}
        aria-describedby={draftInvalid ? errorId : undefined}
        disabled={disabled}
        required={required}
        value={display}
        /* Select-all on focus (owner 2026-09-06: 日期我输入时希望不用自己打 "/"):
           the field often arrives pre-filled — today's date on a new bill —
           and typing into it APPENDED, so 31032026 became 06/09/202631032026,
           parsed as nothing, and snapped back on blur. Typing now replaces. */
        onFocus={(e) => { setEditing(isoToDmy(value)); setDraftInvalid(false); e.currentTarget.select(); }}
        onChange={(e) => {
          const raw = e.target.value;
          /* Digits typed straight through wear the mask as they land:
             3103 → 31/03, 31032026 → 31/03/2026. Anything else (a pasted
             31-03-2026, a stray letter) is left as typed for the parser — and
             so is anything carrying a separator the OPERATOR placed, which the
             mask used to strip and re-insert at the wrong slot. */
          const digits = raw.replace(/\D/g, '');
          const maskable = /^[\d/]*$/.test(raw) && digits.length <= 8 && separatorsAreMaskOwn(raw);
          const t = maskable ? maskDmy(digits) : raw;
          setEditing(t);
          setDraftInvalid(false);
          const trimmed = t.trim();
          if (trimmed === '') { onChange(''); return; }
          const iso = parseDmy(trimmed);
          if (iso) onChange(iso); // invalid/partial: hold until it parses or blur reports it
        }}
        onBlur={() => {
          const text = (editing ?? '').trim();
          if (text !== '' && parseDmy(text) === null) {
            // Keep what he typed on screen and SAY it was not understood. The
            // old behaviour dropped it and restored the previous date, so a
            // lost entry looked identical to no entry at all.
            setDraftInvalid(true);
          } else {
            setEditing(null);
            setDraftInvalid(false);
          }
          onBlur?.();
        }}
      />
      {draftInvalid && (
        <span id={errorId} className={styles.draftError} role="alert">
          Not a date — use dd/mm/yyyy
        </span>
      )}
      <button
        type="button"
        className={styles.iconBtn}
        onClick={openPicker}
        disabled={disabled}
        tabIndex={-1}
        aria-label="Open calendar"
        title="Open calendar"
      >
        <Calendar size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {/* Native date input — supplies the OS calendar picker and emits ISO.
          Always visually transparent, so what the operator READS is the masked
          day-first text above and never the OS-locale rendering (PR #2390).
          Its GEOMETRY is what changes with the pointer, and that is the whole
          fix: on a mouse it stays a 20px strip behind the calendar button and
          showPicker() opens it; on a finger it stretches over the entire field
          and takes pointer events, so the tap itself reaches a real date
          control and iOS raises its own wheel with no script in the path.
          #3300 tried to do this by calling showPicker() against the 20px
          pointer-events:none strip — Chrome obliges, iOS Safari does not, which
          is why the desktop screenshot showed a calendar and the iPhone showed
          nothing. `data-touch-target` is the DOM-readable statement of which
          mode is live: assertable in a test, and legible in Safari's remote
          inspector when someone next reports that a picker will not open. */}
      <input
        ref={nativeRef}
        className={coarse ? styles.nativeOverlay : styles.nativeHidden}
        data-touch-target={coarse ? 'true' : undefined}
        type="date"
        tabIndex={-1}
        aria-hidden
        disabled={disabled}
        value={value || ''}
        min={min}
        max={max}
        onChange={(e) => {
          // A pick supersedes whatever draft the text box was holding, invalid
          // or not; without this the flagged draft would sit on top of the
          // date the operator just chose.
          setEditing(null);
          setDraftInvalid(false);
          onChange(e.target.value);
          // A calendar pick is a COMPLETED entry, but it lands on this hidden
          // input — the visible text box never focuses on this path, so it
          // never blurs, and a blur-committing host (InlineEdit saves on blur)
          // silently dropped the pick (2026-08-20: a Service-case Supplier
          // Pickup Date chosen via the icon showed in the field, never saved).
          // Fire the same completion signal, one tick later so the host sees
          // this change's state flushed before it commits.
          setTimeout(() => onBlur?.(), 0);
        }}
      />
    </span>
  );
}
