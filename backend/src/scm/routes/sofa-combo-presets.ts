// ----------------------------------------------------------------------------
// /sofa-combo-presets — the presets of Products > Combo Pricing > New combo
// (mig 20261112T1400; owner 2026-11-12: the list was hard-coded in the frontend,
// make it maintainable).
//
// A preset is a name and its slots (string[][], the sofa_combo_pricing.modules
// shape that fitSlots reads). A code with no side, e.g. "2A", stands for either
// side on the model the combo is added to.
//
//   GET    /          the company's presets, active and switched off, in order
//   POST   /          add a preset (goes to the end of the list)
//   PATCH  /:id       rename it, change its slots, switch it on or off
//   POST   /reorder   set the order: { ids } lists every preset of the company
//
// Nothing is deleted: a preset is switched off (active = false).
// Writes need the permission that edits combo pricing (canWriteScmConfig, as in
// sofa-combos.ts). Mounted behind scmAreaGuard('scm.procurement.products').
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { scopeToCompanyId, requireActiveCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';

export const sofaComboPresets = new Hono<{ Bindings: Env; Variables: Variables }>();
sofaComboPresets.use('*', supabaseAuth);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/* The table is not in the generated Supabase types until the migration merges;
   like pg() in delivery-places.ts, a narrow table-local bridge. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg = (sb: unknown): any => sb;

type Row = Record<string, unknown>;
const COLS = 'id, name, slots, sort_order, active';

export type ComboPreset = { id: string; name: string; slots: string[][]; sortOrder: number; active: boolean };

const presetOut = (r: Row): ComboPreset => ({
  id: String(r.id),
  name: String(r.name ?? ''),
  slots: Array.isArray(r.slots) ? (r.slots as unknown[]).map((s) => (Array.isArray(s) ? s.map(String) : [])) : [],
  sortOrder: Number(r.sort_order ?? 0),
  active: r.active !== false,
});

const inOrder = (a: ComboPreset, b: ComboPreset) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** Slots as stored: codes trimmed, blanks and repeats dropped, empty slots dropped. */
export function cleanSlots(raw: readonly (readonly string[])[]): string[][] {
  return raw
    .map((slot) => [...new Set(slot.map((code) => code.trim()).filter((code) => code !== ''))])
    .filter((slot) => slot.length > 0);
}

const nameField = z.string().trim().min(1).max(60);
const slotsField = z.array(z.array(z.string().max(40)).max(40)).min(1).max(12);
const postSchema = z.object({ name: nameField, slots: slotsField, active: z.boolean().optional() });
const patchSchema = z.object({ name: nameField.optional(), slots: slotsField.optional(), active: z.boolean().optional() });
const reorderSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

const forbidden = (c: AppContext) => c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);

async function readJson(c: AppContext): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try { return { ok: true, body: await c.req.json() }; } catch { return { ok: false }; }
}

async function companyPresets(c: AppContext, companyId: number) {
  const { data, error } = await scopeToCompanyId(pg(c.get('supabase')).from('sofa_combo_presets').select(COLS), companyId)
    .order('sort_order', { ascending: true });
  if (error) return { ok: false as const, reason: String(error.message) };
  return { ok: true as const, presets: ((data ?? []) as Row[]).map(presetOut).sort(inOrder) };
}

const nameTaken = (presets: readonly ComboPreset[], name: string, exceptId: string | null) =>
  presets.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());

// ── GET / — the company's presets, in order. ─────────────────────────────────
sofaComboPresets.get('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const list = await companyPresets(c, co.companyId);
  if (!list.ok) return c.json({ error: 'fetch_failed', reason: list.reason }, 500);
  return c.json({ presets: list.presets });
});

// ── POST / — add a preset at the end. ────────────────────────────────────────
sofaComboPresets.post('/', async (c) => {
  if (!canWriteScmConfig(c)) return forbidden(c);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
  const parsed = postSchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const slots = cleanSlots(parsed.data.slots);
  if (slots.length === 0) return c.json({ error: 'no_slots', reason: 'Pick at least one module.' }, 400);
  const list = await companyPresets(c, co.companyId);
  if (!list.ok) return c.json({ error: 'fetch_failed', reason: list.reason }, 500);
  if (nameTaken(list.presets, parsed.data.name, null)) {
    return c.json({ error: 'name_taken', reason: `A preset named ${parsed.data.name} already exists.` }, 409);
  }
  const sortOrder = list.presets.reduce((max, p) => Math.max(max, p.sortOrder + 1), 0);
  const { data, error } = await pg(c.get('supabase')).from('sofa_combo_presets')
    .insert({ company_id: co.companyId, name: parsed.data.name, slots, sort_order: sortOrder, active: parsed.data.active ?? true })
    .select(COLS).single();
  if (error) return c.json({ error: 'save_failed', reason: String(error.message) }, 500);
  return c.json({ preset: presetOut(data as Row) }, 201);
});

// ── PATCH /:id — rename, change slots, switch on or off. ─────────────────────
sofaComboPresets.patch('/:id', async (c) => {
  if (!canWriteScmConfig(c)) return forbidden(c);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = c.req.param('id');
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
  const parsed = patchSchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const list = await companyPresets(c, co.companyId);
  if (!list.ok) return c.json({ error: 'fetch_failed', reason: list.reason }, 500);
  if (!list.presets.some((p) => p.id === id)) return c.json(NOT_THIS_COMPANY, 404);
  const patch: Row = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) {
    if (nameTaken(list.presets, parsed.data.name, id)) {
      return c.json({ error: 'name_taken', reason: `A preset named ${parsed.data.name} already exists.` }, 409);
    }
    patch.name = parsed.data.name;
  }
  if (parsed.data.slots !== undefined) {
    const slots = cleanSlots(parsed.data.slots);
    if (slots.length === 0) return c.json({ error: 'no_slots', reason: 'Pick at least one module.' }, 400);
    patch.slots = slots;
  }
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  const { data, error } = await scopeToCompanyId(
    pg(c.get('supabase')).from('sofa_combo_presets').update(patch).eq('id', id), co.companyId,
  ).select(COLS).maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: String(error.message) }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ preset: presetOut(data as Row) });
});

// ── POST /reorder — set the order of every preset of the company. ────────────
sofaComboPresets.post('/reorder', async (c) => {
  if (!canWriteScmConfig(c)) return forbidden(c);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
  const parsed = reorderSchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const list = await companyPresets(c, co.companyId);
  if (!list.ok) return c.json({ error: 'fetch_failed', reason: list.reason }, 500);
  const ids = parsed.data.ids;
  const own = new Set(list.presets.map((p) => p.id));
  if (new Set(ids).size !== ids.length || ids.length !== own.size || ids.some((id) => !own.has(id))) {
    return c.json({ error: 'order_mismatch', reason: 'The list changed since you opened it. Close and open Presets again.' }, 409);
  }
  const now = new Date().toISOString();
  const sb = pg(c.get('supabase'));
  for (const [i, id] of ids.entries()) {
    if (list.presets.find((p) => p.id === id)?.sortOrder === i) continue;
    const { error } = await scopeToCompanyId(sb.from('sofa_combo_presets').update({ sort_order: i, updated_at: now }).eq('id', id), co.companyId);
    if (error) return c.json({ error: 'save_failed', reason: String(error.message) }, 500);
  }
  const after = await companyPresets(c, co.companyId);
  if (!after.ok) return c.json({ error: 'fetch_failed', reason: after.reason }, 500);
  return c.json({ presets: after.presets });
});
