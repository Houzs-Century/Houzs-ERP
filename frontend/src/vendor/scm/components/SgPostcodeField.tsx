import type { CSSProperties } from 'react';
import { useSgPostcodeLookup, isValidSgPostcode } from '../lib/sg-postcode-queries';

/* Singapore's ~150k per-building postcodes are NOT seeded in scm.my_localities
   (only 55 area-representative codes are), so for a Singapore address the
   Postcode field is a free text input with a LIVE OneMap lookup
   (GET /sg-postcode/:code) instead of the 55-code dropdown. On a valid 6-digit
   code we offer the resolved address for one-tap fill (onResolveAddress).
   Degrades silently when the backend has no OneMap credentials
   (configured:false): the field still accepts the typed code.

   Styling is passed in (fieldClassName / labelClassName / inputClassName) so
   each host form keeps its own CSS-module look. `bare` renders just the input +
   lookup (no <label> and no "Postcode" span), for a form that already provides
   its own field wrapper and label — e.g. the mobile <Field>. */
export const SgPostcodeField = ({
  value,
  onChange,
  onResolveAddress,
  fieldClassName,
  labelClassName,
  inputClassName,
  disabled,
  title,
  bare,
}: {
  value: string;
  onChange: (v: string) => void;
  onResolveAddress: (address: string) => void;
  fieldClassName?: string;
  labelClassName?: string;
  inputClassName?: string;
  disabled?: boolean;
  title?: string;
  bare?: boolean;
}) => {
  // When the field is locked, do not look anything up or offer to fill.
  const lookup = useSgPostcodeLookup(disabled ? '' : value);
  const data = lookup.data;
  const hit = data?.configured && data.results.length > 0 ? data.results[0] : null;
  const hintStyle: CSSProperties = { fontSize: 11, color: 'var(--fg-muted, #888)', marginTop: 4, display: 'block' };
  const inner = (
    <>
      <input
        className={inputClassName}
        value={value}
        inputMode="numeric"
        maxLength={6}
        placeholder="6-digit SG postcode"
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
      {!disabled && isValidSgPostcode(value) && lookup.isFetching && <span style={hintStyle}>Looking up address…</span>}
      {!disabled && hit && (
        <button
          type="button"
          onClick={() => onResolveAddress(hit.address)}
          style={{ marginTop: 4, padding: 0, background: 'none', border: 'none', textAlign: 'left', color: 'var(--accent, #0a7a5a)', cursor: 'pointer', fontSize: 12, display: 'block' }}
        >
          Use: {hit.address}
        </button>
      )}
      {!disabled && data && !data.configured && <span style={hintStyle}>Live lookup not enabled — enter the address manually.</span>}
    </>
  );
  if (bare) return inner;
  return (
    <label className={fieldClassName}>
      <span className={labelClassName}>Postcode</span>
      {inner}
    </label>
  );
};
