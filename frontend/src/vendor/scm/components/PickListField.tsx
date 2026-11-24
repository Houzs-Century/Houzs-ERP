import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { listEntryOf } from '../../shared/pick-lists';

export type PickListClasses = { field?: string; label?: string; select?: string; selectWrap?: string; chevron?: string; input?: string };

/* A fixed pick list (vendor/shared/pick-lists) with one free-text way out: its
   last choice (Custom, Other) opens a box to type in. A stored value the list
   does not have opens in that box, so it is shown and saved back as it is,
   never blanked; one the list has in another case ("HONG LEONG BANK") is shown
   as that entry. The supplier forms' payment terms and bank, on desktop and on
   the phone. */
export const PickListField = ({ label, options, other, value, onChange, pickLabel, typePlaceholder, upper, classes }: {
  label: string;
  options: readonly string[];
  /** The free-text choice, e.g. "Custom" or "Other". */
  other: string;
  value: string;
  onChange: (next: string) => void;
  /** The empty choice's text. */
  pickLabel: string;
  typePlaceholder: string;
  /** The typed box shows upper case: the database upper-cases the column. */
  upper: boolean;
  classes: PickListClasses;
}) => {
  const entry = listEntryOf(options, value);
  const [typing, setTyping] = useState(() => entry === null && value.trim() !== '');
  const select = (
    <select className={classes.select} value={typing ? other : (entry ?? '')} aria-label={label}
      onChange={(e) => {
        const v = e.target.value;
        setTyping(v === other);
        onChange(v === other ? '' : v);
      }}>
      <option value="">{pickLabel}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
      <option value={other}>{other}</option>
    </select>
  );
  return (
    <label className={classes.field}>
      <span className={classes.label}>{label}</span>
      {classes.selectWrap ? (
        <span className={classes.selectWrap}>
          {select}
          {classes.chevron && <ChevronDown size={14} strokeWidth={1.75} className={classes.chevron} />}
        </span>
      ) : select}
      {typing && (
        <input data-upper={upper ? '' : undefined} className={classes.input} style={{ marginTop: 4 }} value={value}
          placeholder={typePlaceholder} aria-label={`${label} (${other})`}
          onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
};
