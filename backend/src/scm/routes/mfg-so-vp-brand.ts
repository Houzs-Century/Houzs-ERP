// ----------------------------------------------------------------------------
// mfg-so-vp-brand -- a person answers "which brand is this bill for?"
// (owner 2026-09-27).
//
//   PUT /:docNo/vp-brand   { brand: string | null }
//
// The order form asks after a save whose products name no brand (a bed frame or
// an accessory bill written at a brand's fair); the save's own response carries
// the question and its choices (lib/vp-brand-ask.ts). This is where the answer
// lands: mfg_sales_orders.vp_brand, read by nothing in this system -- the
// Venture Portal feed sends it as `vpBrand` and the portal's margin ladder
// follows it. `branding` is never touched. `brand: null` clears an answer.
//
// Mounted at /mfg-sales-orders BEFORE the main router, like the fair picker, so
// it sits behind the same area guard (a PUT needs Sales Orders at `edit`) and
// the migrated-order lock. In its own file because mfg-sales-orders.ts is on
// its size ceiling.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanySql, requireActiveCompanyId, scopeToCompanyId } from '../lib/companyScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { soDocOutOfScope } from '../lib/salesScope';
import { recordSoAudit } from '../lib/so-audit';
import { matchVpBrand } from '../lib/vp-brand';
import { loadVpBrandOptions, type VpBrandDb } from '../lib/vp-brand-ask';
import type { Env, Variables } from '../env';

export const mfgSoVpBrand = new Hono<{ Bindings: Env; Variables: Variables }>();

mfgSoVpBrand.use('*', supabaseAuth);

mfgSoVpBrand.put('/:docNo/vp-brand', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  let body: { brand?: unknown };
  try {
    body = (await c.req.json()) as { brand?: unknown };
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  if (body.brand != null && typeof body.brand !== 'string') return c.json({ error: 'bad_brand' }, 400);

  /* STRICT company scope for a write -- refuse when unresolved rather than run
     wide (companyScope.ts). The order is read under it, so another company's
     doc_no is "not found". */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(
    sb
      .from('mfg_sales_orders')
      .select('doc_no, vp_brand, salesperson_id, access_staff_ids, open_to_all')
      .eq('doc_no', docNo),
    co.companyId,
  ).maybeSingle();
  if (error) return c.json({ error: 'so_read_failed' }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const so = data as {
    vp_brand: string | null;
    salesperson_id: number | string | null;
    access_staff_ids: string[] | null;
    open_to_all: boolean | null;
  };

  /* A salesperson who sees only their own orders answers only for their own --
     the same own/downline rule every write on a sales order keeps
     (selfScopedSalesBlocked in mfg-sales-orders.ts). Out of scope reads as
     not found, like a doc_no that does not exist. */
  if (!canViewAllSales(c)) {
    const outOfScope = await soDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, false, {
      salespersonId: so.salesperson_id,
      accessStaffIds: so.access_staff_ids,
      openToAll: so.open_to_all,
    });
    if (outOfScope) return c.json({ error: 'not_found' }, 404);
  }

  /* The same choices the question offered: this company's brands the portal
     pays a margin ladder on (vp-brand-ask.ts). Anything else is refused. */
  let brand: string | null = null;
  if (typeof body.brand === 'string' && body.brand.trim() !== '') {
    const options = await loadVpBrandOptions({
      sb, db: c.env.DB as unknown as VpBrandDb, companySql: activeCompanySql(c),
    });
    brand = matchVpBrand(body.brand, options);
    if (brand == null) return c.json({ error: 'not_a_brand', options }, 400);
  }

  const before = so.vp_brand ?? null;
  if (before === brand) return c.json({ ok: true, docNo, vpBrand: brand, unchanged: true });

  const { error: updErr } = await scopeToCompanyId(
    sb.from('mfg_sales_orders').update({ vp_brand: brand }).eq('doc_no', docNo),
    co.companyId,
  );
  if (updErr) return c.json({ error: 'vp_brand_update_failed' }, 500);

  const user = c.get('user') as { id?: string | null; user_metadata?: { name?: string } } | undefined;
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_DETAILS',
    actorId: user?.id ?? null,
    actorName: user?.user_metadata?.name ?? null,
    fieldChanges: [{ field: 'vp_brand', from: before, to: brand }],
    note: 'Brand for the Venture Portal',
  });

  return c.json({ ok: true, docNo, vpBrand: brand });
});
