import { Hono } from 'hono';
import { productSchema } from '../shared/schemas';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const products = new Hono<{ Bindings: Env; Variables: Variables }>();

products.use('*', supabaseAuth);

// GET /products — visible products with category, series, pricing summaries.
// Phase 1 acceptance gate: POS catalog reads from this. RLS ensures only
// authenticated staff see active products.
products.get('/', async (c) => {
  const supabase = c.get('supabase');
  // Multi-company: isolate the catalog to the active company (products.company_id
  // is NOT NULL — mig 0083). scopeToCompany no-ops when the active company is
  // unresolved (pre-migration / cold-start), keeping single-company Houzs intact.
  const { data, error } = await scopeToCompany(
    supabase
      .from('products')
      .select(
        `
        id, sku, name, detail, size_display, img_key, thumb_key,
        pricing_kind, flat_price, recliner_upgrade_price, stock, low_at, visible,
        category:categories ( id, label, icon, tbc ),
        series:series ( id, label, active )
      `,
      )
      .eq('visible', true),
    c,
  )
    .order('updated_at', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ products: data ?? [] });
});

// POST /products — create a new product + per-product pricing rows in one
// atomic transaction (migration 0004 wraps the inserts in a Postgres function).
// Admin-only via the function's RLS-gated INSERTs (`products_admin_write` etc).
// Used by the Backend SkuMaster drawer; will also be used by any future tooling
// that seeds the catalogue.
products.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const parsed = productSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      400,
    );
  }

  const supabase = c.get('supabase');
  // Multi-company: stamp the active company on the product + its pricing children
  // (mig 0104 added the p_company_id param). NULL when unresolved → the function
  // COALESCEs to the HOUZS base (safety net), so single-company Houzs is unchanged.
  const { data, error } = await supabase.rpc('create_product_with_pricing', {
    p: parsed.data,
    p_company_id: activeCompanyId(c) ?? null,
  });

  if (error) {
    // Permission denied → 403; everything else → 500.
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }

  return c.json({ id: data as string }, 201);
});
