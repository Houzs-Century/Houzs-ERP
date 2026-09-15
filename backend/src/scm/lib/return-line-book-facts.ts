// ----------------------------------------------------------------------------
// return-line-book-facts — the values a return line exports the way the account
// book holds them (owner 2026-09-15), shared by the Purchase Return and the
// Delivery Return list reads.
//
//   * ITEM CODE, DESCRIPTION, ITEM GROUP, UOM: services/autocount-book-item.ts
//     bookLineItem — the write-back's own item resolver plus the book's item
//     master, the one home every document export spells an item through. Only
//     for the company whose book it is (HOUZS, AED_HOUZS): 2990 never syncs to
//     AutoCount (owner 2026-09-09), so its lines keep the ERP's own values.
//   * ITEM DESCRIPTION 2, composed from the line's variants
//     (shared/variant-summary.ts buildVariantSummary), the stored text only when
//     the variants compose nothing (owner 2026-09-15).
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '../shared';
import { bookLineItem } from '../../services/autocount-book-item';
import { BASE_COMPANY_CODE, type CompanyScopeCtx } from './companyScope';
import type { ReturnLineBookFacts } from './return-line-export-columns';

export function composedDescription2(
  itemGroup: string | null | undefined,
  variants: unknown,
  stored: string | null | undefined,
): string | null {
  const composed = variants && typeof variants === 'object'
    ? buildVariantSummary(itemGroup ?? null, variants as Record<string, unknown>)
    : '';
  const text = (composed || stored || '').trim();
  return text === '' ? null : text;
}

/** Does the active company keep its books in AutoCount? */
export function companyHasAutoCountBook(c: CompanyScopeCtx): boolean {
  const code = c.get('companyCode');
  return typeof code === 'string' && code.trim().toUpperCase() === BASE_COMPANY_CODE;
}

const tidy = (v: string | null | undefined): string | null => String(v ?? '').trim() || null;

/** One return line's book facts. `supplierCode` disambiguates a purchase
 *  return's item; a delivery return names no supplier and passes null. */
export function returnLineBookFacts(
  inBook: boolean,
  line: {
    item_code?: string | null;
    description?: string | null;
    item_group?: string | null;
    uom?: string | null;
    variants?: unknown;
    description2?: string | null;
  },
  supplierCode: string | null,
): ReturnLineBookFacts {
  const description2 = composedDescription2(line.item_group, line.variants, line.description2);
  if (!inBook) {
    return {
      itemCode: tidy(line.item_code),
      description: tidy(line.description),
      itemGroup: tidy(line.item_group),
      uom: tidy(line.uom),
      description2,
    };
  }
  const book = bookLineItem(
    { itemCode: line.item_code, description: line.description, category: line.item_group, uom: line.uom },
    supplierCode,
  );
  return { itemCode: book.itemCode, description: book.description, itemGroup: book.itemGroup, uom: book.uom, description2 };
}
