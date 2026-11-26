import type { ReactNode } from 'react';
import { AddressPostcodeField } from './AddressPostcodeField';
import { useLocalities, countryForState, allPostcodes } from '../lib/localities-queries';
import { pickPostcode, postcodeOptionsFor, postcodePlaceholder, type AddressTriple } from '../lib/address-cascade';

export const PostcodeCascadeField = ({
  value,
  state,
  city,
  onPick,
  label,
  classes,
}: {
  value: string;
  state: string;
  city: string;
  onPick: (next: AddressTriple) => void;
  label: ReactNode;
  classes: { field?: string; label?: string; select?: string; selectWrap?: string; chevron?: string; input?: string };
}) => {
  const loc = useLocalities();
  const rows = loc.data ?? [];
  const narrowed = postcodeOptionsFor(rows, state, city);
  const pool = narrowed.length > 0 ? narrowed : allPostcodes(rows);
  const choices = value && !pool.includes(value) ? [value, ...pool] : pool;
  const current: AddressTriple = { state, city, postcode: value };
  return (
    <AddressPostcodeField
      country={countryForState(rows, state) ?? ''}
      value={value}
      onChange={(v) => onPick({ ...current, postcode: v })}
      onCascadePick={(v) => onPick(pickPostcode(rows, current, v))}
      onResolve={(r) => onPick({ state: r.state ?? state, city: r.city ?? city, postcode: value })}
      postcodeChoices={choices}
      placeholder={loc.isLoading ? 'Loading…' : postcodePlaceholder(state, city)}
      disabled={loc.isLoading}
      label={label}
      classes={classes}
    />
  );
};
