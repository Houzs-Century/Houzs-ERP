
/** The latest (max) of the non-null/non-empty date strings, or null if none. */
export function effectiveDelivery(
  ...dates: Array<string | null | undefined>
): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (best === null || d > best) best = d;
  }
  return best;
}
