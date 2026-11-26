
import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';

export const currencies = new Hono<{ Bindings: Env; Variables: Variables }>();
currencies.use('*', supabaseAuth);

const COLS = 'code, name, symbol, rate_to_myr, is_active, sort_order, updated_at';

const normCode = (raw: unknown): string => String(raw ?? '').trim().toUpperCase();
const isValidCode = (code: string): boolean => /^[A-Z0-9]{2,8}$/.test(code);

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

  const rate = code === 'MYR' ? 1 : normRate(parsed.data.rateToMyr);

  const { data, error } = await sb.from('currencies').insert({
    code,
    name: parsed.data.name.trim(),
    symbol: parsed.data.symbol?.trim() || null,
    rate_to_myr: rate,
    is_active: parsed.data.isActive ?? true,
    sort_order: parsed.data.sortOrder ?? 0,
    updated_at: new Date().toISOString(),
    company_id: activeCompanyId(c),
  }).select(COLS).maybeSingle();

  if (error) {
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
    updates.rate_to_myr = code === 'MYR' ? 1 : normRate(parsed.data.rateToMyr);
  }

  const { data, error } = await sb.from('currencies')
    .update(updates).eq('code', code).select(COLS).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ currency: data });
});
