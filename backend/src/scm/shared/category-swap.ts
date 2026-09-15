/* Which category a model or a model-less SKU may be moved to from the edit
   screens.

   ANY valid category, other than the one it has (owner 2026-09-15: 「by right
   它应该是每一个 category 我都可以换去不一样的 category」). This replaced the
   2026-09-14 rule that allowed only Accessory <-> Sofa Accessory.

   What a move does NOT do: orders already on the books keep the category their
   lines were written with (moving those is a separate, audited data run), and a
   SKU that belongs to a model moves only with its model. */
import { isMfgProductCategory } from './product-categories';

export function categorySwapAllowed(from: string | null | undefined, to: string | null | undefined): boolean {
  const a = String(from ?? '').toUpperCase();
  const b = String(to ?? '').toUpperCase();
  return a !== b && isMfgProductCategory(b);
}
