import type { ReactNode } from 'react';
import { SearchableSelect } from './SearchableSelect';
import { SgPostcodeField } from './SgPostcodeField';
import { sortByNumeric } from '../lib/sort-options';

export const AddressPostcodeField = ({
  country,
  value,
  onChange,
  onCascadePick,
  onResolve,
  postcodeChoices,
  placeholder,
  disabled,
  title,
  label,
  classes,
}: {
  country: string;
  value: string;
  onChange: (v: string) => void;
  onCascadePick: (v: string) => void;
  onResolve: (r: { address: string; state: string | null; city: string | null }) => void;
  postcodeChoices: string[];
  placeholder: string;
  disabled?: boolean;
  title?: string;
  label?: ReactNode;
  classes?: { field?: string; label?: string; select?: string; selectWrap?: string; chevron?: string; input?: string };
}) => {
  const c = classes ?? {};
  if (country === 'Singapore') {
    return (
      <SgPostcodeField
        value={value}
        onChange={onChange}
        onResolve={onResolve}
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
      <span className={c.label}>{label ?? 'Postcode'}</span>
      <SearchableSelect
        chevron
        className={c.select}
        value={value}
        onChange={onCascadePick}
        disabled={disabled}
        title={title}
        placeholder={placeholder}
        options={sortByNumeric(postcodeChoices).map((p) => ({ value: p, label: p }))}
      />
    </label>
  );
};
