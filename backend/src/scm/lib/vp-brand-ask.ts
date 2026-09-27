// ----------------------------------------------------------------------------
// vp-brand-ask -- the reads behind "which brand is this bill for?"
// (owner 2026-09-27). The rule is in vp-brand.ts; this file only fetches.
//
// Called after a save that makes a live order -- a create that is not a draft,
// a draft confirmed -- and the answer rides back on that save's response for
// the form to ask. It NEVER throws and never costs anybody their save: any
// failure is "do not ask", because the question is optional and the order is
// already committed by the time it runs.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import { isFeedEnabled } from './venture-portal-feed-flag';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { vpBrandAsk, vpBrandOptions, type VpBrandAsk } from './vp-brand';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout this tree
type ScmClient = SupabaseClient<any, any, any>;

/** The slice of c.env.DB these reads use. */
export type VpBrandDb = {
  prepare(sql: string): {
    bind(...vals: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
  };
};

/** The company's brands a bill can belong to (vp-brand.ts decides which). */
export async function loadVpBrandOptions(db: VpBrandDb, companySql: string): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT name FROM project_brands WHERE active = 1${companySql} ORDER BY sort_order, name`)
    .bind()
    .all<{ name: string | null }>();
  return vpBrandOptions((rows.results ?? []).map((r) => String(r.name ?? '')));
}

/**
 * Whether the order form should ask which brand `docNo` is for, and with what
 * choices. Null -- do not ask -- for a draft (it is asked when confirmed), a
 * company whose Venture Portal feed is off (nobody downstream reads the
 * answer), a bill whose products already name a brand, one already answered,
 * and on any failure.
 */
export async function loadVpBrandAsk(deps: {
  sb: ScmClient;
  db: VpBrandDb;
  companyId: number | null;
  companySql: string;
  docNo: string;
}): Promise<VpBrandAsk | null> {
  try {
    const { data, error } = await scopeToCompanyIdOrOpen(
      deps.sb
        .from('mfg_sales_orders')
        .select('company_id, status, branding, vp_brand, project_id')
        .eq('doc_no', deps.docNo),
      deps.companyId,
    ).maybeSingle();
    if (error || !data) return null;
    const so = data as {
      company_id: number | null;
      status: string | null;
      branding: string | null;
      vp_brand: string | null;
      project_id: number | null;
    };
    if (String(so.status ?? '').toUpperCase() === 'DRAFT') return null;
    if (!(await isFeedEnabled(deps.sb, so.company_id ?? null))) return null;

    const options = await loadVpBrandOptions(deps.db, deps.companySql);
    let boothBrand: string | null = null;
    if (so.project_id != null) {
      const booth = await deps.db
        .prepare(`SELECT brand FROM projects WHERE id = ?${deps.companySql}`)
        .bind(so.project_id)
        .all<{ brand: string | null }>();
      boothBrand = booth.results?.[0]?.brand ?? null;
    }
    return vpBrandAsk({ branding: so.branding, current: so.vp_brand, boothBrand, options });
  } catch {
    return null;
  }
}
