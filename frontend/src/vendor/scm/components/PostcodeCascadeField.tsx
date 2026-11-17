import type { ReactNode } from 'react';
import { AddressPostcodeField } from './AddressPostcodeField';
import { useLocalities, countryForState, allPostcodes } from '../lib/localities-queries';
import { pickPostcode, postcodeOptionsFor, postcodePlaceholder, type AddressTriple } from '../lib/address-cascade';

/* The Sales Order form's Postcode picker (AddressPostcodeField over the
   my_localities cascade), for a form whose State and City are plain text: the DP
   job forms and the supplier forms. Picking a postcode fills City and State back
   (pickPostcode), so "the customer read me a postcode" is one step.

   Two things differ from the SO form, both because State / City here are free
   text: a typed City that the catalogue spells differently would narrow the
   list to nothing, so an empty narrowed list falls back to every postcode; and
   the stored value is always offered, so a postcode outside the catalogue still
   shows instead of blanking. */
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
  /** The whole triple after the pick: the postcode, and State / City filled back. */
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
