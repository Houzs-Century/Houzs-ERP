/* ---------------------------------------------------------------------------
 * assr_cases.service_category — the PRODUCT category, and the one place its
 * rules live.
 *
 * WHAT IT IS, because the name invites the wrong guess. There are two category
 * columns on a service case and they are not versions of each other:
 *
 *   - `issue_category`  — WHAT WENT WRONG (damage, defect, wrong item...). This
 *     is the one the intake form and the dispatcher dashboard use, and it is
 *     what `backend/src/routes/assr.ts` means when it says the intake form
 *     "replaced the older service_category-driven flow".
 *   - `service_category` — WHICH PRODUCT it is about (Mattress, Bedframe,
 *     Sofa...). Still live, still maintained, and MULTI-VALUE: one complaint can
 *     be a bedframe AND a mattress.
 *
 * That second one is NOT free text and has not been since mig 0112. It is an
 * admin-maintained lookup (`assr_product_categories`) plus a join table
 * (`assr_case_categories`), and the join table is what every count and
 * breakdown reads — a comma-joined string cannot count a Bedframe+Mattress case
 * once on each side.
 *
 * WHY A TYPED VALUE IS LOSSY, which is the whole reason this module exists.
 * `resolveCategories` in `backend/src/services/assr.ts` keeps an unrecognised
 * token in the DISPLAY string but writes it NO row in the join table. So a
 * hand-typed "Mattres" both fragments the desktop list's category filter — it
 * becomes its own bucket — and leaves the case uncategorised for every report.
 * It fails quietly and it fails twice.
 *
 * The phone bound this column as `type: "text"` and sent a bare STRING while
 * the desktop sent an ARRAY from a chip picker over this lookup. Both surfaces
 * now read this file, so neither can re-derive a different answer.
 * ------------------------------------------------------------------------- */

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
