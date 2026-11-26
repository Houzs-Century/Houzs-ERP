// ----------------------------------------------------------------------------
// /quotes — saved POS quotes (port of 2990 apps/api/src/routes/quotes.ts, #386).
//
// A quote is a saved cart, NOT yet promoted to an order. "Open" = not yet
// promoted and not cancelled (promoted_to_order_id IS NULL AND cancelled_at IS
// NULL).
//
//   GET    /quotes          — list open quotes (company- + row-scoped)
//   POST   /quotes          — save the current cart as a quote
//   PATCH  /quotes/:id      — update an OPEN quote's cart in place
//   PATCH  /quotes/:id/cancel — retire a quote (mig 0278; replaced DELETE)
//
// There is NO delete. Owner rule 不可以删只可以 cancel — see the block at the
// bottom of this file, and docs/hard-delete-inventory.md.
//
// Houzs port notes (mirror sofa-quick-picks.ts + the companyScope helpers):
//   * `supabaseAuth` attaches the scm-scoped service-role client (c.get('supabase'))
//     whose `.from('quotes')` resolves to scm.quotes (db.schema='scm').
//   * created_by = the caller's REAL scm.staff uuid via resolveCallerStaffId
//     (mig-0066 staff.user_id link). NOT `c.get('user').id` — the scm auth
//     bridge pins that to one shared system staff row, so every quote was
//     stamped "system" and the list could not answer WHO quoted this customer.
//     created_by is now LOAD-BEARING: GET / row-scopes on it (owner ruling
//     2026-07-16, aligning with the RLS rule 2990 had and this port dropped).
//     An unresolvable caller still degrades to the pinned row — created_by is
//     NOT NULL, so the alternative is refusing the save — but note the
//     consequence: such a quote is visible only to a view-all caller, never
//     back to its author. It cannot leak the OTHER way (the pinned row belongs
//     to no user's downline: mig 0066 leaves its staff.user_id NULL).
//   * EVERY query is company_2-scoped: scopeToCompany on read/update/delete,
//     stampCompany (via activeCompanyId) on insert. No-op only when the active
//     company is unresolved (pre-migration / cold-start), keeping single-company
//     Houzs working unchanged.
//   * 2990's showroom resolution (staff.showroom_id + elevated-role fallback) is
//     POS-staff-specific and does not translate to the Houzs system-staff bridge;
//     showroom_id is left NULL (the column stays in the wire shape). company_id
//     scoping replaces showroom-based isolation.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { resolveCallerStaffId, resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { normalizePhone } from '../shared/phone';

export const quotes = new Hono<{ Bindings: Env; Variables: Variables }>();

quotes.use('*', supabaseAuth);

const QUOTE_PRICING_VERSION = 'v1';

const QUOTE_COLUMNS =
  'id, created_by, showroom_id, customer_name, customer_phone, customer_email, cart, addons, subtotal, addon_total, total, pricing_version, expires_at, promoted_to_order_id, cancelled_at, cancelled_by, created_at, updated_at';

quotes.get('/', async (c) => {
  const supabase = c.get('supabase');
  const scopeIds = await resolveSalesScopeIds(
    supabase,
    c.env,
    c.get('houzsUser')?.id,
    canViewAllSales(c),
  );
  let q = supabase.from('quotes').select(QUOTE_COLUMNS)
    .is('promoted_to_order_id', null)
    .is('cancelled_at', null);
  if (scopeIds) q = q.in('created_by', scopeIds);
  const { data, error } = await scopeToCompany(q, c)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    return c.json({ error: 'db_fetch_failed', detail: error.message }, 500);
  }
  return c.json({ quotes: data ?? [] });
});

quotes.post('/', async (c) => {
  const supabase = c.get('supabase');
  const userId =
    (await resolveCallerStaffId(supabase, c.get('houzsUser')?.id)) ?? c.get('user').id;

  if (activeCompanyId(c) == null) {
    return c.json({ error: 'company_unresolved' }, 409);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const customerName = String(body?.customerName ?? '').trim();
  const customerPhone = normalizePhone(body?.customerPhone as string | null | undefined);
  const customerEmail = body?.customerEmail ? String(body.customerEmail).trim() : null;
  const cart = body?.cart ?? body?.lines;
  const subtotal = Number(body?.subtotal);
  const total = Number(body?.total);

  if (!customerName) return c.json({ error: 'missing_customer_name' }, 400);
  if (!Array.isArray(cart) || cart.length === 0) {
    return c.json({ error: 'missing_cart' }, 400);
  }
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return c.json({ error: 'invalid_subtotal' }, 400);
  }
  if (!Number.isFinite(total) || total < 0) {
    return c.json({ error: 'invalid_total' }, 400);
  }

  const id = `QU-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      id,
      company_id: activeCompanyId(c),
      created_by: userId,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      cart,
      addons: [],
      subtotal: Math.round(subtotal),
      addon_total: 0,
      total: Math.round(total),
      pricing_version: QUOTE_PRICING_VERSION,
    })
    .select('id, customer_name, total, created_at')
    .maybeSingle();

  if (error) {
    return c.json({ error: 'db_insert_failed', detail: error.message }, 500);
  }
  return c.json({ quote: data }, 201);
});

quotes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const cart = body?.cart ?? body?.lines;
  const subtotal = Number(body?.subtotal);
  const total = Number(body?.total);
  if (!Array.isArray(cart) || cart.length === 0) {
    return c.json({ error: 'missing_cart' }, 400);
  }
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return c.json({ error: 'invalid_subtotal' }, 400);
  }
  if (!Number.isFinite(total) || total < 0) {
    return c.json({ error: 'invalid_total' }, 400);
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(
    supabase
      .from('quotes')
      .update({
        cart,
        subtotal: Math.round(subtotal),
        total: Math.round(total),
      })
      .eq('id', id)
      .is('promoted_to_order_id', null)
      .is('cancelled_at', null),
    co.companyId,
  )
    .select('id, customer_name, total, updated_at')
    .maybeSingle();

  if (error) {
    return c.json({ error: 'db_update_failed', detail: error.message }, 500);
  }
  if (!data) {
    return c.json({ error: 'not_found_or_converted' }, 404);
  }
  return c.json({ quote: data });
});

quotes.patch('/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: cur, error: readErr } = await scopeToCompanyId(
    supabase.from('quotes').select('id, cancelled_at, promoted_to_order_id').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (readErr) return c.json({ error: 'db_read_failed', detail: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);

  const row = cur as { id: string; cancelled_at: string | null; promoted_to_order_id: string | null };
  if (row.promoted_to_order_id) {
    return c.json({
      error: 'already_converted',
      message: 'This quote became an order. Cancel the order, not the quote.',
    }, 409);
  }
  if (row.cancelled_at) return c.json({ quote: { id: row.id, cancelled_at: row.cancelled_at } });

  const cancelledBy =
    (await resolveCallerStaffId(supabase, c.get('houzsUser')?.id)) ?? c.get('user').id;

  const { data, error } = await scopeToCompanyId(
    supabase
      .from('quotes')
      .update({ cancelled_at: new Date().toISOString(), cancelled_by: cancelledBy })
      .eq('id', id)
      .is('promoted_to_order_id', null),
    co.companyId,
  ).select('id, cancelled_at, cancelled_by').maybeSingle();
  if (error) return c.json({ error: 'db_update_failed', detail: error.message }, 500);
  if (!data) return c.json({ error: 'not_found_or_converted' }, 404);
  return c.json({ quote: data });
});

/* ── DELETE /quotes/:id: REMOVED (owner rule, 2026-08-11) ───────────────────
   There was a DELETE /:id here that hard-purged a quote row. It is gone, and it
   must not come back.

   The owner's rule is 不可以删只可以 cancel — nothing is ever deleted, only
   cancelled. Of the three document-level hard deletes found on the SCM route
   surface this was the LEAST guarded: no status check, no audit row, no
   downstream lock. Any quote in the active company, at any point in its life,
   could be erased by id — including one that had already been promoted to a
   sales order, which would have destroyed the only record of what the customer
   was actually quoted before that order existed.

   A quote is pre-sale and never reaches AutoCount, so this is not a
   sync-divergence risk the way the PO and PC Order deletes were. It is a
   commercial-history risk: the priced cart, the customer contact and the
   salesperson attribution are the evidence behind a disputed order.

   PATCH /:id/cancel above is the replacement, and mig 0278 gave the table the
   cancelled_at / cancelled_by columns it needed to have one.

   The full classification of every delete on the SCM route surface is in
   docs/hard-delete-inventory.md. Check it before adding a DELETE handler. */
