import { ChevronDown } from 'lucide-react';
import { SearchableSelect } from './SearchableSelect';
import { SgPostcodeField } from './SgPostcodeField';
import { sortByNumeric } from '../lib/sort-options';

/* The Postcode field shared by the address forms. Normally a SearchableSelect
   over the my_localities cascade; but when the address is in Singapore — whose
   ~150k real per-building postcodes are NOT seeded (only 55 area codes are) — it
   becomes a live OneMap lookup (SgPostcodeField). Country is passed in: the forms
   derive it from the picked State.

   Two onChange paths on purpose: `onCascadePick` reverse-resolves State/City off
   my_localities (non-SG), while `onChange` is the raw setter SG needs — a real SG
   code the cascade does not hold, so there is nothing to reverse-resolve.

   `classes` carries each host form's own CSS-module class names so the field
   matches the surrounding form. */
export const AddressPostcodeField = ({
  country,
  value,
  onChange,
  onCascadePick,
  onResolveAddress,
  postcodeChoices,
  placeholder,
  disabled,
  title,
  classes,
}: {
  country: string;
  value: string;
  onChange: (v: string) => void;
  onCascadePick: (v: string) => void;
  onResolveAddress: (address: string) => void;
  postcodeChoices: string[];
  placeholder: string;
  disabled?: boolean;
  title?: string;
  classes?: { field?: string; label?: string; select?: string; selectWrap?: string; chevron?: string; input?: string };
}) => {
  const c = classes ?? {};
  if (country === 'Singapore') {
    return (
      <SgPostcodeField
        value={value}
        onChange={onChange}
        onResolveAddress={onResolveAddress}
        disabled={disabled}
        title={title}
        fieldClassName={c.field}
        labelClassName={c.label}
        inputClassName={c.input ?? c.select}
      />
    );
  }
  return (
    <label className={c.field}>
      <span className={c.label}>Postcode</span>
      <span className={c.selectWrap}>
        <SearchableSelect
          className={c.select}
          value={value}
          onChange={onCascadePick}
          disabled={disabled}
          title={title}
          placeholder={placeholder}
          options={sortByNumeric(postcodeChoices).map((p) => ({ value: p, label: p }))}
        />
        <ChevronDown size={14} strokeWidth={1.75} className={c.chevron} />
      </span>
    </label>
  );
};
