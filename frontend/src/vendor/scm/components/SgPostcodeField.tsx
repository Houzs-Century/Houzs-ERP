import type { CSSProperties } from 'react';
import { useSgPostcodeLookup, isValidSgPostcode, resolveSgPlanningArea } from '../lib/sg-postcode-queries';
import { useLocalities } from '../lib/localities-queries';

export const SgPostcodeField = ({
  value,
  onChange,
  onResolve,
  fieldClassName,
  labelClassName,
  inputClassName,
  disabled,
  title,
  bare,
}: {
  value: string;
  onChange: (v: string) => void;
  onResolve: (r: { address: string; state: string | null; city: string | null }) => void;
  fieldClassName?: string;
  labelClassName?: string;
  inputClassName?: string;
  disabled?: boolean;
  title?: string;
  bare?: boolean;
}) => {
  const lookup = useSgPostcodeLookup(disabled ? '' : value);
  const localities = useLocalities();
  const data = lookup.data;
  const hit = data?.configured && data.results.length > 0 ? data.results[0] : null;
  const area = hit ? resolveSgPlanningArea(localities.data ?? [], hit.planningArea) : null;
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
          onClick={() => onResolve({ address: hit.address, state: area?.state ?? null, city: area?.city ?? null })}
          style={{ marginTop: 4, padding: 0, background: 'none', border: 'none', textAlign: 'left', color: 'var(--accent, #0a7a5a)', cursor: 'pointer', fontSize: 12, display: 'block' }}
        >
          Use: {hit.address}{area ? ` — ${area.city}, ${area.state}` : ''}
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
