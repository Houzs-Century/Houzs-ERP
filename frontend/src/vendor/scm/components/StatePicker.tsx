// ----------------------------------------------------------------------------
// StatePicker — the ONE canonical state dropdown for every address surface.
//
// Owner directive 2026-07-24 (task #102): one consistent, clean state selector
// everywhere — no ad-hoc free-text state entry.
//   • States are ALWAYS GROUPED BY COUNTRY. Malaysia (the primary market)
//     lists first, then every other seeded country alphabetically, with any
//     country-less state under "Other".
//   • Owner refinement 2026-07-24 (second pass): typing must filter THE OPEN
//     LIST ITSELF — "应该是 implement 在我 scrolling 的那个地方打字,而不是多加
//     一个 column 出来". The separate "Search state…" input above the select is
//     GONE; desktop is now ONE combobox: click opens the grouped list, typing
//     filters it in place, Enter/click picks, Esc closes. Typing can only
//     NARROW the seeded options; it can NEVER commit a new value — blur without
//     a pick restores the stored value, so the free-text backdoor stays closed.
//   • The legacy "Others" expander stays gone (it hid CN/SG behind a click).
//
// TWO layouts, driven by the `country` prop:
//   • Country pinned (Warehouse / Supplier edit — country is a separate field)
//     → the combobox lists just that country's states, flat.
//   • Country empty (create-supplier / Venue / SO forms) → grouped-by-country.
//   `compact` (mobile) keeps the native <select> — the OS picker already
//   groups and filters better than any web control on a phone.
//
// STYLING: the combobox input reuses the bordered select look (chevron
// included) so it still matches the sibling City / Country / Postcode fields;
// the dropdown panel is a bordered paper card (StatePicker.module.css).
//
// The value MUST live in scm.my_localities. While the seed is loading or empty
// the control stays DISABLED ("Loading…" / "No states seeded") — never a
// free-text input, which is the exact pattern this component removes. A stored
// value that isn't in the seeded set is still shown as the current selection so
// old data never blanks; it just isn't offered as a fresh option — pick a
// seeded state, or add the missing one via the Localities Maintenance UI.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import {
  useLocalities,
  statesInCountry,
  countryForState,
  distinctStates,
} from '../lib/localities-queries';
import styles from './StatePicker.module.css';

const PRIMARY_COUNTRY = 'Malaysia' as const;
const UNGROUPED = 'Other' as const;

export const StatePicker = ({
  country = '',
  value,
  onChange,
  className,
  style,
  disabled,
  placeholder = '— pick state —',
  compact = false,
  selectClassName,
}: {
  /** When set, restrict the picker to this country's states (flat list).
   *  When empty, show every seeded state grouped by country. */
  country?: string;
  value: string;
  /** derivedCountry is the state's country from my_localities — the caller can
   *  patch its own Country field if it was blank. Null if unknown. */
  onChange: (nextState: string, derivedCountry: string | null) => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  /** Compact — render ONLY the grouped native <select>. For mobile / tight
   *  inline contexts where the OS picker (iOS wheel, Android list) is the
   *  better filter. Grouping keeps MY on top. */
  compact?: boolean;
  /** Applied to the inner control so the caller can share its form styles. */
  selectClassName?: string;
}) => {
  const localities = useLocalities();
  const rows = localities.data ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const isCountryPinned = country.trim().length > 0;

  /* Country-pinned: a flat list of that country's states.
     Country-empty: states bucketed by country, MY first, "Other" last. */
  const scoped = useMemo(
    () => (isCountryPinned ? statesInCountry(rows, country) : []),
    [rows, country, isCountryPinned],
  );
  const orderedGroups = useMemo<[string, string[]][]>(() => {
    if (isCountryPinned) return [];
    const byCountry = new Map<string, string[]>();
    for (const s of distinctStates(rows)) {
      const c = countryForState(rows, s) ?? UNGROUPED;
      const arr = byCountry.get(c);
      if (arr) arr.push(s);
      else byCountry.set(c, [s]);
    }
    // MY first, then every other country A→Z, "Other" (country-less) last.
    return Array.from(byCountry.entries()).sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === PRIMARY_COUNTRY) return -1;
      if (b === PRIMARY_COUNTRY) return 1;
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
  }, [rows, isCountryPinned]);

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);

  /* The filtered view the open panel renders, plus a FLAT list of the same
     options in display order for keyboard navigation. */
  const filteredGroups = useMemo<[string, string[]][]>(() => {
    if (isCountryPinned) {
      const opts = scoped.filter(match);
      return opts.length ? [[country, opts]] : [];
    }
    return orderedGroups
      .map(([c, list]) => [c, list.filter(match)] as [string, string[]])
      .filter(([, list]) => list.length > 0);
  }, [isCountryPinned, scoped, orderedGroups, country, q]);
  const flat = useMemo(() => filteredGroups.flatMap(([, list]) => list), [filteredGroups]);

  /* Is the stored value one of the seeded states? If not (legacy data, or a
     state whose country differs from a now-pinned one), it is still shown as
     the current text so it never blanks. */
  const knownStates = useMemo(
    () => new Set(isCountryPinned ? scoped : distinctStates(rows)),
    [isCountryPinned, scoped, rows],
  );
  const orphanValue = value.trim().length > 0 && !knownStates.has(value);

  const handlePick = (nextState: string) => {
    if (!nextState) {
      onChange('', null);
      return;
    }
    const derived = countryForState(rows, nextState);
    onChange(nextState, derived);
  };

  const close = () => {
    setOpen(false);
    setQuery('');
    setActive(0);
  };
  const pick = (s: string) => {
    handlePick(s);
    close();
    inputRef.current?.blur();
  };

  /* Loading / empty locality set: keep the control DISABLED rather than falling
     back to free text. Empty = pre-seed environment; loading = fetch in flight.
     Either way, letting the operator type a raw string is the backdoor this
     component exists to remove. */
  const isEmpty = !localities.isLoading && rows.length === 0;
  const controlsDisabled = disabled || localities.isLoading || isEmpty;

  const wrapCls = className ? `${styles.wrap} ${className}` : styles.wrap;

  /* Compact (mobile) keeps the native grouped <select>. */
  if (compact) {
    return (
      <div className={wrapCls} style={style}>
        <select
          value={value}
          onChange={(e) => handlePick(e.target.value)}
          disabled={controlsDisabled}
          className={selectClassName ?? styles.select}
        >
          <option value="">
            {localities.isLoading ? 'Loading…' : isEmpty ? 'No states seeded' : placeholder}
          </option>
          {orphanValue && <option value={value}>{value}</option>}
          {orderedGroups.map(([c, list]) => (
            <optgroup key={c} label={c}>
              {list.map((s) => (
                <option key={`${c}-${s}`} value={s}>{s}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      close();
      inputRef.current?.blur();
      return;
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = flat[active] ?? flat[0];
      if (chosen) pick(chosen);
    }
  };

  /* One combobox: shows the stored value when closed; opening clears it into a
     live filter (placeholder keeps the current value visible). Options use
     onMouseDown + preventDefault so the pick lands before the input's blur. */
  let flatIdx = -1;
  return (
    <div className={wrapCls} style={style}>
      <div className={styles.comboWrap}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          autoComplete="off"
          value={open ? query : value}
          placeholder={
            localities.isLoading
              ? 'Loading…'
              : isEmpty
                ? 'No states seeded'
                : open && value
                  ? value
                  : placeholder
          }
          disabled={controlsDisabled}
          className={selectClassName ?? styles.select}
          /* House rule (owner 2026-08-09) — opening keeps the current value
             in view: seed the query with it, select-all so typing replaces. */
          onFocus={(e) => {
            setOpen(true);
            setQuery(value ?? '');
            setActive(0);
            e.currentTarget.select();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onBlur={close}
        />
        {open && !controlsDisabled && (
          <div className={styles.panel} role="listbox">
            {orphanValue && !q && (
              <div
                className={styles.optOrphan}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(value);
                }}
              >
                {value}
                <span className={styles.orphanNote}>current — not in the maintained list</span>
              </div>
            )}
            {flat.length === 0 && <div className={styles.emptyRow}>No matching state</div>}
            {filteredGroups.map(([c, list]) => (
              <div key={c}>
                {!isCountryPinned && <div className={styles.groupLabel}>{c}</div>}
                {list.map((s) => {
                  flatIdx += 1;
                  const idx = flatIdx;
                  return (
                    <div
                      key={`${c}-${s}`}
                      role="option"
                      aria-selected={s === value}
                      className={[
                        styles.opt,
                        idx === active ? styles.optActive : '',
                        s === value ? styles.optCurrent : '',
                      ].join(' ')}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(s);
                      }}
                      onMouseEnter={() => setActive(idx)}
                    >
                      {s}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
