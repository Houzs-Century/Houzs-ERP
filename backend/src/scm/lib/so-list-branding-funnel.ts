// ----------------------------------------------------------------------------
// so-list-branding-funnel — the Sales Order list's Branding column funnel,
// pushed into the list query so the pager runs over the filtered set.
//
// Owner report 2026-10-17: ticking BRANDING = ZANOTTI filtered only the 50 rows
// of the loaded page (9 left) while the footer still said "1-50 of 3,465 · 70
// pages". A funnel is client-side; on a server-paged list it must be pushed down.
//
// The grid's Branding cell is NOT a plain column: it is the header `branding`
// unless that is blank or a placeholder ("NONE"), else a label derived from the
// order's first main line (so-list-first-item-branding.ts + brandingLabel). The
// header backfill (2026-09-14) and the create stamp write the header whenever
// that label IS a maintained brand, so for a brand ("ZANOTTI") the header column
// answers exactly. A label that is only ever derived ("Accessory", "No Items",
// an unmaintained mattress brand) never sits on a header — for those the read
// admits every order whose header is blank/placeholder (a superset; the grid's
// own page-level funnel then trims the page). Which values are header values is
// probed per value, company-scoped, so the common brand case stays exact.
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { PLACEHOLDER_BRAND_TEXTS } from '../shared/so-branding-label';

/** Past this many ticked values the probe is skipped and every value is treated
 *  as possibly label-only (still correct, just a superset). */
export const BRANDING_FUNNEL_PROBE_CAP = 40;

/* Every value double-quoted with `"` and `\` escaped: a brand may carry a comma,
   a dot or a parenthesis, all reserved inside PostgREST's `or=(...)`. */
export const quote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The `or=` expression for the funnel.
 * @param headerValues values that DO occur as a header `branding`
 * @param labelOnly    true when some ticked value never occurs on a header, so
 *                     blank/placeholder-header orders (whose cell is derived)
 *                     must be admitted too
 */
export function brandingFunnelOr(headerValues: readonly string[], labelOnly: boolean): string | null {
  const terms: string[] = [];
  if (headerValues.length > 0) terms.push(`branding.in.(${[...new Set(headerValues)].map(quote).join(',')})`);
  if (labelOnly) {
    terms.push('branding.is.null');
    terms.push(`branding.in.(${['', ...PLACEHOLDER_BRAND_TEXTS].map(quote).join(',')})`);
  }
  return terms.length > 0 ? terms.join(',') : null;
}

export type BrandingFunnelRead =
  | { ok: true; or: string | null }
  | { ok: false; status: 500; body: { error: string; reason: string } };

export async function resolveSoBrandingFunnel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout (see salesScope.ts)
  sb: any,
  c: CompanyScopeCtx,
  values: readonly string[] | null,
): Promise<BrandingFunnelRead> {
  if (!values || values.length === 0) return { ok: true, or: null };
  if (values.length > BRANDING_FUNNEL_PROBE_CAP) return { ok: true, or: brandingFunnelOr(values, true) };
  const probes = await Promise.all(values.map(async (v) => {
    const { data, error } = await scopeToCompany(
      sb.from('mfg_sales_orders_with_payment_totals').select('doc_no').eq('branding', v).limit(1),
      c,
    );
    return { v, error: error as { message: string } | null, hit: ((data ?? []) as unknown[]).length > 0 };
  }));
  const failed = probes.find((p) => p.error);
  if (failed) return { ok: false, status: 500, body: { error: 'load_failed', reason: `branding funnel: ${failed.error!.message}` } };
  const headerValues = probes.filter((p) => p.hit).map((p) => p.v);
  const labelOnly = probes.some((p) => !p.hit);
  return { ok: true, or: brandingFunnelOr(headerValues, labelOnly) };
}
