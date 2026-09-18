/* Moving a model to another category moves every SKU of that model with it, in
   ONE company. PATCH /product-models/:id and Import SKUs both go through here, so
   neither can move a model and leave its SKUs behind, or move a SKU away from its
   model (owner 2026-09-15: 「导入时如果改到有型号的 SKU 的分类，就连型号和它底下所有
   SKU 一起换，保持一致」).

   The PRODUCT moves only: order lines already written keep the item_group they
   were written with. The caller has already checked the category is one
   (shared/category-swap.ts). */
import type { SupabaseClient } from '@supabase/supabase-js';
import { scopeToCompanyId } from './companyScope';
import { pgrestIn } from './pgrest-in-list';
import { mfgCategoryLabel, parseMfgCategory } from '../shared/product-categories';

export type ModelCategoryMove =
  | { ok: true; model: { id: string; model_code: string | null; name: string | null }; skuCodes: string[] }
  | { ok: false; error: 'model_not_found' | 'model_category_update_failed' | 'sku_category_update_failed' | 'target_category_taken'; reason: string };

export async function moveModelCategory(
  supabase: SupabaseClient,
  companyId: number,
  modelId: string,
  category: string,
): Promise<ModelCategoryMove> {
  const { data: models, error: modelErr } = await scopeToCompanyId(supabase
    .from('product_models')
    .update({ category })
    .eq('id', modelId), companyId)
    .select('id, model_code, name');
  if (modelErr) {
    /* A separate model already holds this code in the target category — the
       (company_id, model_code, category) unique index. The move cannot merge
       two models into one, so name the clash in plain words the operator can
       act on instead of letting the raw duplicate-key surface as a 500 "the
       system hit a problem" (owner 2026-09-18: two "SERVICE X SL" models of the
       same code, changing one to SERVICE hit the other). */
    if ((modelErr as { code?: string }).code === '23505') {
      const { data: self } = await scopeToCompanyId(supabase
        .from('product_models')
        .select('model_code')
        .eq('id', modelId), companyId)
        .maybeSingle();
      const code = (self as { model_code?: string } | null)?.model_code ?? '';
      const label = mfgCategoryLabel(category);
      return {
        ok: false,
        error: 'target_category_taken',
        reason: code
          ? `A ${label} product with the code "${code}" already exists in this company. Change or remove it first, then move this one to ${label}.`
          : `A ${label} product with this code already exists in this company. Change or remove it first, then move this one to ${label}.`,
      };
    }
    return { ok: false, error: 'model_category_update_failed', reason: modelErr.message };
  }
  const model = ((models ?? []) as Array<{ id: string; model_code: string | null; name: string | null }>)[0];
  if (!model) return { ok: false, error: 'model_not_found', reason: `Model ${modelId} is not in this company.` };

  const { data: skus, error: skuErr } = await scopeToCompanyId(supabase
    .from('mfg_products')
    .update({ category, updated_at: new Date().toISOString() })
    .eq('model_id', modelId), companyId)
    .select('code');
  if (skuErr) return { ok: false, error: 'sku_category_update_failed', reason: skuErr.message };
  return { ok: true, model, skuCodes: ((skus ?? []) as Array<{ code: string }>).map((s) => s.code) };
}

export type ImportModelMove = {
  modelId: string;
  modelCode: string;
  modelName: string | null;
  from: string;
  to: string;
  skuCount: number;
};

export type ModelMovePlan =
  | { ok: true; moves: Map<string, Omit<ImportModelMove, 'skuCount'>>; conflicts: Map<string, string> }
  | { ok: false; reason: string };

/* Import SKUs, before anything is written: which rows change the category of a
   SKU that belongs to a model (keyed by row code -> the model move), and which
   rows must be refused because the file gives SKUs of ONE model more than one
   category. A row that restates the category a sibling is leaving counts as a
   disagreement too — the file says both, so neither is picked. Existing SKUs in
   this company only; a blank or unreadable category cell takes no part. */
export async function planModelCategoryMoves(
  supabase: SupabaseClient,
  companyId: number,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<ModelMovePlan> {
  const asked: Array<{ code: string; category: string }> = [];
  for (const r of rows) {
    const code = String(r.code ?? '').trim();
    const category = parseMfgCategory(String(r.category ?? '').trim());
    if (code && category) asked.push({ code, category });
  }
  const moves = new Map<string, Omit<ImportModelMove, 'skuCount'>>();
  const conflicts = new Map<string, string>();
  if (asked.length === 0) return { ok: true, moves, conflicts };

  const skuByCode = new Map<string, { model_id: string; category: string | null }>();
  const codes = [...new Set(asked.map((a) => a.code))];
  for (let i = 0; i < codes.length; i += 100) {
    const { data, error } = await scopeToCompanyId(
      pgrestIn(supabase.from('mfg_products').select('code, model_id, category'), 'code', codes.slice(i, i + 100)),
      companyId,
    );
    if (error) return { ok: false, reason: error.message };
    for (const s of (data ?? []) as Array<{ code: string; model_id: string | null; category: string | null }>) {
      if (s.model_id) skuByCode.set(s.code, { model_id: s.model_id, category: s.category });
    }
  }
  if (skuByCode.size === 0) return { ok: true, moves, conflicts };

  const byModel = new Map<string, Array<{ code: string; category: string; current: string }>>();
  for (const a of asked) {
    const sku = skuByCode.get(a.code);
    if (!sku) continue;
    const list = byModel.get(sku.model_id) ?? [];
    list.push({ ...a, current: String(sku.category ?? '').toUpperCase() });
    byModel.set(sku.model_id, list);
  }
  const moving = [...byModel].filter(([, list]) =>
    new Set(list.map((l) => l.category)).size > 1 || list.some((l) => l.category !== l.current));
  if (moving.length === 0) return { ok: true, moves, conflicts };

  const modelIds = moving.map(([id]) => id);
  const { data: models, error: modelErr } = await scopeToCompanyId(
    pgrestIn(supabase.from('product_models').select('id, model_code, name'), 'id', modelIds),
    companyId,
  );
  if (modelErr) return { ok: false, reason: modelErr.message };
  const modelById = new Map(((models ?? []) as Array<{ id: string; model_code: string | null; name: string | null }>)
    .map((m) => [m.id, m]));

  for (const [modelId, list] of moving) {
    const model = modelById.get(modelId);
    const modelCode = model?.model_code ?? modelId;
    const targets = [...new Set(list.map((l) => l.category))];
    if (targets.length > 1) {
      const said = list.map((l) => `${l.code}: ${mfgCategoryLabel(l.category)}`).join(', ');
      for (const l of list) {
        conflicts.set(l.code, `${l.code} belongs to model ${modelCode}, and a model's SKUs share one category — but this file gives that model's SKUs different categories (${said}). Nothing was saved for these rows. Put the same category on every row of model ${modelCode}, or leave the category blank on the rows you are not changing.`);
      }
      continue;
    }
    const to = targets[0]!;
    const from = list.find((l) => l.current !== to)?.current ?? '';
    for (const l of list) {
      moves.set(l.code, { modelId, modelCode, modelName: model?.name ?? null, from, to });
    }
  }
  return { ok: true, moves, conflicts };
}
