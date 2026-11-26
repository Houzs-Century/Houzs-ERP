
/** The column facts these helpers need — `Column<T>` structurally satisfies it. */
export type ColumnPrefShape = {
  key: string;
  alwaysVisible?: boolean;
  defaultHidden?: boolean;
};

/** What DataTable persists: table order, plus the two visibility lists.
 *  `order` is absent when the gesture has no business pinning one — only a
 *  baseline escape needs to bank the preset's arrangement. */
export type ColumnPrefs = {
  order?: string[];
  hidden: string[];
  shown: string[];
};

/**
 * The prefs that reproduce what is on screen right now.
 *
 * `columns` must already be in table order and `effectiveHidden` must be the
 * set DataTable is rendering from (baseline lists ∪ unshown `defaultHidden`),
 * so the result is the current view stated as ordinary prefs — nothing moves.
 */
export function materializeColumnPrefs(
  columns: ColumnPrefShape[],
  effectiveHidden: ReadonlySet<string>,
): Required<ColumnPrefs> {
  const movable = columns.filter((c) => !c.alwaysVisible);
  return {
    order: movable.map((c) => c.key),
    hidden: movable.filter((c) => effectiveHidden.has(c.key)).map((c) => c.key),
    shown: movable
      .filter((c) => c.defaultHidden && !effectiveHidden.has(c.key))
      .map((c) => c.key),
  };
}

/**
 * One column flipped. Under a baseline the prefs are banked first (so the write
 * lands at all, and the preset's order survives the baseline lifting); without
 * one the user's own lists are edited in place and the order is left alone.
 *
 * Both paths follow the same rule: revealing drops the column from `hidden` and
 * records it in `shown` only when it is `defaultHidden` ("shown despite the
 * flag"); hiding does the reverse.
 */
export function toggleColumnPrefs(
  columns: ColumnPrefShape[],
  effectiveHidden: ReadonlySet<string>,
  key: string,
  current: { hidden: string[]; shown: string[] },
  baselineActive: boolean,
): ColumnPrefs {
  const base = baselineActive ? materializeColumnPrefs(columns, effectiveHidden) : null;
  const hidden = new Set(base ? base.hidden : current.hidden);
  const shown = new Set(base ? base.shown : current.shown);
  if (effectiveHidden.has(key)) {
    hidden.delete(key);
    if (columns.find((c) => c.key === key)?.defaultHidden) shown.add(key);
  } else {
    hidden.add(key);
    shown.delete(key);
  }
  return { order: base?.order, hidden: [...hidden], shown: [...shown] };
}

/**
 * Every column on. `shown` is written explicitly so a `defaultHidden` column
 * stays on rather than snapping back on the next mount — and under a baseline
 * the order is banked, because an empty hidden-list alone reads as "untouched"
 * and would leave the preset in charge, hiding the same columns as before.
 */
export function showAllColumnPrefs(
  columns: ColumnPrefShape[],
  effectiveHidden: ReadonlySet<string>,
  baselineActive: boolean,
): ColumnPrefs {
  const movable = columns.filter((c) => !c.alwaysVisible);
  return {
    order: baselineActive ? materializeColumnPrefs(columns, effectiveHidden).order : undefined,
    hidden: [],
    shown: movable.filter((c) => c.defaultHidden).map((c) => c.key),
  };
}
