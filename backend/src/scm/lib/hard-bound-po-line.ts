/* ----------------------------------------------------------------------------
   hard-bound-po-line — the write-side rules that keep a customer's purchase line
   visible to MRP as that customer's purchase line.

   Owner 2026-09-15: 「我们明明已经开了 PO，可是它又显示着 shortage」. A company-1
   sofa / bedframe / Sofa Accessory / `(SP)` mattress sales line (`isHardBoundLine`)
   is covered only by a purchase line LINKED to it (`so_item_id`). Three write
   shapes broke that while every read was correct:

   - a link between two lines of DIFFERENT categories — the two engines each read
     one side's group, so the purchase order sat on a list the line never reads;
   - clearing the link on a bound purchase line — in company 1 an unlinked bound
     line is supply for nobody (bound lines never draw from the pool), so the
     purchase order stops counting while the goods are still coming;
   - splitting a bound line across several sales lines — `so_item_id` is single
     valued and MRP and the stored allocator read only it, so every slice but one
     reads SHORT (0 allocation rows on prod 2026-09-15, run 34944608976).

   Pure except `editedLineGroup`, which does the one SKU read the line PATCH needs.
   Each refusal's `message` stays under 200 characters: the client's humanApiError
   shows the server's sentence only below that length.
   -------------------------------------------------------------------------- */

import { isHardBoundLine, HARD_BOUND_COMPANY_ID } from './so-stock-allocation';
import { skuCategoryResolver } from './sku-category';

const group = (g: unknown): string => String(g ?? '').trim().toLowerCase();

export type SoLinkCategoryMismatch = {
  error: 'so_link_category_mismatch';
  message: string;
  itemGroup: string | null;
  soItemGroup: string | null;
};

/**
 * Refuse a link whose purchase line and sales line disagree on category when
 * either side is hard-bound. Both groups are stamped from the SKU when written,
 * so a disagreement means one side is out of date (a SKU moved category after the
 * sales order was taken); linking anyway is what hid HC-PO-010086 from its order.
 * Unbound pairs are not this rule's business — they pool, and on prod 2026-09-15
 * 17 open company-1 sales lines carry an unbound group that is not their SKU's
 * (`others` on DINING / SERVICE items), none bound either way.
 */
export function soLinkCategoryMismatch(
  po: { itemCode: unknown; itemGroup: unknown },
  so: { item_code: string | null; item_group: string | null },
): SoLinkCategoryMismatch | null {
  if (group(po.itemGroup) === group(so.item_group)) return null;
  const poBound = isHardBoundLine(po.itemGroup as string | null, po.itemCode as string | null);
  if (!poBound && !isHardBoundLine(so.item_group, so.item_code)) return null;
  const poG = (po.itemGroup as string | null) ?? null;
  return {
    error: 'so_link_category_mismatch',
    message: `This line is ${poG ?? 'uncategorised'} but the Sales Order line is ${so.item_group ?? 'uncategorised'}. Correct the category on one of them, then link it.`,
    itemGroup: poG,
    soItemGroup: so.item_group ?? null,
  };
}

/** The create path's batch form: the first linked request line whose resolved
 *  group disagrees with its source line. `groupOf` is the SKU resolver the create
 *  stores with, so the check reads the group that will actually be written. */
export function firstSoLinkCategoryMismatch(
  items: Array<Record<string, unknown>>,
  soRows: Array<{ id: string; item_code: string | null; item_group: string | null }>,
  groupOf: (it: Record<string, unknown>) => string | null,
): (SoLinkCategoryMismatch & { soItemId: string }) | null {
  const byId = new Map(soRows.map((r) => [r.id, r]));
  for (const it of items) {
    const soItemId = it.soItemId as string | undefined;
    const so = soItemId ? byId.get(soItemId) : undefined;
    if (!soItemId || !so) continue;
    const bad = soLinkCategoryMismatch({ itemCode: it.itemCode, itemGroup: groupOf(it) }, so);
    if (bad) return { ...bad, soItemId };
  }
  return null;
}

const bound = (companyId: number | null, line: { item_group: string | null; item_code: string | null }) =>
  companyId === HARD_BOUND_COMPANY_ID && isHardBoundLine(line.item_group, line.item_code);

/**
 * Refuse clearing the link on a company-1 bound purchase line. Re-pointing it at
 * another sales line is still allowed, and so is deleting the line; what is not is
 * a customer's piece still on order that no order counts. (A received line cannot
 * reach this: the line PATCH is locked once a goods receipt exists.)
 */
export function hardBoundUnlinkRefusal(
  companyId: number | null,
  line: { item_group: string | null; item_code: string | null },
  prevSoItemId: string | null,
  nextSoItemId: string | null,
): { error: 'hard_bound_unlink_refused'; message: string } | null {
  if (!prevSoItemId || nextSoItemId || !bound(companyId, line)) return null;
  return {
    error: 'hard_bound_unlink_refused',
    message: 'This line is ordered for a customer\'s sales order and would count for no order unlinked. Pick the sales order line it is for, or remove the line.',
  };
}

/** Refuse an allocation split (mig 0235) on a company-1 bound purchase line: one
 *  line buys for one sales line. Deleting an existing slice stays allowed. */
export function hardBoundSplitRefusal(
  companyId: number | null,
  line: { item_group: string | null; item_code: string | null },
): { error: 'hard_bound_line_not_splittable'; message: string } | null {
  if (!bound(companyId, line)) return null;
  return {
    error: 'hard_bound_line_not_splittable',
    message: 'A sofa, bedframe or Sofa Accessory line is bought for one sales order line and cannot be split. Add a line for each order instead.',
  };
}

/**
 * The group a line PATCH stores: the SKU's when the item is catalogued, else the
 * body's, else the stored one. `undefined` when neither the item code nor the group
 * was sent, so the PATCH's absent-key-keeps contract holds. Create and add-line
 * already resolve through the SKU; the PATCH wrote `itemGroup` as sent.
 */
export async function editedLineGroup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client is untyped; see lib/sku-category.ts
  sb: any,
  companyId: number | null,
  prev: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<string | null | undefined> {
  if (body.itemGroup === undefined && body.itemCode === undefined) return undefined;
  const line = {
    materialKind: body.materialKind ?? prev.material_kind ?? 'mfg_product',
    itemCode: body.itemCode ?? prev.item_code,
  };
  const groupOf = await skuCategoryResolver(sb, [line], companyId);
  return groupOf({ ...line, itemGroup: body.itemGroup !== undefined ? body.itemGroup : prev.item_group });
}
