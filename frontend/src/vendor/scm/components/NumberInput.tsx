// ----------------------------------------------------------------------------
// NumberInput — a controlled numeric <input> that keeps its DISPLAYED text apart
// from the numeric value.
//
// The bug it removes (owner 2026-09-18, 全套系统): a plain
// `<input type="number" value={someNumber}>` re-derives its text from the parsed
// number, so React skips the DOM write whenever the parse is unchanged. Typing
// "0" in front of "100" leaves "0100" on screen (parse 100 === state 100), and a
// lone "-" parses to NaN and is wiped before a digit can follow. Binding the box
// to its own raw draft, parsed into the numeric value, fixes both.
//
// This is the non-money twin of MoneyInput (money keeps using MoneyInput, which
// already does the same thing with RM formatting). Use it for quantities,
// counts, digits, sort orders, rates, percentages — anything a user TYPES.
//
// `sign` is REQUIRED so each call site declares whether a minus may be typed:
// only Stock Adjustment qty is 'signed' (negative = decrease); every other field
// is 'unsigned' (positive-only). `decimal` is REQUIRED so each site declares
// whether a decimal point is allowed (rates/prices) or the field is an integer.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';

export type NumberSign = 'signed' | 'unsigned';

/** Keep only the characters the field allows: digits, an optional single leading
 *  minus (signed only), and an optional single dot (decimal only). */
export const cleanNumericText = (raw: string, sign: NumberSign, decimal: boolean): string => {
  let s = raw.replace(decimal ? /[^\d.-]/g : /[^\d-]/g, '');
  if (sign === 'signed') {
    const neg = s.startsWith('-');
    s = s.replace(/-/g, '');
    if (neg) s = `-${s}`;
  } else {
    s = s.replace(/-/g, '');
  }
  if (decimal) {
    const dot = s.indexOf('.');
    if (dot !== -1) s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, '')}`;
  }
  return s;
};

/** "" and an in-progress "-", "." or "-." are not yet a number → null. */
export const parseNumericText = (text: string): number | null => {
  if (text === '' || text === '-' || text === '.' || text === '-.') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

const fmt = (value: number | null): string => (value == null ? '' : String(value));

export type NumberInputProps = {
  /** The numeric source of truth (null = empty box). */
  value: number | null;
  /** Parsed number, or null while the box is empty / mid-type ("-", "."). */
  onValueChange: (value: number | null) => void;
  sign: NumberSign;
  decimal: boolean;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  // For a cell/list editor that must not let a click bubble to the row.
  onClick?: (e: MouseEvent<HTMLInputElement>) => void;
};

export const NumberInput = ({
  value, onValueChange, sign, decimal,
  className, style, placeholder, disabled, title, 'aria-label': ariaLabel, onKeyDown, onBlur, onClick,
}: NumberInputProps) => {
  const [draft, setDraft] = useState(() => fmt(value));
  const focused = useRef(false);

  // Re-sync from the value ONLY when the box is not being edited — so a typed
  // leading zero survives while focused, and an external change (e.g. a lot pick
  // capping a decrease) still updates the box when it is not.
  useEffect(() => {
    if (!focused.current) setDraft(fmt(value));
  }, [value]);

  return (
    <input
      type="text"
      inputMode={decimal ? 'decimal' : 'numeric'}
      className={className}
      style={style}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        const text = cleanNumericText(e.target.value, sign, decimal);
        setDraft(text);
        onValueChange(parseNumericText(text));
      }}
      onBlur={() => { focused.current = false; setDraft(fmt(value)); onBlur?.(); }}
      onKeyDown={onKeyDown}
      onClick={onClick}
    />
  );
};
