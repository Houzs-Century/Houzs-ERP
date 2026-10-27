/**
 * SKU Master "Merge codes": many catalogue codes into one kept code, picked one
 * by one. The screen face of backend/scripts/merge-duplicate-skus.mjs - the
 * same planner (duplicate-sku-merge-plan.mjs) and the same writer
 * (duplicate-sku-merge-run.mjs), so the rules and refusals are one copy.
 *
 *   POST /api/scm/mfg-products/merge/plan   { keep, drops }           -> plan, writes nothing
 *   POST /api/scm/mfg-products/merge/apply  { keep, drops, confirm }  -> writes
 *
 * `confirm` is the phrase /plan returned. It carries the counts that plan
 * measured, so an apply over a world that changed since is refused.
 *
 * AutoCount is NOT merged from here: the ERP keeps no live AutoCount item list
 * to check against (stock_items caches only service-case items). The plan shows
 * which AutoCount item each code sends to, so staff merge those in AutoCount.
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { getSql, resolveDatabaseUrl } from '../../db/pg';
import { requireActiveCompanyId } from '../lib/companyScope';
import { requireHouzsPerm } from '../lib/houzs-perms';
import { PRODUCT_CODE_CASCADE } from '../lib/product-code-rename';
import { enqueueStockAllocationRecompute } from '../lib/stock-allocation-queue';
import { resolveAcItemCode } from '../../services/autocount-item-code';
import { planDuplicateSkuMerge, confirmPhrase } from '../../../scripts/lib/duplicate-sku-merge-plan.mjs';
import { readMergeColumns, readMergeWorld, applyMerge, verifyMerge } from '../../../scripts/lib/duplicate-sku-merge-run.mjs';

export const MERGE_PERMISSION = 'scm.products.merge';
const MAX_DROPS = 20;

export const mfgProductMerge = new Hono<{ Bindings: Env; Variables: Variables }>();
mfgProductMerge.use('*', requireHouzsPerm(MERGE_PERMISSION));

type MergeBody = { keep: string; drops: string[] };

/** A body that is not JSON becomes null, which parseMergeBody refuses with a 400. */
function jsonOrNull(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** The request's pairs, or the reason it cannot be planned. */
export function parseMergeBody(raw: unknown): { ok: true; pairs: Array<{ drop: string; keep: string }> } | { ok: false; error: string } {
  const b = (raw ?? {}) as Partial<MergeBody>;
  const keep = typeof b.keep === 'string' ? b.keep.trim() : '';
  const drops = Array.isArray(b.drops) ? b.drops.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean) : [];
  if (!keep) return { ok: false, error: 'Pick the code to keep.' };
  if (drops.length === 0) return { ok: false, error: 'Add at least one code to merge away.' };
  if (drops.length > MAX_DROPS) return { ok: false, error: `At most ${MAX_DROPS} codes per merge.` };
  if (new Set(drops).size !== drops.length) return { ok: false, error: 'A code is listed twice.' };
  return { ok: true, pairs: drops.map((drop) => ({ drop, keep })) };
}

async function planFor(sql: any, co: number, pairs: Array<{ drop: string; keep: string }>) {
  const cols = await readMergeColumns(sql, PRODUCT_CODE_CASCADE);
  const world = await readMergeWorld(sql, { co, pairs, cascade: PRODUCT_CODE_CASCADE, cols });
  const plan = planDuplicateSkuMerge({
    pairs, products: world.products, refs: world.refs, stock: world.stock, stockTakeLines: world.stockTakeLines,
  });
  return { world, plan };
}

/** What AutoCount calls each code today: the item staff merge by hand in AutoCount. */
async function autoCountItems(sql: any, co: number, codes: string[]) {
  const rows = await sql`
    SELECT item_code, supplier_sku FROM scm.supplier_material_bindings
     WHERE company_id = ${co} AND item_code = ANY(${codes}) AND material_kind::text = 'mfg_product'
       AND supplier_sku IS NOT NULL AND supplier_sku <> ''
     ORDER BY is_main_supplier DESC`;
  const bindings = new Map<string, string>();
  for (const r of rows) if (!bindings.has(String(r.item_code).toUpperCase())) bindings.set(String(r.item_code).toUpperCase(), String(r.supplier_sku));
  return codes.map((code) => {
    const r = resolveAcItemCode(code, { bindings });
    return { code, acItemCode: r.ok ? r.acItemCode : null, detail: r.ok ? null : r.detail };
  });
}

function view(world: any, plan: any, ac: Array<{ code: string; acItemCode: string | null; detail: string | null }>) {
  const stockOf = (code: string) => world.stock.filter((s: any) => s.code === code)
    .map((s: any) => ({ warehouse: s.warehouseCode, qty: s.ledgerQty }));
  return {
    pairs: plan.pairs.map((p: any) => ({
      drop: p.drop, keep: p.keep, refusals: p.refusals,
      rekey: p.rekey.map((r: any) => ({ table: r.table, rows: r.rows })),
      stay: p.stay, unitsMoved: p.unitsMoved, retire: p.retire,
      dropStock: stockOf(p.drop),
    })),
    keepStock: stockOf(plan.pairs[0]?.keep ?? ''),
    totals: plan.totals,
    confirm: confirmPhrase(plan.totals),
    autoCount: ac,
    missingColumns: world.missing,
  };
}

mfgProductMerge.post('/plan', async (c) => {
  const text = await c.req.text();
  const parsed = parseMergeBody(jsonOrNull(text));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const scope = requireActiveCompanyId(c);
  if (!scope.ok) return c.json(scope.refusal, 409);
  const co = scope.companyId;
  const sql = getSql(resolveDatabaseUrl(c.env));
  const { world, plan } = await planFor(sql, co, parsed.pairs);
  const ac = await autoCountItems(sql, co, [parsed.pairs[0].keep, ...parsed.pairs.map((p) => p.drop)]);
  return c.json(view(world, plan, ac));
});

mfgProductMerge.post('/apply', async (c) => {
  const body = jsonOrNull(await c.req.text());
  const parsed = parseMergeBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const scope = requireActiveCompanyId(c);
  if (!scope.ok) return c.json(scope.refusal, 409);
  const co = scope.companyId;
  const sql = getSql(resolveDatabaseUrl(c.env));
  const { world, plan } = await planFor(sql, co, parsed.pairs);
  const phrase = confirmPhrase(plan.totals);
  if ((body as { confirm?: unknown }).confirm !== phrase) {
    return c.json({ error: 'Something changed since you pressed Check. Press Check again and review the new plan.', code: 'plan_changed' }, 409);
  }
  if (plan.totals.refused > 0) {
    return c.json({ error: 'Some codes are refused. Fix them or remove them from the list first.', code: 'refused' }, 409);
  }
  const houzsUser = c.get('houzsUser');
  const { committed, problems, rekeyed } = await applyMerge(sql, {
    co, plan, world, cascade: PRODUCT_CODE_CASCADE,
    audit: { actorId: houzsUser?.id ?? null, actorEmail: houzsUser?.email ?? null, requestId: null },
  });
  /* A fresh client: the writes' connection is not the one that re-reads. */
  problems.push(...await verifyMerge(getSql(resolveDatabaseUrl(c.env)), { co, committed, world }));
  /* SO allocation is a projection keyed on the code; re-keyed lines and stock
     need it recomputed (docs/bugs/0675). The cron drains this within minutes. */
  if (committed.length > 0) await enqueueStockAllocationRecompute(c.get('supabase'), 'scm.sku.merge');
  return c.json({
    merged: committed.map((p: any) => p.drop),
    rekeyed,
    problems,
  }, problems.length > 0 ? 500 : 200);
});
