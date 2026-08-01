// ----------------------------------------------------------------------------
// service-line-guard — reject SERVICE lines where they don't belong.
//
// P1 of the SO all-charges-as-SKU-lines spec (docs/specs/2026-06-04-…, §4.6):
// SERVICE lines (delivery fee / dispose / lift) ride SO → DO → SI, but they
// are NOT returnable goods — a Delivery Return line for a SERVICE SKU would
// write phantom stock IN. Every DR write path calls findServiceLineCodes and
// 409s on offenders.
//
// Defence in depth: payload signals (item_group / SVC- code prefix) catch the
// honest paths for free; the catalog lookup catches a crafted payload that
// lies about both (category='SERVICE' on mfg_products is authoritative).
// ----------------------------------------------------------------------------

import { isServiceLine, isServiceCategory } from '../shared';

export type ServiceGuardLine = {
  itemCode?: string | null;
  itemGroup?: string | null;
};

/** Returns the distinct item codes among `lines` that are SERVICE lines —
 *  by payload signals or by catalog category. Empty array → all clear. */
export async function findServiceLineCodes(
  sb: any,
  lines: ServiceGuardLine[],
  companyId?: number | null,
): Promise<string[]> {
  const offenders = new Set<string>();
  const lookupCodes = new Set<string>();
  for (const l of lines) {
    const code = (l.itemCode ?? '').trim();
    if (isServiceLine({ itemGroup: l.itemGroup, itemCode: code })) {
      offenders.add(code || '(blank)');
    } else if (code) {
      lookupCodes.add(code);
    }
  }
  if (lookupCodes.size > 0) {
    let q = sb
      .from('mfg_products')
      .select('code, category')
      .in('code', [...lookupCodes]);
    if (companyId != null) q = q.eq('company_id', companyId);
    const { data } = await q;
    for (const p of (data ?? []) as Array<{ code: string; category: string | null }>) {
      if (isServiceCategory(p.category)) offenders.add(p.code);
    }
  }
  return [...offenders];
}

/** Canonical 409 body for SERVICE-on-Delivery-Return rejections. */
export const serviceLinesNotReturnableResponse = (codes: string[]) => ({
  error: 'service_lines_not_returnable',
  message:
    `SERVICE ${codes.length === 1 ? 'line is' : 'lines are'} not returnable goods ` +
    `(delivery fee / dispose / lift never re-enter stock): ${codes.join(', ')}. ` +
    `Remove ${codes.length === 1 ? 'it' : 'them'} from the return.`,
  serviceCodes: codes,
});
