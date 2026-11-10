/**
 * SKU Master "Merge codes": many catalogue codes into one kept code, picked one
 * by one. The screen face of backend/scripts/merge-duplicate-skus.mjs - the
 * same planner (duplicate-sku-merge-plan.mjs) and the same writer
 * (duplicate-sku-merge-run.mjs), so the rules and refusals are one copy.
 *
 *   POST /api/scm/mfg-products/merge/plan   { keep, drops }           -> plan, writes nothing
 *   POST /api/scm/mfg-products/merge/apply  { keep, drops, confirm }  -> writes
 *
 * A dropped code's Model that the merge leaves with no ACTIVE code folds into the
 * kept code's Model in the same request (lib/sku-merge-model-fold.ts); /plan
 * shows which, /apply reports each fold or the reason it was not made.
 *
 * `confirm` is the phrase /plan returned. It carries the counts that plan
 * measured, so an apply over a world that changed since is refused.
 *
 * Modular "Merge models": many Product Models into one kept Model, one group at a
 * time, on the planner and writer of backend/scripts/merge-duplicate-models.mjs.
 *
 *   POST /api/scm/mfg-products/merge/models/plan   { keep, drops }           -> plan, writes nothing
 *   POST /api/scm/mfg-products/merge/models/apply  { keep, drops, confirm }  -> writes
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { getSql, resolveDatabaseUrl } from '../../db/pg';
import { requireActiveCompanyId } from '../lib/companyScope';
import { requireHouzsPerm } from '../lib/houzs-perms';
import { PRODUCT_CODE_CASCADE } from '../lib/product-code-rename';
import { enqueueStockAllocationRecompute } from '../lib/stock-allocation-queue';
import { planDuplicateSkuMerge, confirmPhrase } from '../../../scripts/lib/duplicate-sku-merge-plan.mjs';
import { readMergeColumns, readMergeWorld, applyMerge, recordModelMergeAudit, verifyMerge } from '../../../scripts/lib/duplicate-sku-merge-run.mjs';
import { confirmPhrase as modelConfirmPhrase } from '../../../scripts/lib/duplicate-model-merge-plan.mjs';
import { planModelFold, verifyModelGroup, writeModelGroup, type ModelWorld } from '../../../scripts/lib/duplicate-model-merge-run.mjs';
import { previewModelFolds, foldModelsAfterSkuMerge, type FoldIo } from '../lib/sku-merge-model-fold';
import { readFoldInputs } from '../../../scripts/lib/duplicate-model-merge-run.mjs';

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

/** The Model fold's reads and writes on this request's connection; the re-read gets a fresh one. */
function foldIo(sql: ReturnType<typeof getSql>, fresh: () => ReturnType<typeof getSql>, audit: { actorId: number | null; actorEmail: string | null; requestId: string | null }): FoldIo {
  return {
    readFoldInputs: (w) => readFoldInputs(sql, w),
    planModelFold: (w) => planModelFold(sql, w),
    applyFold: async ({ co, plan, world, summary }) => {
      await recordModelMergeAudit(sql, {
        audit, modelId: plan.keptModelId, summary,
        undo: { company_id: co, moves: [], inactiveMoves: plan.inactiveMoves, folded: plan.foldModels, addSizes: [], activateKept: false, fills: [] },
      });
      const modelId = await writeModelGroup(sql, { co, plan, world: world as ModelWorld, log: console.log });
      return verifyModelGroup(fresh(), { co, plan, modelId });
    },
  };
}

function view(world: any, plan: any) {
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
  const acting = plan.pairs.filter((p) => p.refusals.length === 0);
  const retiring = new Set<string>(acting.filter((p) => p.retire).map((p) => p.drop));
  const noAudit = { actorId: null, actorEmail: null, requestId: null };
  const modelFolds = await previewModelFolds(foldIo(sql, () => sql, noAudit), co, acting.map((p) => ({ drop: p.drop, keep: p.keep })), retiring);
  return c.json({ ...view(world, plan), modelFolds });
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
  const audit = { actorId: houzsUser?.id ?? null, actorEmail: houzsUser?.email ?? null, requestId: null };
  const { committed, problems, rekeyed } = await applyMerge(sql, { co, plan, world, cascade: PRODUCT_CODE_CASCADE, audit });
  /* A fresh client: the writes' connection is not the one that re-reads. */
  problems.push(...await verifyMerge(getSql(resolveDatabaseUrl(c.env)), { co, committed, world }));
  /* SO allocation is a projection keyed on the code; re-keyed lines and stock
     need it recomputed (docs/bugs/0675). The cron drains this within minutes. */
  if (committed.length > 0) await enqueueStockAllocationRecompute(c.get('supabase'), 'scm.sku.merge');
  /* The SKU merge above has committed and stands whatever the folds do. */
  const fresh = () => getSql(resolveDatabaseUrl(c.env));
  const { folds: modelFolds, problems: foldProblems } = await foldModelsAfterSkuMerge(foldIo(sql, fresh, audit), co, committed.map((p) => ({ drop: p.drop, keep: p.keep })));
  problems.push(...foldProblems);
  return c.json({
    merged: committed.map((p: any) => p.drop),
    rekeyed,
    modelFolds,
    problems,
  }, problems.length > 0 ? 500 : 200);
});

async function planModels(sql: any, co: number, keep: string, drops: string[]) {
  const { world, plan: planned, refuse } = await planModelFold(sql, { co, keep, drops, retiring: null });
  let plan: any = planned;
  const pairs = plan.pairs.map(({ drop, keep: k }: any) => ({ drop, keep: k }));
  const cols = await readMergeColumns(sql, PRODUCT_CODE_CASCADE);
  const skuWorld = await readMergeWorld(sql, { co, pairs, cascade: PRODUCT_CODE_CASCADE, cols });
  const skuPlan = planDuplicateSkuMerge({ pairs, products: skuWorld.products, refs: skuWorld.refs, stock: skuWorld.stock, stockTakeLines: skuWorld.stockTakeLines });
  const bad = skuPlan.pairs.filter((p: any) => p.refusals.length > 0);
  if (bad.length > 0) plan = refuse(bad.flatMap((p: any) => p.refusals.map((r: string) => `SKU merge "${p.drop}" -> "${p.keep}": ${r}`)));
  const acting = plan.refusals.length === 0;
  const totals = {
    groups: acting ? 1 : 0, pairs: plan.pairs.length, moves: plan.moves.length, inactive: plan.inactiveMoves.length, fills: plan.fills.length,
    folds: plan.foldModels.length, idleModels: 0, idleSkus: 0,
  };
  return { world, plan, skuWorld, skuPlan, totals, confirm: modelConfirmPhrase(totals) };
}

mfgProductMerge.post('/models/plan', async (c) => {
  const parsed = parseMergeBody(jsonOrNull(await c.req.text()));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const scope = requireActiveCompanyId(c);
  if (!scope.ok) return c.json(scope.refusal, 409);
  const { plan, skuPlan, totals, confirm } = await planModels(getSql(resolveDatabaseUrl(c.env)), scope.companyId, parsed.pairs[0].keep, parsed.pairs.map((p) => p.drop));
  const rows = new Map(skuPlan.pairs.map((p: any) => [p.drop, p]));
  return c.json({
    refusals: plan.refusals,
    pairs: plan.pairs.map((p: any) => ({ drop: p.drop, keep: p.keep, size: p.size, lines: ((rows.get(p.drop) as any)?.rekey ?? []).reduce((s: number, r: any) => s + r.rows, 0), units: (rows.get(p.drop) as any)?.unitsMoved ?? 0 })),
    moves: plan.moves.map((m: any) => ({ code: m.code, size: m.size })),
    fills: plan.fills.map((f: any) => ({ code: f.code, field: f.field, from: f.from })),
    addSizes: plan.addSizes,
    foldModels: plan.foldModels.map((f: any) => f.code),
    keptOff: plan.activateKept,
    leftInactive: plan.leftInactive.length,
    inactiveMoved: plan.inactiveMoves.length,
    totals,
    confirm,
  });
});

mfgProductMerge.post('/models/apply', async (c) => {
  const body = jsonOrNull(await c.req.text());
  const parsed = parseMergeBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const scope = requireActiveCompanyId(c);
  if (!scope.ok) return c.json(scope.refusal, 409);
  const co = scope.companyId;
  const sql = getSql(resolveDatabaseUrl(c.env));
  const { world, plan, skuWorld, skuPlan, confirm } = await planModels(sql, co, parsed.pairs[0].keep, parsed.pairs.map((p) => p.drop));
  if ((body as { confirm?: unknown }).confirm !== confirm) {
    return c.json({ error: 'Something changed since you pressed Check. Press Check again and review the new plan.', code: 'plan_changed' }, 409);
  }
  if (plan.refusals.length > 0) return c.json({ error: 'This merge is refused. Fix what the Check lists first.', code: 'refused' }, 409);
  const houzsUser = c.get('houzsUser');
  const audit = { actorId: houzsUser?.id ?? null, actorEmail: houzsUser?.email ?? null, requestId: null };
  const { committed, problems, rekeyed } = await applyMerge(sql, { co, plan: skuPlan, world: skuWorld, cascade: PRODUCT_CODE_CASCADE, audit });
  const due = skuPlan.pairs.filter((p: any) => p.rekey.length > 0 || p.retire).length;
  if (committed.length < due) return c.json({ error: `The Model was not merged: ${problems.join(' ')}`, code: 'sku_merge_failed' }, 500);
  /* The undo of the Model writes, on record before they run. */
  await recordModelMergeAudit(sql, {
    audit, modelId: plan.keptModelId, summary: `Merging Models ${parsed.pairs.map((p) => `"${p.drop}"`).join(', ')} into "${plan.label}"`,
    undo: { company_id: co, moves: plan.moves, inactiveMoves: plan.inactiveMoves, folded: plan.foldModels, addSizes: plan.addSizes, activateKept: plan.activateKept, fills: plan.fills.map((f: any) => ({ code: f.code, field: f.field, from: f.from })) },
  });
  const modelId = await writeModelGroup(sql, { co, plan, world, log: console.log });
  const check = getSql(resolveDatabaseUrl(c.env));
  problems.push(...await verifyMerge(check, { co, committed, world: skuWorld }), ...await verifyModelGroup(check, { co, plan, modelId }));
  if (committed.length > 0) await enqueueStockAllocationRecompute(c.get('supabase'), 'scm.model.merge');
  return c.json({ merged: plan.label, skuMerges: committed.length, moved: plan.moves.length, folded: plan.foldModels.length, rekeyed, problems }, problems.length > 0 ? 500 : 200);
});
