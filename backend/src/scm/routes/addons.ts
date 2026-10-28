// /addons — Order Add-ons CRUD (whole-order one-time fees: Dispose, Lift).
//
// Backs the "Order Add-ons" tab on the Products page (OrderAddonsManager in
// SpecialAddonsTab.tsx). An order add-on is a whole-order fee chosen at
// checkout — NOT bound to a Model. The POS books it on the SO via the
// optional `service_sku` (each add-on can mint its own SVC-* catalog line).
//
// Wired 2026-06-20 (SCM stub-wiring sweep). 2990's UI read/wrote the supabase
// `addons` table directly under RLS; the Houzs vendor layer has no client-side
// supabase, so this route exposes the same CRUD over /api/scm/addons and the
// 4 stub hooks in mfg-products-queries.ts now call it.
//
// Auth: plain supabaseAuth — /api/scm/* is owner-gated at the Houzs layer
// (every caller is the seeded system super_admin), same as /mfg-products.
//
// scm.addons shape (introspected): id text PK (a client slug like
// "dispose-wardrobe"), label, description, icon, kind addon_kind enum
// (qty|floors_items|flat), price int, per_floor_item int, unit, default_qty
// int DEFAULT 1, stock, enabled bool, show_at_handover bool, service_sku,
// sort_order int, updated_at. There is NO `category` column — the source UI
// sends one but never reads it back, so we accept + ignore it on write and
// always return category:null. scm.order_items.addon_id FKs this table, so a
// DELETE of an in-use add-on yields 23503 (the UI surfaces "used on orders").
import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const addons = new Hono<{ Bindings: Env; Variables: Variables }>();

addons.use('*', supabaseAuth);

const KIND = z.enum(['qty', 'floors_items', 'flat']);

const createSchema = z.object({
  id:             z.string().min(1).regex(/^[a-z0-9-]+$/, 'id must be lowercase letters, digits, dashes'),
  label:          z.string().min(1),
  description:    z.string().nullable().default(null),
  icon:           z.string().min(1),
  kind:           KIND,
  category:       z.string().nullable().optional(),   // accepted but not stored (no column)
  price:          z.number().int().default(0),
  perFloorItem:   z.number().int().nullable().default(null),
  unit:           z.string().nullable().default(null),
  defaultQty:     z.number().int().default(1),
  stock:          z.number().int().nullable().default(null),
  enabled:        z.boolean().default(true),
  showAtHandover: z.boolean().default(false),
  serviceSku:     z.string().nullable().default(null),
  sortOrder:      z.number().int().default(0),
});

const patchSchema = z.object({
  label:          z.string().min(1).optional(),
  description:    z.string().nullable().optional(),
  icon:           z.string().min(1).optional(),
  kind:           KIND.optional(),
  price:          z.number().int().optional(),
  perFloorItem:   z.number().int().nullable().optional(),
  unit:           z.string().nullable().optional(),
  defaultQty:     z.number().int().optional(),
  stock:          z.number().int().nullable().optional(),
  enabled:        z.boolean().optional(),
  showAtHandover: z.boolean().optional(),
  serviceSku:     z.string().nullable().optional(),
  sortOrder:      z.number().int().optional(),
});

type AddonRow = {
  id: string;
  label: string;
  description: string | null;
  icon: string;
  kind: 'qty' | 'floors_items' | 'flat';
  price: number;
  per_floor_item: number | null;
  unit: string | null;
  default_qty: number;
  stock: number | null;
  enabled: boolean;
  show_at_handover: boolean;
  service_sku: string | null;
  sort_order: number;
  updated_at: string;
};

// API shape mirrors the frontend AdminAddonRow (category has no column → null).
const toApi = (r: AddonRow) => ({
  id:             r.id,
  label:          r.label,
  description:    r.description,
  icon:           r.icon,
  kind:           r.kind,
  category:       null as string | null,
  price:          r.price,
  perFloorItem:   r.per_floor_item,
  unit:           r.unit,
  defaultQty:     r.default_qty,
  stock:          r.stock,
  enabled:        r.enabled,
  showAtHandover: r.show_at_handover,
  serviceSku:     r.service_sku,
  sortOrder:      r.sort_order,
});

const SELECT =
  'id, label, description, icon, kind, price, per_floor_item, unit, default_qty, stock, enabled, show_at_handover, service_sku, sort_order, updated_at';

// GET — list, ordered the way the manager expects (sort_order then label).
addons.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('addons').select(SELECT),
    c,
  )
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ addons: (data as AddonRow[]).map(toApi) });
});

// POST — create. id is a client-supplied slug. 23505 (dup id) → 409.
addons.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }
  const d = parsed.data;
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('addons')
    .insert({
      company_id:       activeCompanyId(c),
      id:               d.id,
      label:            d.label,
      description:      d.description ?? null,
      icon:             d.icon,
      kind:             d.kind,
      price:            d.price,
      per_floor_item:   d.perFloorItem ?? null,
      unit:             d.unit ?? null,
      default_qty:      d.defaultQty,
      stock:            d.stock ?? null,
      enabled:          d.enabled,
      show_at_handover: d.showAtHandover,
      service_sku:      d.serviceSku ?? null,
      sort_order:       d.sortOrder,
    })
    .select(SELECT)
    .single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_id', reason: 'an order add-on with this id already exists' }, 409);
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  return c.json({ addon: toApi(data as AddonRow) }, 201);
});

// PATCH /:id — update.
export const patchAddonHandler = async (c: any) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }
  const p = parsed.data;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.label          !== undefined) patch.label            = p.label;
  if (p.description     !== undefined) patch.description      = p.description;
  if (p.icon           !== undefined) patch.icon             = p.icon;
  if (p.kind           !== undefined) patch.kind             = p.kind;
  if (p.price          !== undefined) patch.price            = p.price;
  if (p.perFloorItem   !== undefined) patch.per_floor_item   = p.perFloorItem;
  if (p.unit           !== undefined) patch.unit             = p.unit;
  if (p.defaultQty     !== undefined) patch.default_qty      = p.defaultQty;
  if (p.stock          !== undefined) patch.stock            = p.stock;
  if (p.enabled        !== undefined) patch.enabled          = p.enabled;
  if (p.showAtHandover !== undefined) patch.show_at_handover = p.showAtHandover;
  if (p.serviceSku     !== undefined) patch.service_sku      = p.serviceSku;
  if (p.sortOrder      !== undefined) patch.sort_order       = p.sortOrder;

  const supabase = c.get('supabase');
  // Multi-company: scope the write to the active company so a blind id from
  // another company matches nothing (reported as not-found, not mutated).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(supabase.from('addons').update(patch).eq('id', id), co.companyId).select(SELECT).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ addon: toApi(data as AddonRow) });
};
addons.patch('/:id', patchAddonHandler);

// DELETE /:id — blocked by the order_items FK when the add-on is in use
// (23503). The UI translates that into a "used on existing orders" message.
addons.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  // Multi-company: scope the delete; select reports whether a row in THIS
  // company was actually removed.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(supabase.from('addons').delete().eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) {
    if (error.code === '23503') return c.json({ error: 'in_use', reason: 'still referenced by existing orders' }, 409);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
