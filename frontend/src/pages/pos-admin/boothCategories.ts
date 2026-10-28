/* POS Items > Add by category: the pure part of the picker. The counts come
 * from `POST /api/pos-admin/items/add-all { dry_run: true }`; a tick adds the
 * category's products and keeps its POS items, an untick leaves them out. */
import { mfgCategoryLabel } from "../../vendor/shared/product-categories";

export type CategoryCount = { category: string; to_add: number; active: number; off: number; no_price: number };

/** What a booth sells unless the owner ticks otherwise: accessories, bed
 *  linen and diffusers. Sofas, bedframes, mattresses and dining stay out. */
export const BOOTH_DEFAULT_CATEGORIES: readonly string[] = ["ACCESSORY", "FABRIC_ACCESSORY", "BEDLINES", "DIFFUSER"];

export const categoryTitle = (c: string): string => (c === "" ? "No category" : mfgCategoryLabel(c));

/** The ticks a fresh picker opens with: the booth defaults that exist in the counts. */
export const defaultTicks = (counts: readonly CategoryCount[]): Set<string> =>
  new Set(counts.map((c) => c.category).filter((c) => BOOTH_DEFAULT_CATEGORIES.includes(c)));

export type CategoryPlan = { to_add: number; kept: number; to_remove: number };

/** What the two buttons will do for a set of ticks: add the ticked categories'
 *  products, and switch off the POS items in every unticked category. */
export function planFor(counts: readonly CategoryCount[], ticked: ReadonlySet<string>): CategoryPlan {
  const plan: CategoryPlan = { to_add: 0, kept: 0, to_remove: 0 };
  for (const c of counts) {
    if (ticked.has(c.category)) { plan.to_add += c.to_add; plan.kept += c.active; }
    else plan.to_remove += c.active;
  }
  return plan;
}
