// ----------------------------------------------------------------------------
// MoneyInput — edit a sen/centi integer as an RM amount.
//
// Commander 2026-05-29: the old price cells used <input type="number"> with a
// controlled string that re-synced on every parent render — so a react-query
// refetch mid-edit clobbered what you typed, and you couldn't just clear the
// field and retype (the "10 jumps to the front" bug). The PO/PI/PR FORMS had a
// worse variant: <input type="number" value={(centi/100).toFixed(2)}> reformat
// on every keystroke, so typing "500" only registered "5" ("我放了 500 却不行,
// 只能识别到 5"). This fixes both:
//   • type="text" + inputMode="decimal" → no number-input cursor/format quirks
//   • free typing while focused; the value only re-syncs from upstream when the
//     field is NOT focused
//   • onChange accepts an empty string + up to 2 decimals (clear & retype works)
//   • parse + normalise only on blur / Enter; Esc reverts
//
// At rest the amount reads the way the books print it — thousands separated,
// always two decimals: 1,800.00, 3.56 (owner 2026-09-06: amount 这边我希望显示
// 千位数,哪怕没有分都要显示 .00). While the field is focused it shows the plain
// form (1800.00) so the caret and the digits behave as before; the parse
// strips a comma the operator types anyway.
//
// Two render modes:
//   • default → inline RM editor (span wrapper + "RM" prefix, ~84px) for table
//     cells (SupplierDetail price matrix).
//   • bare    → just the <input>, styled by `inputClassName` + `style`, for the
//     full-width form fields (New PO / PI / Purchase Return line editors).
// Reusable everywhere money is edited so the whole system behaves the same way.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import styles from './MoneyInput.module.css';

/** At rest: 1,800.00 — the books' own spelling. */
export const fmtMoneyAtRest = (sen: number | null | undefined): string =>
  sen == null ? '' : (sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** While editing: 1800.00 — no separators under the caret. */
const plain = (sen: number | null | undefined): string =>
  sen == null ? '' : (sen / 100).toFixed(2);

export const MoneyInput = ({
  valueSen,
  onCommit,
  currency = 'RM',
  allowBlank = false,
  placeholder = '—',
  className,
  title,
  // Bare mode (form fields): render just the input, no wrapper / no currency.
  bare = false,
  inputClassName,
  style,
  align = 'right',
  selectOnFocus = false,
  disabled = false,
  'aria-label': ariaLabel,
  onKeyDown,
}: {
  valueSen: number | null;
  /** Called with the new sen value (or null when cleared, if allowBlank). */
  onCommit: (sen: number | null) => void;
  currency?: string;
  allowBlank?: boolean;
  placeholder?: string;
  className?: string;
  title?: string;
  /** Render only the <input> (no span wrapper / currency prefix). */
  bare?: boolean;
  /** Class applied to the <input> in bare mode (e.g. styles.fieldInput). */
  inputClassName?: string;
  style?: CSSProperties;
  align?: 'left' | 'right';
  /** Select-all on focus so a default like "1.00" is overwritten in one go. */
  selectOnFocus?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  /** Runs after the field's own keys (Enter commits, Esc reverts) — a line
      editor uses it to hop to the next line. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) => {
  const [draft, setDraft] = useState(() => fmtMoneyAtRest(valueSen));
  const focused = useRef(false);

  // Re-sync from upstream ONLY when the user isn't actively editing — so a
  // background refetch / auto-fill never overwrites in-progress typing.
  useEffect(() => {
    if (!focused.current) setDraft(fmtMoneyAtRest(valueSen));
  }, [valueSen]);

  const commit = () => {
    const t = draft.trim().replace(/,/g, '');
    if (t === '' || t === '.') {
      if (allowBlank) { if (valueSen != null) onCommit(null); }
      else setDraft(fmtMoneyAtRest(valueSen));
      return;
    }
    const next = Math.round(Number(t) * 100);
    if (!Number.isFinite(next) || next < 0) { setDraft(fmtMoneyAtRest(valueSen)); return; }
    if (next !== valueSen) onCommit(next);
    setDraft(fmtMoneyAtRest(next)); // normalise (e.g. "550" → "550.00", "1800" → "1,800.00")
  };

  const inputEl = (
    <input
      type="text"
      inputMode="decimal"
      className={bare ? (inputClassName ?? styles.input) : styles.input}
      style={bare ? { textAlign: align, ...style } : style}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? 'Click to edit · Enter to save · Esc to cancel'}
      onFocus={(e) => {
        focused.current = true;
        /* The separators leave with the focus: editing "1,800.00" in place
           must not fight the caret over a comma. */
        setDraft(plain(valueSen));
        if (selectOnFocus) {
          const el = e.currentTarget;
          window.setTimeout(() => { el.select(); }, 0);
        }
      }}
      onChange={(e) => {
        const v = e.target.value.replace(/,/g, '');
        // empty, or digits with up to 2 decimals — lets you clear & retype.
        if (v === '' || /^\d*\.?\d{0,2}$/.test(v)) setDraft(v);
      }}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(plain(valueSen)); (e.target as HTMLInputElement).blur(); }
        onKeyDown?.(e);
      }}
    />
  );

  if (bare) return inputEl;

  return (
    <span className={`${styles.wrap} ${className ?? ''}`}>
      {currency && <span className={styles.currency}>{currency}</span>}
      {inputEl}
    </span>
  );
};
