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

import { useState, useRef, useId, type CSSProperties } from 'react';
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
  const spaced = compact ? null : /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(t);
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
  const nativeRef = useRef<HTMLInputElement>(null);
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  const display = editing ?? isoToDmy(value);

  const openPicker = () => {
    const el = nativeRef.current;
    if (!el || disabled) return;
    // showPicker() is the reliable cross-browser opener (Chrome 99+, Edge,
    // Safari 16+, Firefox 101+); fall back to focus()+click() otherwise.
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
        invalid
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
        aria-invalid={invalid || undefined}
        disabled={disabled}
        required={required}
        value={display}
        onFocus={() => setEditing(isoToDmy(value))}
        onChange={(e) => {
          const t = e.target.value;
          setEditing(t);
          const trimmed = t.trim();
          if (trimmed === '') { onChange(''); return; }
          const iso = parseDmy(trimmed);
          if (iso) onChange(iso); // invalid/partial: hold until it parses or blur snaps back
        }}
        onBlur={() => { setEditing(null); onBlur?.(); }}
      />
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
      {/* Hidden native date input — supplies the OS calendar picker and emits
          ISO. Visually hidden but kept in layout (not display:none) so
          showPicker() can anchor it next to the button. */}
      <input
        ref={nativeRef}
        className={styles.nativeHidden}
        type="date"
        tabIndex={-1}
        aria-hidden
        disabled={disabled}
        value={value || ''}
        min={min}
        max={max}
        onChange={(e) => {
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
