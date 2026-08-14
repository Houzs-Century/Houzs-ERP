// ----------------------------------------------------------------------------
// /currencies — the owner-maintained currency MASTER (migration 0082).
// Ported from 2990 apps/api/src/routes/currencies.ts (migration 0193).
//
// The source of truth for the currency list + each currency's current rate to
// MYR. The frontend currency dropdowns read the ACTIVE rows (so adding a
// currency is fully UI — no code change); GRN / PI / PV auto-fill exchange_rate
// from rate_to_myr when a foreign currency is picked (fx.masterRateForCurrency).
//
// Endpoints:
//   GET   /currencies             — all rows (sort_order, then code)
//   GET   /currencies?active=true — only is_active rows
//   POST  /currencies             — create { code, name, symbol?, rateToMyr?, sortOrder? }
//   PATCH /currencies/:code       — { name?, symbol?, rateToMyr?, isActive?, sortOrder? }
//
// Reads are open to any authed SCM caller (the dropdowns need them); writes are
// gated by the flat Houzs permission `scm.currency.manage` (2990's scm.staff.role
// gates are dead — the SCM bridge pins every caller to one super_admin row).
// company_id is stamped on insert (no-op pre-activation); the `code` PK is global,
// so reads are NOT company-scoped (MYR must stay visible to every company).
//
// DELIBERATELY CROSS-COMPANY ON WRITE TOO. PATCH /:code carries no company
// predicate on purpose: `code` is the primary key, so there is exactly ONE row
// per currency for the whole system, and MULTICOMPANY-MODULE-MAP.md classes the
// currency master as SHARED. Scoping the update would make the single MYR row
// editable by whichever company happened to insert it and invisible to the
// other, which is the opposite of a shared master. The gate here is the
// `scm.currency.manage` permission, not company_id — one rate table, one set of
// people allowed to move it.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';

export const currencies = new Hono<{ Bindings: Env; Variables: Variables }>();
currencies.use('*', supabaseAuth);

const COLS = 'code, name, symbol, rate_to_myr, is_active, sort_order, updated_at';

/* A currency code: 2–8 chars, letters/digits only, upper-cased. MYR/RMB/USD/SGD
   today; the owner can add e.g. EUR / GBP / IDR. We DON'T hardcode the list —
   that's the whole point of the master. */
const normCode = (raw: unknown): string => String(raw ?? '').trim().toUpperCase();
const isValidCode = (code: string): boolean => /^[A-Z0-9]{2,8}$/.test(code);

/* rate_to_myr must be a finite number > 0 (a rate of 0 would zero out the money
   path). Anything malformed degrades to 1 — the safe base-currency rate. */
const normRate = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const createSchema = z.object({
  code:       z.string(),
  name:       z.string().min(1),
  symbol:     z.string().optional().nullable(),
  rateToMyr:  z.union([z.number(), z.string()]).optional(),
  sortOrder:  z.number().int().optional(),
  isActive:   z.boolean().optional(),
});

const patchSchema = z.object({
  name:       z.string().min(1).optional(),
  symbol:     z.string().optional().nullable(),
  rateToMyr:  z.union([z.number(), z.string()]).optional(),
  isActive:   z.boolean().optional(),
  sortOrder:  z.number().int().optional(),
});

currencies.get('/', async (c) => {
  const sb = c.get('supabase');
  const activeOnly = c.req.query('active') === 'true';
  let q = sb.from('currencies').select(COLS).order('sort_order').order('code');
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ currencies: data ?? [] });
});

currencies.post('/', async (c) => {
  if (!hasHouzsPerm(c, 'scm.currency.manage')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const sb = c.get('supabase');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const code = normCode(parsed.data.code);
  if (!isValidCode(code)) return c.json({ error: 'invalid_code' }, 400);

  // MYR is the base currency — always rate 1 regardless of what's sent.
  const rate = code === 'MYR' ? 1 : normRate(parsed.data.rateToMyr);

  const { data, error } = await sb.from('currencies').insert({
    code,
    name: parsed.data.name.trim(),
    symbol: parsed.data.symbol?.trim() || null,
    rate_to_myr: rate,
    is_active: parsed.data.isActive ?? true,
    sort_order: parsed.data.sortOrder ?? 0,
    updated_at: new Date().toISOString(),
    company_id: activeCompanyId(c), // multi-company: stamp (no-op pre-activation)
  }).select(COLS).maybeSingle();

  if (error) {
    // 23505 = unique_violation on the PK (code already exists).
    if (error.code === '23505' || /duplicate key/i.test(error.message)) {
      return c.json({ error: 'duplicate_code' }, 409);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ currency: data }, 201);
});

currencies.patch('/:code', async (c) => {
  if (!hasHouzsPerm(c, 'scm.currency.manage')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const sb = c.get('supabase');
  const code = normCode(c.req.param('code'));

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim();
  if (parsed.data.symbol !== undefined) updates.symbol = parsed.data.symbol?.trim() || null;
  if (parsed.data.isActive !== undefined) updates.is_active = parsed.data.isActive;
  if (parsed.data.sortOrder !== undefined) updates.sort_order = parsed.data.sortOrder;
  if (parsed.data.rateToMyr !== undefined) {
    // MYR is the base currency — never let its rate drift from 1.
    updates.rate_to_myr = code === 'MYR' ? 1 : normRate(parsed.data.rateToMyr);
  }

  const { data, error } = await sb.from('currencies')
    .update(updates).eq('code', code).select(COLS).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ currency: data });
});
