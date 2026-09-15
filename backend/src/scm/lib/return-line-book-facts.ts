// ----------------------------------------------------------------------------
// return-line-book-facts — two values a return line exports the way the account
// book holds them (owner 2026-09-15), shared by the Purchase Return and the
// Delivery Return list reads.
//
//   * ITEM CODE, as AutoCount spells it: the write-back's own resolver
//     (services/autocount-item-code.ts resolveAcItemCode) over the write-back's
//     own live bindings read (lib/autocount-outbox.ts bindingsFor). Not a copy —
//     a code the book would receive under another name exports under that name.
//     Only for the company whose book it is (HOUZS, AED_HOUZS): 2990 never syncs
//     to AutoCount (owner 2026-09-09), so its lines keep the ERP's own code.
//   * ITEM DESCRIPTION 2, composed from the line's variants
//     (shared/variant-summary.ts buildVariantSummary), the stored text only when
//     the variants compose nothing (owner 2026-09-15).
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '../shared';
import { resolveAcItemCode } from '../../services/autocount-item-code';
import { bindingsFor } from './autocount-outbox';
import { activeCompanyId, BASE_COMPANY_CODE, type CompanyScopeCtx } from './companyScope';

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

export type ItemCodeSpeller = (code: string | null | undefined, supplierId: string | null, supplierCode: string | null) => string | null;

/**
 * Read the bindings for these lines once (per supplier, so a purchase return's
 * own creditor's binding wins as it does on the write-back) and return a pure
 * speller. A failed bindings read is an ERROR, never a silent fallback to the
 * ERP code: a file that quietly mixes spellings is worse than no file.
 */
export async function readItemCodeSpeller(
  sb: unknown,
  c: CompanyScopeCtx,
  lines: Array<{ code: string | null | undefined; supplierId: string | null }>,
): Promise<{ error: string | null; spell: ItemCodeSpeller }> {
  const own: ItemCodeSpeller = (code) => {
    const s = (code ?? '').trim();
    return s === '' ? null : s;
  };
  const companyId = activeCompanyId(c);
  if (!companyHasAutoCountBook(c) || companyId == null) return { error: null, spell: own };

  const bySupplier = new Map<string, string[]>();
  for (const l of lines) {
    const code = (l.code ?? '').trim();
    if (!code) continue;
    const key = l.supplierId ?? '';
    const arr = bySupplier.get(key) ?? [];
    arr.push(code);
    bySupplier.set(key, arr);
  }
  const maps = new Map<string, Map<string, string>>();
  try {
    for (const [supplierId, codes] of bySupplier) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bindingsFor takes the untyped supabase-js client the SCM routes carry
      maps.set(supplierId, await bindingsFor(sb as any, companyId, codes, supplierId || null));
    }
  } catch (e) {
    return { error: `item code bindings: ${e instanceof Error ? e.message : String(e)}`, spell: own };
  }
  const spell: ItemCodeSpeller = (code, supplierId, supplierCode) => {
    const erp = own(code, supplierId, supplierCode);
    if (!erp) return null;
    const r = resolveAcItemCode(erp, { supplierCode, bindings: maps.get(supplierId ?? '') ?? null });
    return r.ok ? r.acItemCode : erp;
  };
  return { error: null, spell };
}
