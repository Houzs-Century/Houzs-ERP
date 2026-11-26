import type { CSSProperties } from 'react';
import { ADDRESS_LINE_MAX, addressLineProps } from '../lib/acColumnWidths';
import { addressLineTwoView, hasLegacyLines, type AddressTown } from '../vendor/shared/address-two-lines';

const PLACEHOLDERS = ['Unit, street, area', 'Apt, floor, building (optional)'];
type Line = 1 | 2 | 3 | 4;

/**
 * A sales order's address lines: TWO inputs, as on every address form (owner
 * 2026-11-18). The order still stores four lines because the account book has
 * four of 40 characters; the save fit spills a long address into 3 / 4.
 *
 * Nothing stored is hidden: Address line 2 SHOWS lines 3 / 4 after line 2
 * (shared/address-two-lines.ts), and editing it writes all of it to line 2 and
 * clears 3 / 4 — the server re-fits it on save. Line 2 has nowhere to spill, so
 * a long paste stays whole there (addressLineProps, spill null).
 *
 * KEEP CHROME'S ADDRESS AUTOFILL OFF THIS BLOCK. Chrome classifies a form by
 * its FIELDS, so a bare address input makes it treat the group as an address
 * form and offer its saved-address popup over the State list. `off` is
 * overridden once the form looks like an address; an UNRECOGNISED token is
 * what stops the heuristic.
 */
export function SoAddressLines({ lines, town, onChange, fieldClassName, labelClassName, inputClassName, style, disabled }: {
  lines: readonly [string, string, string, string];
  town: AddressTown;
  onChange: (line: Line, value: string) => void;
  fieldClassName: string;
  labelClassName: string;
  inputClassName: (index: number) => string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const [l1, l2, l3, l4] = lines;
  const lineTwo = addressLineTwoView(l2, l3, l4, town);
  const setLineTwo = (v: string) => {
    onChange(2, v);
    if (hasLegacyLines(l3, l4)) { onChange(3, ''); onChange(4, ''); }
  };
  const inputs: Array<{ value: string; set: (v: string) => void; spill: { value: string; set: (v: string) => void } | null }> = [
    { value: l1, set: (v) => onChange(1, v), spill: { value: lineTwo, set: setLineTwo } },
    { value: lineTwo, set: setLineTwo, spill: null },
  ];
  return (
    <>
      {inputs.map(({ value, set, spill }, i) => (
        <label key={i} className={fieldClassName} style={{ gridColumn: 'span 4', ...style }}>
          <span className={labelClassName}>Address Line {i + 1}</span>
          <input className={inputClassName(i)} value={value} placeholder={PLACEHOLDERS[i]}
            autoComplete="houzs-no-autofill" disabled={disabled}
            {...addressLineProps(set, spill)}
            maxLength={value.length > ADDRESS_LINE_MAX ? undefined : ADDRESS_LINE_MAX}
            onChange={(e) => set(e.target.value)} />
        </label>
      ))}
    </>
  );
}
