/* do-spec-lock — a shipped delivery order's line keeps the product and spec it
   shipped as (owner decision 2026-11-10).

   Spec = the item code and everything in the variant key (fabric, size, gap,
   divan / leg / total height, specials). Quantity, price, remarks and dates stay
   editable under their own rules. Changing a spec after the stock left would
   move the line's units into another stock bucket while the goods on the lorry
   stay the same (2990-DO-2611-016: the edit form added "Total 24" and the line
   then traced to no PO). To change a spec, return the goods and raise a new line.

   ONE file, mirrored byte for byte: backend/src/scm/shared/do-spec-lock.ts and
   frontend/src/vendor/shared/do-spec-lock.ts. The server refuses with this
   message; the edit form disables the same fields and shows it. */
import { DO_SHIPPED_STATES } from './do-shipped-states';

export const DO_SPEC_LOCKED_ERROR = 'spec_locked_after_ship';

export const DO_SPEC_LOCKED_MESSAGE =
  'This delivery order has already shipped, so the product and its spec (fabric, size, heights, specials) '
  + 'cannot be changed. Quantity and remarks can still be edited. To change the spec, return the goods '
  + 'with a Delivery Return, then add a new line or a new delivery order with the right spec.';

/** The request keys that carry a line's spec. */
export const DO_SPEC_KEYS = ['itemCode', 'itemGroup', 'variants'] as const;

/** True once the DO has moved stock: its lines' spec is locked. */
export function doSpecLocked(status: string | null): boolean {
  const s = String(status ?? '').trim().toUpperCase();
  return (DO_SHIPPED_STATES as readonly string[]).includes(s);
}
