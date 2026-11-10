/* One collator for the phone lists' text sort. `localeCompare` with options
   resolves a fresh Intl.Collator on every call (ECMA-402), and a sort makes
   n log n comparisons, so a long list built thousands of collators per tap.
   Same locale and options as before, so the order is unchanged. */
const NUMERIC_COLLATOR = new Intl.Collator(undefined, { numeric: true });

/** Numeric-aware locale compare ("SO-2" before "SO-10"). */
export const byStr = (a: unknown, b: unknown): number =>
  NUMERIC_COLLATOR.compare(String(a ?? ""), String(b ?? ""));
