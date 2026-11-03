import type { CSSProperties } from 'react';
import { addressLineProps } from '../lib/acColumnWidths';

const PLACEHOLDERS = ['Unit, street, area', 'Apt, floor, building (optional)', 'Optional', 'Optional'];
export const SO_ADDRESS_KEYS = ['address1', 'address2', 'address3', 'address4'] as const;
type Line = 0 | 1 | 2 | 3;

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
  onChange: (index: Line, value: string) => void;
  fieldClassName: string;
  labelClassName: string;
  inputClassName: (index: number) => string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  return (
    <>
      {lines.map((value, n) => { const i = n as Line; return (
        <label key={i} className={fieldClassName} style={{ gridColumn: 'span 4', ...style }}>
          <span className={labelClassName}>Address Line {i + 1}</span>
          <input className={inputClassName(i)} value={value} placeholder={PLACEHOLDERS[i]}
            autoComplete="houzs-no-autofill" disabled={disabled}
            {...addressLineProps((v) => onChange(i, v), i < 3 ? { value: lines[i + 1] as string, set: (v) => onChange((i + 1) as Line, v) } : null)}
            onChange={(e) => onChange(i, e.target.value)} />
        </label>
      ); })}
    </>
  );
}
