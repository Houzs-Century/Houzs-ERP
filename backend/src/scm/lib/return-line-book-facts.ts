// ----------------------------------------------------------------------------
// return-line-book-facts — the values a return line exports the way the account
// book holds them (owner 2026-09-15), shared by the Purchase Return and the
// Delivery Return list reads.
//
//   * ITEM CODE, DESCRIPTION, ITEM GROUP, UOM: services/autocount-book-item.ts
//     bookLineItem — the write-back's own item resolver plus the book's item
//     master, the one home every document export spells an item through — over
//     the write-back's own live bindings read (lib/autocount-outbox.ts
//     bindingsFor: per supplier on a purchase return, as the write-back resolves
//     a purchase line; without a supplier on a delivery return). Only
//     for the company whose book it is (HOUZS, AED_HOUZS): 2990 never syncs to
//     AutoCount (owner 2026-09-09), so its lines keep the ERP's own values.
//   * ITEM DESCRIPTION 2, composed from the line's variants
//     (shared/variant-summary.ts buildVariantSummary), the stored text only when
//     the variants compose nothing (owner 2026-09-15).
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '../shared';
import { bookLineItem } from '../../services/autocount-book-item';
import { bindingsFor } from './autocount-outbox';
import { activeCompanyId, BASE_COMPANY_CODE, type CompanyScopeCtx } from './companyScope';
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

export type ReturnBookContext = {
  inBook: boolean;
  /** The live bindings per supplier id ('' = no supplier). */
  bindings: Map<string, Map<string, string>>;
};

/**
 * Read what the write-back would resolve these lines through: the live
 * bindings, once per supplier. A failed read is an ERROR, never a silent
 * fallback — a file that quietly spells some items another way is worse than
 * no file. Outside the book company nothing is read.
 */
export async function readReturnBookContext(
  sb: unknown,
  c: CompanyScopeCtx,
  lines: Array<{ code: string | null | undefined; supplierId: string | null }>,
): Promise<{ error: string | null; ctx: ReturnBookContext }> {
  const companyId = activeCompanyId(c);
  const inBook = companyHasAutoCountBook(c) && companyId != null;
  const ctx: ReturnBookContext = { inBook, bindings: new Map() };
  if (!inBook) return { error: null, ctx };
  const bySupplier = new Map<string, string[]>();
  for (const l of lines) {
    const code = (l.code ?? '').trim();
    if (!code) continue;
    const key = l.supplierId ?? '';
    bySupplier.set(key, [...(bySupplier.get(key) ?? []), code]);
  }
  try {
    for (const [supplierId, codes] of bySupplier) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bindingsFor takes the untyped supabase-js client the SCM routes carry
      ctx.bindings.set(supplierId, await bindingsFor(sb as any, companyId, codes, supplierId || null));
    }
  } catch (e) {
    return { error: `item bindings: ${e instanceof Error ? e.message : String(e)}`, ctx };
  }
  return { error: null, ctx };
}

/** One return line's book facts. The supplier disambiguates a purchase
 *  return's item; a delivery return names none and passes nulls. */
export function returnLineBookFacts(
  book: ReturnBookContext,
  line: {
    item_code?: string | null;
    description?: string | null;
    item_group?: string | null;
    uom?: string | null;
    variants?: unknown;
    description2?: string | null;
  },
  supplier: { id: string | null; code: string | null },
): ReturnLineBookFacts {
  const description2 = composedDescription2(line.item_group, line.variants, line.description2);
  if (!book.inBook) {
    return {
      itemCode: tidy(line.item_code),
      description: tidy(line.description),
      itemGroup: tidy(line.item_group),
      uom: tidy(line.uom),
      description2,
    };
  }
  const item = bookLineItem(
    { itemCode: line.item_code, description: line.description, category: line.item_group, uom: line.uom },
    supplier.code,
    { bindings: book.bindings.get(supplier.id ?? '') ?? null },
  );
  return { itemCode: item.itemCode, description: item.description, itemGroup: item.itemGroup, uom: item.uom, description2 };
}
