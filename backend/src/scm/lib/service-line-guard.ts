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
//
// THE CATALOG READ IS LOAD-BEARING, so its failure is reported, not dropped
// (2026-08-13 swallowed-error sweep). It used to be `const { data } = await q`:
// a failed lookup produced no offenders, the caller read that as "all clear",
// and the crafted payload the lookup exists to catch walked straight into a
// Delivery Return line that writes phantom stock IN. A failed read must never
// read as an absence when the absence is what authorises the write.
// ----------------------------------------------------------------------------

import { isServiceLine, isServiceCategory } from '../shared';

export type ServiceGuardLine = {
  itemCode?: string | null;
  itemGroup?: string | null;
};

/** Either the verdict, or the reason no verdict could be reached. `ok: false` is
 *  NOT "all clear" — callers must refuse on it, same as on a found offender. */
export type ServiceGuardResult =
  | { ok: true; codes: string[] }
  | { ok: false; reason: string };

/** Returns the distinct item codes among `lines` that are SERVICE lines —
<<<<<<< HEAD
 *  by payload signals or by catalog category. `ok` with an empty array → all
 *  clear; `ok: false` → the catalog could not be consulted, decide nothing. */
export async function findServiceLineCodes(
  sb: any,
  lines: ServiceGuardLine[],
  companyId?: number | null,
): Promise<ServiceGuardResult> {
=======
 *  by payload signals or by catalog category. Empty array → all clear.
 *
 *  companyId is REQUIRED (an explicit `null` still means "no predicate"). The
 *  catalog half of this guard is the half that catches a crafted payload, and
 *  `code` is unique only per company — unscoped it answers about the OTHER
 *  company's catalog row, so the same payload can be cleared or refused
 *  depending on which company's SKU master happens to hold that code. That is
 *  not a decision a caller should be able to make by omission
 *  (optional-param-noop sweep 2026-08-13). */
export async function findServiceLineCodes(
  sb: any,
  lines: ServiceGuardLine[],
  companyId: number | null | undefined,
): Promise<string[]> {
>>>>>>> origin/sweep/optional-param-noop
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
    const { data, error } = await q;
    if (error) return { ok: false, reason: error.message ?? 'catalog lookup failed' };
    for (const p of (data ?? []) as Array<{ code: string; category: string | null }>) {
      if (isServiceCategory(p.category)) offenders.add(p.code);
    }
  }
  return { ok: true, codes: [...offenders] };
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

/** Canonical 409 body for "the catalog could not be consulted". Refuse rather
 *  than guess: an unchecked line is the one that writes phantom stock IN. */
export const serviceGuardUnavailableResponse = (reason: string) => ({
  error: 'service_check_failed',
  message:
    `Could not check whether these lines are SERVICE lines, so the return was not saved — try again (${reason}).`,
});
