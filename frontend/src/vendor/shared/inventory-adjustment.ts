
import { missingVariantAxes } from './so-variant-rule';

/** Sofa is colour-matched and shipped as a batched set — its stock is invisible
 *  to the allocator without a batch_no. */
export function isSofaItemGroup(itemGroup: string | null | undefined): boolean {
  return (itemGroup ?? '').toLowerCase() === 'sofa';
}

/**
 * Plain-language reasons an INCREASE adjustment can't be saved yet — [] when OK.
 *   • Sofa / Bedframe must carry their category variant attributes (same axes a
 *     GRN requires) so the found stock matches the order lines that need them.
 *   • Sofa additionally needs a Batch Number, or the stock can never be
 *     allocated to a sales order later.
 */
export function adjustmentIncreaseErrors(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
  batchNo: string | null | undefined,
  itemCode: string | null,
): string[] {
  const errors: string[] = [];

  const missing = missingVariantAxes(itemGroup, variants, itemCode);
  if (missing.length > 0) {
    const labels = missing.map((m) => m.label).join(', ');
    const cat = (itemGroup ?? '').toLowerCase();
    errors.push(`Fill the ${labels} for this ${cat || 'item'} so the found stock matches the right orders.`);
  }

  if (isSofaItemGroup(itemGroup) && !(batchNo ?? '').trim()) {
    errors.push('Sofa stock needs a Batch Number, otherwise it can never be allocated to an order later.');
  }

  return errors;
}
