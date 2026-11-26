// ----------------------------------------------------------------------------
// AddressTripleFields — State / City / Postcode for a MASTER record (warehouse,
// 3PL company, venue), with the SAME controls and cascade as the Sales Order
// customer address: StatePicker, a typeable City, and the shared Postcode field
// (AddressPostcodeField: my_localities picker, Singapore live lookup).
//
// Owner 2026-11-17: every Delivery Planning job must carry Postcode + City +
// State, whatever its source, and the sources are these masters. Their forms
// had a Postcode hidden until State AND City were picked (warehouse), a free
// text box (venue), or nothing at all (3PL). Typing or picking a Postcode here
// fills City and State back, exactly as on the Sales Order.
//
// The cascade rules are lib/address-cascade.ts — this only wires them, so a
// fourth hand-copy cannot drift. Every pick hands the WHOLE triple to onChange
// in one call (see the module's note on why a back-filled State must never be
// routed through the State picker's reset).
//
// It renders three sibling <label>s and no wrapper, so the host grid lays them
// out as three of its own cells. `classes` carries the host's CSS class names.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useLocalities, countryForState } from '../lib/localities-queries';
import {
  useAddressCascade,
  pickState,
  pickCity,
  pickPostcode,
  cityPlaceholder,
  postcodePlaceholder,
  type AddressTriple,
} from '../lib/address-cascade';
import { sortByText } from '../lib/sort-options';
import { StatePicker } from './StatePicker';
import { SearchableSelect } from './SearchableSelect';
import { AddressPostcodeField } from './AddressPostcodeField';

export interface AddressTripleClasses {
  field?: string;
  label?: string;
  select?: string;
  selectWrap?: string;
  chevron?: string;
  input?: string;
}

export const AddressTripleFields = ({
  value,
  country,
  onChange,
  disabled,
  classes,
  postcodeRequired,
}: {
  value: AddressTriple;
  /** Marks Postcode "Postcode *" - a master address in Malaysia / Singapore
   *  must carry one (owner 2026-11-19); the host's save enforces it. */
  postcodeRequired: boolean;
  country: string;
  onChange: (next: AddressTriple, derivedCountry: string | null) => void;
  disabled?: boolean;
  classes?: AddressTripleClasses;
}) => {
  const loc = useLocalities();
  const rows = useMemo(() => loc.data ?? [], [loc.data]);
  const { cities, postcodes } = useAddressCascade(rows, value.state, value.city);
  const loading = loc.isLoading;
  const c = classes ?? {};
  const emit = (next: AddressTriple, picked: string | null = null) =>
    onChange(next, picked ?? countryForState(rows, next.state));
  const effectiveCountry = country || countryForState(rows, value.state) || '';

  return (
    <>
      <label className={c.field}>
        <span className={c.label}>State</span>
        <StatePicker
          country={country}
          value={value.state}
          disabled={disabled}
          selectClassName={c.select}
          onChange={(next, derived) => emit(pickState(next), derived)}
        />
      </label>
      <label className={c.field}>
        <span className={c.label}>City</span>
        <SearchableSelect
          chevron
          className={c.select}
          ariaLabel="City"
          value={value.city}
          onChange={(next) => emit(pickCity(rows, value, next))}
          disabled={disabled || loading}
          placeholder={loading ? 'Loading…' : cityPlaceholder(value.state)}
          options={sortByText(cities).map((x) => ({ value: x, label: x }))}
        />
      </label>
      <AddressPostcodeField
        country={effectiveCountry}
        value={value.postcode}
        onChange={(next) => emit({ ...value, postcode: next })}
        onCascadePick={(next) => emit(pickPostcode(rows, value, next))}
        onResolve={(r) => {
          if (r.state && r.city) emit({ state: r.state, city: r.city, postcode: value.postcode });
        }}
        postcodeChoices={postcodes}
        label={postcodeRequired ? 'Postcode *' : 'Postcode'}
        placeholder={loading ? 'Loading…' : postcodePlaceholder(value.state, value.city)}
        disabled={disabled || loading}
        classes={c}
      />
    </>
  );
};
