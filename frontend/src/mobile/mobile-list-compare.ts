const NUMERIC_COLLATOR = new Intl.Collator(undefined, { numeric: true });

/** Numeric-aware locale compare ("SO-2" before "SO-10"). */
export const byStr = (a: unknown, b: unknown): number =>
  NUMERIC_COLLATOR.compare(String(a ?? ""), String(b ?? ""));
