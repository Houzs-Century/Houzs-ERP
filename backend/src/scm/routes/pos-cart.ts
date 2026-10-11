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

// ── GET / ──────────────────────────────────────────────────────────────
// The caller's single cart row (empty cart if none yet).
posCart.get('/', async (c) => {
  const supabase = c.get('supabase');
  const staffId = await resolveCallerStaffId(supabase, c.get('houzsUser')?.id);
  // No staff link → the caller HAS no cart. Answer empty (never the shared
  // system row) instead of erroring: a read must not break POS load, and an
  // empty cart is the truthful answer. The PUT below reports the problem in
  // plain language the moment they try to save.
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

// ── PUT / ──────────────────────────────────────────────────────────────
// Upsert the caller's single cart row. body: { lines: CartLine[], sourceQuoteId?: string|null }.
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
  // Fail SAFE. Writing to the shared system staff row would hand this caller's
  // cart to every other salesperson (and overwrite theirs) — worse than not
  // saving. Tell them plainly instead.
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

  /* The cart is keyed (staff_id, company_id) since mig 0284, so the company is
     now part of the row's identity and cannot be absent. Refuse plainly rather
     than write a company-less row — the same fail-safe shape as the unlinked
     staff refusal above, and for the same reason: until 0284 the key was
     staff_id ALONE, so saving here upserted onto the salesperson's row for the
     OTHER company and destroyed that cart with no error. A save that fails for
     a moment and says why is strictly better; the client retries on its next
     debounce. */
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
      // company_2 = 2990 in the POS context.
      company_id: companyId,
    },
    { onConflict: 'staff_id,company_id' },
  );

  if (error) {
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
    return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  return c.body(null, 204);
});
