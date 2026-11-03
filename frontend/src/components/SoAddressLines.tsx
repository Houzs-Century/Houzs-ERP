import type { CSSProperties } from 'react';
import { addressLineProps } from '../lib/acColumnWidths';

const PLACEHOLDERS = ['Unit, street, area', 'Apt, floor, building (optional)', 'Optional', 'Optional'];
type Line = 1 | 2 | 3 | 4;

/**
 * A sales order's four address lines, as the account book holds them: 40
 * characters each, a long paste spilling 1 -> 2 -> 3 -> 4.
 *
 * Lines 3 and 4 were stored but had no input, so a POS address the save fit
 * spilled past line 2 printed on the order and could not be seen or corrected
 * on the form (2990-0036).
 *
 * KEEP CHROME'S ADDRESS AUTOFILL OFF THIS BLOCK. Chrome classifies a form by
 * its FIELDS, so a bare address input makes it treat the group as an address
 * form and offer its saved-address popup over the State list. `off` is
 * overridden once the form looks like an address; an UNRECOGNISED token is
 * what stops the heuristic.
 */
export function SoAddressLines({ lines, onChange, fieldClassName, labelClassName, inputClassName, style, disabled }: {
  lines: readonly [string, string, string, string];
  onChange: (line: Line, value: string) => void;
  fieldClassName: string;
  labelClassName: string;
  inputClassName: (index: number) => string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  return (
    <>
      {lines.map((value, i) => { const line = (i + 1) as Line; return (
        <label key={i} className={fieldClassName} style={{ gridColumn: 'span 4', ...style }}>
          <span className={labelClassName}>Address Line {line}</span>
          <input className={inputClassName(i)} value={value} placeholder={PLACEHOLDERS[i]}
            autoComplete="houzs-no-autofill" disabled={disabled}
            {...addressLineProps((v) => onChange(line, v), line < 4 ? { value: lines[i + 1] ?? '', set: (v) => onChange((line + 1) as Line, v) } : null)}
            onChange={(e) => onChange(line, e.target.value)} />
        </label>
      ); })}
    </>
  );
}
