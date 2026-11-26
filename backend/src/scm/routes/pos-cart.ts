// ============================================================================
// ⚠️  EXTERNAL CLIENT — no screen in THIS repo calls this route. That is
//     expected, not evidence it is dead.
//
//     The consumer is the 2990 POS (pos.2990shome.com, repo wenwei4046/2990s),
//     which has built against this API since the 2026-07-21 cutover. Neither
//     repo compiles against the other, so a repo-wide "find usages" here
//     returns nothing while the route is serving live tablet traffic.
//
//     Deleted as dead code on 2026-08-18 (#2422); the POS 404'd in production.
//     Restored 2026-08-19 (#2459). Before removing it again, grep the POS repo.
//     POS call sites: apps/pos/src/lib/cart-sync.ts:14,55
// ============================================================================
// ----------------------------------------------------------------------------
// /pos-cart — the salesperson's live in-progress POS cart (ported from 2990's,
// issue #385). Company-scoped for the Houzs merged backend (company_2 = 2990).
//
// Chairman 2026-05-31 (2990's): the in-progress cart moves from POS localStorage
// to the DB (scm.pos_carts) so it (a) follows the salesperson across devices and
// (b) does NOT bleed to the next person on a shared tablet — it is loaded by the
// logged-in identity, not by device storage. A saved/finalized cart already
// persists as a quote or order; this is only the live working cart.
//
//   GET /pos-cart   — the caller's cart ({ lines, sourceQuoteId } or empty)
//   PUT /pos-cart   — upsert the caller's cart (debounced write-through)
//
// Company scoping (Houzs merge): GET filters via scopeToCompany and PUT stamps
// company_id = activeCompanyId(c) (= 2 for the 2990 POS). See migration
// 0100_pos_cart.sql (adds scm.pos_carts.company_id) and scm/lib/companyScope.ts.
//
// IDENTITY: key by the caller's REAL scm.staff uuid, resolved from the Houzs
// user id via resolveCallerStaffId (lib/salesScope) — the mig-0066 staff.user_id
// sync link. NEVER `c.get('user').id`: inside /api/scm/* the scm auth bridge
// (scm/middleware/auth.ts) pins EVERY caller to one seeded system staff uuid, so
// keying on it collapses all salespeople onto ONE row — they overwrite each
// other's cart, which is the exact bleed this feature exists to prevent.
// An unresolvable caller fails safe (empty cart / clean save error) rather than
// falling back to the shared system row. See MEMORY "SCM staff-UUID bigint trap".
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import type { Env, Variables } from '../env';

export const posCart = new Hono<{ Bindings: Env; Variables: Variables }>();

posCart.use('*', supabaseAuth);

type Row = {
  staff_id: string;
  lines: unknown[];
  source_quote_id: string | null;
  updated_at: string;
};

posCart.get('/', async (c) => {
  const supabase = c.get('supabase');
  const staffId = await resolveCallerStaffId(supabase, c.get('houzsUser')?.id);
  if (!staffId) return c.json({ lines: [], sourceQuoteId: null });

  const { data, error } = await scopeToCompany(
    supabase
      .from('pos_carts')
      .select('staff_id, lines, source_quote_id, updated_at')
      .eq('staff_id', staffId),
    c,
  ).maybeSingle();

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ lines: [], sourceQuoteId: null });
  const r = data as unknown as Row;
  return c.json({ lines: r.lines ?? [], sourceQuoteId: r.source_quote_id, updatedAt: r.updated_at });
});

posCart.put('/', async (c) => {
  let body: { lines?: unknown; sourceQuoteId?: string | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (!Array.isArray(body.lines)) return c.json({ error: 'lines_required' }, 400);

  const supabase = c.get('supabase');
  const staffId = await resolveCallerStaffId(supabase, c.get('houzsUser')?.id);
  if (!staffId) {
    return c.json(
      {
        error: 'staff_unlinked',
        message:
          'Your account is not linked to a sales profile yet, so the cart cannot be saved. Ask IT to link your account.',
      },
      409,
    );
  }

  const companyId = activeCompanyId(c);
  if (companyId == null) {
    return c.json(
      {
        error: 'company_unresolved',
        message:
          'The active company could not be determined just now, so the cart was not saved. It will save again in a moment.',
      },
      409,
    );
  }

  const { error } = await supabase.from('pos_carts').upsert(
    {
      staff_id: staffId,
      lines: body.lines,
      source_quote_id: body.sourceQuoteId ?? null,
      updated_at: new Date().toISOString(),
      company_id: companyId,
    },
    { onConflict: 'staff_id,company_id' },
  );

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  return c.body(null, 204);
});
