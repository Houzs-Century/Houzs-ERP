
/** The admin-maintained lookup both surfaces read. One string, one endpoint. */
export const ASSR_PRODUCT_CATEGORIES_ENDPOINT = "/api/assr/lookups/product-categories";

/** `"Bedframe, Mattress"` -> `["Bedframe","Mattress"]`.
 *  The API keeps sending the flat display string on the case row for every
 *  read-only surface, so every editor needs this on the way in. */
export function splitCategories(v: string | null | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The chips to render: the lookup's own options, followed by any value the case
 * already carries that the lookup no longer offers.
 *
 * The extras are NOT dropped on purpose. A category an admin retired, or a
 * legacy string from before mig 0112, must stay visible and stay selected —
 * silently discarding it the moment somebody opens the case would delete data
 * the operator never chose to touch. It is the same rule `resolveCategories`
 * follows server-side, which is why the two agree.
 */
export function categoryChipList(options: string[], value: string[]): string[] {
  return [...options, ...value.filter((v) => !options.includes(v))];
}

/** Add or remove one category, preserving order. Returns a new array. */
export function toggleCategory(value: string[], name: string): string[] {
  return value.includes(name) ? value.filter((x) => x !== name) : [...value, name];
}
