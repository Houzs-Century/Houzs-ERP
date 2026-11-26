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
//   Mobile uses the same combobox: a native <select> cannot be typed into, and
//   the operators asked to search State on the phone too.
//
// STYLING: the combobox input reuses the bordered select look (chevron
// included) so it still matches the sibling City / Country / Postcode fields;
// the dropdown panel is a bordered paper card (StatePicker.module.css).
//
// The panel is PORTALLED to <body> and positioned `fixed` from the input's
// rect — same idiom as SoLineCard / SearchableSelect. It was `position:
// absolute` inside the field until 2026-08-13, which meant every address form
// whose card or drawer clips its overflow cut the list off after two or three
// states (owner, on SO detail: "我的 state 的那个 UI 也是被直接斩断了").
//
// The value MUST live in scm.my_localities. While the seed is loading or empty
// the control stays DISABLED ("Loading…" / "No states seeded") — never a
// free-text input, which is the exact pattern this component removes. A stored
// value that isn't in the seeded set is still shown as the current selection so
// old data never blanks; it just isn't offered as a fresh option — pick a
// seeded state, or add the missing one via the Localities Maintenance UI.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useLocalities,
  statesInCountry,
  countryForState,
  distinctStates,
} from '../lib/localities-queries';
import { useAnchoredPanel, anchoredPanelStyle } from '../../../lib/anchoredPanel';
import styles from './StatePicker.module.css';

const PRIMARY_COUNTRY = 'Malaysia' as const;
const UNGROUPED = 'Other' as const;

const PANEL_MAX_H = 280;

export const StatePicker = ({
  country = '',
  value,
  onChange,
  className,
  style,
  disabled,
  placeholder = '— pick state —',
  selectClassName,
}: {
  country?: string;
  value: string;
  onChange: (nextState: string, derivedCountry: string | null) => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  selectClassName?: string;
}) => {
  const localities = useLocalities();
  const rows = localities.data ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const isCountryPinned = country.trim().length > 0;

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
  const quietBlurRef = useRef(false);
  const quietBlur = () => {
    quietBlurRef.current = true;
    inputRef.current?.blur();
    quietBlurRef.current = false;
  };
  const pick = (s: string) => {
    handlePick(s);
    close();
    quietBlur();
  };

  const isEmpty = !localities.isLoading && rows.length === 0;
  const controlsDisabled = disabled || localities.isLoading || isEmpty;

  const panelPos = useAnchoredPanel(inputRef, open && !controlsDisabled, PANEL_MAX_H);

  const wrapCls = className ? `${styles.wrap} ${className}` : styles.wrap;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      close();
      quietBlur();
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
          onBlur={() => {
            if (!quietBlurRef.current && open && !query.trim() && value) handlePick('');
            close();
          }}
        />
        {open && !controlsDisabled && panelPos && createPortal(
          <div
            className={styles.panel}
            role="listbox"
            style={anchoredPanelStyle(panelPos)}
          >
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
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
};
