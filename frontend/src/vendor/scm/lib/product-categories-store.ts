/* The product categories every screen offers, read from the server
   (GET /mfg-products/categories = scm.acc_item_groups, the one list, HC-0258).
   A category added in Accounting -> Item groups shows on every picker with no
   release. Nothing in the frontend lists the categories.

   useProductCategories() is the picker hook. The plain functions below
   (mfgCategoryLabel, parseMfgCategory, isMfgProductCategory) read the last list
   the hook loaded, so a label inside a helper or a PDF needs no hook of its own.
   shortcut: before the first load a label reads in Title Case ("FABRIC_ACCESSORY"
   -> "Fabric Accessory"); Layout and MobileApp load the list at start-up, so this
   lasts one request. Upgrade to a context if a screen ever renders before it. */
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import {
  activeProductCategories,
  isMfgProductCategory as isIn,
  mfgCategoryLabel as labelIn,
  parseMfgCategory as parseIn,
  type MfgProductCategory,
  type ProductCategory,
} from '../../shared/product-categories';

export { isSingleSkuCategory, type MfgProductCategory, type ProductCategory } from '../../shared/product-categories';

let loaded: readonly ProductCategory[] = [];

export const PRODUCT_CATEGORIES_QUERY_KEY = ['product-categories'] as const;

/** Every registry category (`all`, so an old row still shows its name) and the active ones a picker offers. */
export function useProductCategories(): { all: readonly ProductCategory[]; active: ProductCategory[]; isLoading: boolean } {
  const q = useQuery({
    queryKey: PRODUCT_CATEGORIES_QUERY_KEY,
    queryFn: async () => {
      const r = await authedFetch<{ categories: ProductCategory[] }>('/mfg-products/categories');
      loaded = r.categories;
      return r.categories;
    },
    staleTime: 5 * 60_000,
  });
  const all = q.data ?? loaded;
  return { all, active: activeProductCategories(all), isLoading: q.isLoading };
}

/** Seed the list (tests, or a caller that already fetched it). */
export function primeProductCategories(list: readonly ProductCategory[]): void {
  loaded = list;
}

/** Load the list once if no screen has yet, so a PDF built straight after start-up still prints names. */
export async function ensureProductCategories(): Promise<readonly ProductCategory[]> {
  if (loaded.length === 0) loaded = (await authedFetch<{ categories: ProductCategory[] }>('/mfg-products/categories')).categories;
  return loaded;
}

/** A category's registry name (Title Case for a code not loaded yet). */
export const mfgCategoryLabel = (c: string | null | undefined): string => labelIn(loaded, c);
export const parseMfgCategory = (input: string | null | undefined): MfgProductCategory | null => parseIn(loaded, input);
export const isMfgProductCategory = (c: string | null | undefined): boolean => isIn(loaded, c);
/** The list last loaded, for code that is not a component. */
export const loadedProductCategories = (): readonly ProductCategory[] => loaded;
