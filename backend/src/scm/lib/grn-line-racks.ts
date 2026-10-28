// grn-line-racks — one GRN line's goods split over several racks
// (scm.grn_item_racks), e.g. 6 on L3.1 and 4 on L3.2.
//
//   GET /grns/:id/racks                    every split row of the GRN's lines
//   PUT /grns/:id/items/:itemId/racks      replace one line's split
//
// A split is a PLAN for a DRAFT: the storekeeper scans shelf by shelf, and the
// purchaser's post places the goods (grn-rack-sync reads planGrnPlacements).
// Posting refuses while a split does not account for every accepted unit. Once
// posted, the rack board is where goods move — this path refuses, the same
// boundary the one-rack PATCH (grn-line-rack.ts) keeps for a placed line.
//
// grn_items.rack_id stays meaningful: the single rack when the split uses one
// rack, NULL when it uses several, so a reader that only knows rack_id never
// names one shelf for goods that are on three.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from './companyScope';
import { recordEntityAudit } from './entity-audit';
import { rackSplitError, rackSplitPostError, type RackSplit } from '../shared/rack-split';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export type SplitRow = { grn_item_id: string; rack_id: string; qty: number };
export type PlacementLine = {
  id: string;
  rack_id: string | null;
  item_code: string;
  material_name: string | null;
  qty_accepted: number | null;
};
export type Placement = { rack_id: string; item_code: string; material_name: string | null; qty: number };

function splitsByLine(rows: ReadonlyArray<SplitRow>): Map<string, RackSplit[]> {
  const out = new Map<string, RackSplit[]>();
  for (const r of rows) {
    const list = out.get(r.grn_item_id) ?? [];
    list.push({ rackId: r.rack_id, qty: r.qty });
    out.set(r.grn_item_id, list);
  }
  return out;
}

/** Where a posted GRN's goods go: a line's split rows when it has any, else
 *  its single rack holding everything accepted. */
export function planGrnPlacements(lines: ReadonlyArray<PlacementLine>, rows: ReadonlyArray<SplitRow>): Placement[] {
  const byLine = splitsByLine(rows);
  const out: Placement[] = [];
  for (const l of lines) {
    const accepted = l.qty_accepted ?? 0;
    if (accepted <= 0) continue;
    const splits = byLine.get(l.id) ?? [];
    if (splits.length > 0) {
      for (const s of splits) out.push({ rack_id: s.rackId, item_code: l.item_code, material_name: l.material_name, qty: s.qty });
    } else if (l.rack_id) {
      out.push({ rack_id: l.rack_id, item_code: l.item_code, material_name: l.material_name, qty: accepted });
    }
  }
  return out;
}

/** The first line whose split does not add up, as the operator should read it. */
export function splitPostProblem(lines: ReadonlyArray<PlacementLine>, rows: ReadonlyArray<SplitRow>): string | null {
  const byLine = splitsByLine(rows);
  for (const l of lines) {
    const err = rackSplitPostError(l.qty_accepted ?? 0, byLine.get(l.id) ?? []);
    if (err) return `${l.item_code}: ${err} Fix its racks before posting.`;
  }
  return null;
}

async function readSplitRows(sb: any, itemIds: string[], companyId: number): Promise<{ rows: SplitRow[]; error: unknown }> {
  if (itemIds.length === 0) return { rows: [], error: null };
  const { data, error } = await scopeToCompanyId(sb.from('grn_item_racks')
    .select('grn_item_id, rack_id, qty').in('grn_item_id', itemIds), companyId);
  return { rows: (data ?? []) as SplitRow[], error };
}

/** Pre-post check for PATCH /grns/:id/post. Fails closed: an unreadable split
 *  refuses rather than posting goods onto the wrong shelves. */
export async function grnRackSplitPostRefusal(
  sb: any, grnId: string, companyId: number,
): Promise<{ status: 409 | 503; body: { error: string; message: string } } | null> {
  const { data: lines, error } = await scopeToCompanyId(sb.from('grn_items')
    .select('id, rack_id, item_code, material_name, qty_accepted').eq('grn_id', grnId), companyId);
  if (error) return { status: 503, body: { error: 'rack_split_unreadable', message: 'Could not check the line racks. Try again.' } };
  const list = (lines ?? []) as PlacementLine[];
  const split = await readSplitRows(sb, list.map((l) => l.id), companyId);
  if (split.error) return { status: 503, body: { error: 'rack_split_unreadable', message: 'Could not check the line racks. Try again.' } };
  const problem = splitPostProblem(list, split.rows);
  return problem ? { status: 409, body: { error: 'rack_split_incomplete', message: problem } } : null;
}

export async function getGrnItemRacksHandler(c: Ctx) {
  const grnId = c.req.param('id') as string;
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase') as any;
  const { data: grn, error: grnErr } = await scopeToCompanyId(sb.from('grns').select('id').eq('id', grnId), co.companyId).maybeSingle();
  if (grnErr) return c.json({ error: 'lookup_failed', reason: grnErr.message }, 500);
  if (!grn) return c.json(NOT_THIS_COMPANY, 404);
  const { data: lines, error: lineErr } = await scopeToCompanyId(sb.from('grn_items').select('id').eq('grn_id', grnId), co.companyId);
  if (lineErr) return c.json({ error: 'lookup_failed', reason: lineErr.message }, 500);
  const split = await readSplitRows(sb, (lines ?? []).map((l: { id: string }) => l.id), co.companyId);
  if (split.error) return c.json({ error: 'lookup_failed' }, 500);
  return c.json({ racks: split.rows.map((r) => ({ grnItemId: r.grn_item_id, rackId: r.rack_id, qty: r.qty })) });
}

export async function putGrnItemRacksHandler(c: Ctx) {
  const grnId = c.req.param('id') as string;
  const itemId = c.req.param('itemId') as string;
  let body: { racks?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!Array.isArray(body.racks)) return c.json({ error: 'racks_required', message: 'Send the racks as a list.' }, 400);
  const splits: RackSplit[] = body.racks.map((r: any) => ({ rackId: typeof r?.rackId === 'string' ? r.rackId : '', qty: Number(r?.qty) }));

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase') as any;

  const { data: grn, error: grnErr } = await scopeToCompanyId(sb.from('grns')
    .select('id, grn_number, status, warehouse_id').eq('id', grnId), co.companyId).maybeSingle();
  if (grnErr) return c.json({ error: 'lookup_failed', reason: grnErr.message }, 500);
  if (!grn) return c.json(NOT_THIS_COMPANY, 404);
  if (String(grn.status).toUpperCase() !== 'DRAFT') {
    return c.json({ error: 'grn_not_draft',
      message: 'Racks can be split while the GRN is a draft. Move posted goods on the rack board.' }, 409);
  }
  const { data: line, error: lineErr } = await scopeToCompanyId(sb.from('grn_items')
    .select('id, item_code, qty_accepted').eq('id', itemId).eq('grn_id', grnId), co.companyId).maybeSingle();
  if (lineErr) return c.json({ error: 'lookup_failed', reason: lineErr.message }, 500);
  if (!line) return c.json({ error: 'not_found' }, 404);

  const invalid = rackSplitError(Number(line.qty_accepted ?? 0), splits);
  if (invalid) return c.json({ error: 'invalid_rack_split', message: invalid }, 400);

  const rackIds = splits.map((s) => s.rackId);
  const { data: rackList, error: rackErr } = rackIds.length
    ? await scopeToCompanyId(sb.from('warehouse_racks').select('id, rack, warehouse_id').in('id', rackIds), co.companyId)
    : { data: [], error: null };
  if (rackErr) return c.json({ error: 'lookup_failed', reason: rackErr.message }, 500);
  const racks = new Map<string, { id: string; rack: string; warehouse_id: string }>((rackList ?? []).map((r: any) => [r.id, r]));
  for (const id of rackIds) {
    const rack = racks.get(id);
    if (!rack) return c.json({ error: 'rack_not_found', message: 'That rack does not exist.' }, 404);
    if (grn.warehouse_id && rack.warehouse_id !== grn.warehouse_id) {
      return c.json({ error: 'rack_wrong_warehouse', message: `Rack ${rack.rack} is not in this GRN's receive-into warehouse.` }, 400);
    }
  }

  const { error: delErr } = await scopeToCompanyId(sb.from('grn_item_racks').delete().eq('grn_item_id', itemId), co.companyId);
  if (delErr) return c.json({ error: 'update_failed', reason: delErr.message }, 500);
  if (splits.length > 0) {
    const actor = c.get('houzsUser');
    const { error: insErr } = await sb.from('grn_item_racks').insert(splits.map((s) => ({
      company_id: co.companyId, grn_item_id: itemId, rack_id: s.rackId, qty: s.qty,
      created_by: actor?.id != null ? String(actor.id) : null,
    })));
    if (insErr) return c.json({ error: 'update_failed', reason: insErr.message }, 500);
  }
  const single = splits.length === 1 ? splits[0].rackId : null;
  const { error: upErr } = await scopeToCompanyId(sb.from('grn_items').update({ rack_id: single }).eq('id', itemId), co.companyId);
  if (upErr) return c.json({ error: 'update_failed', reason: upErr.message }, 500);

  const summary = splits.map((s) => `${racks.get(s.rackId)?.rack ?? '?'} x${s.qty}`).join(', ') || 'none';
  await recordEntityAudit(sb, {
    entityType: 'GRN',
    entityId: grnId,
    entityDocNo: grn.grn_number,
    action: 'UPDATE',
    actor: c.get('houzsUser'),
    companyId: co.companyId,
    statusSnapshot: grn.status,
    note: `Line racks set: ${line.item_code} -> ${summary}`,
  });
  return c.json({ ok: true });
}
