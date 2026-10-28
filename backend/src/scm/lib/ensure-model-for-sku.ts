// ----------------------------------------------------------------------------
// ensureModelForSku — every SKU on scm.mfg_products belongs to a Model.
//
// The Product Models (MODULAR) page reads scm.product_models; a SKU only shows
// there when its model_id points at a row. The New-SKU/Model dialog
// (product-models.ts POST /) always created the model and linked its SKUs, but
// the bare create (mfg-products.ts POST /) and the batch import only set
// `base_model` on the SKU row and left model_id NULL — so every SKU created
// those ways (ACCESSORY / BEDLINES / DINING / DIFFUSER / CARPET / FABRIC_ACCESSORY
// / SERVICE, in practice) never appeared under a Model. Owner 2026-09-18:
// 「这些 Modular 的源代码应该全部相同」— make the SKU-create paths uniform.
//
// This is the ONE find-or-create step those paths share. It is company-scoped
// throughout: the service-role client bypasses RLS, so the company_id predicate
// is the only boundary — on the read AND the write. It fails CLOSED: a read that
// could not run is not "no model", because inserting then would duplicate a
// model that may already exist.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The model_code a SKU links to.
 *
 * A VARIANT product carries a `base_model` (SOFA / BEDFRAME / MATTRESS — the
 * size/fabric SKUs of one model share it), so every one of its SKUs links to
 * ONE model keyed on that base_model. A FLAT product has base_model NULL, so it
 * is its own model: 1 model = 1 SKU keyed on the SKU's own code.
 *
 * Pure, and exported, so the backfill script keys EXISTING SKUs by the exact
 * same rule this helper uses for new ones.
 */
export function modelCodeForSku(baseModel: string | null, code: string): string {
  const bm = (baseModel ?? '').trim();
  return bm ? bm : code;
}

export interface EnsureModelParams {
  /** Active company. REQUIRED — it is the only scope boundary (service role). */
  companyId: number;
  /** The SKU's own code. */
  code: string;
  /** Model name to stamp on a NEWLY-created model (mirrors the create path). */
  name: string;
  /** The SKU's category; the model carries the same category. */
  category: string;
  /** The SKU's base_model, or null for a flat 1:1 product. */
  baseModel: string | null;
}

export type EnsureModelResult =
  | { ok: true; modelId: string; created: boolean }
  | { ok: false; reason: string };

/**
 * Find-or-create the product_models row a SKU belongs to and return its id.
 *
 * FIND on the natural key (company_id, model_code, category); on a hit, LINK to
 * it (return its id, created:false) — never duplicate. On a miss, INSERT a new
 * model mirroring the New-SKU/Model create path's column shape and return the
 * new id. A concurrent create that wins the unique key is recovered by a
 * re-find, so two callers racing on the same (company, code, category) both end
 * up linked to the one model.
 */
export async function ensureModelForSku(
  sb: SupabaseClient,
  params: EnsureModelParams,
): Promise<EnsureModelResult> {
  const { companyId, code, name, category, baseModel } = params;
  const modelCode = modelCodeForSku(baseModel, code);

  const found = await findModel(sb, companyId, modelCode, category);
  if (!found.ok) return { ok: false, reason: found.reason };
  if (found.modelId) return { ok: true, modelId: found.modelId, created: false };

  // id generated here (not left to gen_random_uuid) so the row is identifiable
  // without an insert-returning read — the backfill script's pgrest shim does
  // not hand back inserted rows.
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  // Mirror product-models.ts POST / — company_id, model_code, name, category,
  // active, allowed_options default {}; branding/description/photo_url null.
  const insert = {
    id,
    company_id:      companyId,
    branding:        null,
    model_code:      modelCode,
    name,
    category,
    description:     null,
    photo_url:       null,
    allowed_options: {},
    active:          true,
  };
  const { error: insErr } = await sb.from('product_models').insert(insert);
  if (insErr) {
    // 23505 = a concurrent create already made this model. Re-find and link to
    // it: the model now exists, which is exactly this function's postcondition.
    if ((insErr as { code?: string }).code === '23505') {
      const race = await findModel(sb, companyId, modelCode, category);
      if (!race.ok) return { ok: false, reason: race.reason };
      if (race.modelId) return { ok: true, modelId: race.modelId, created: false };
    }
    return { ok: false, reason: `product_models insert failed: ${insErr.message}` };
  }
  return { ok: true, modelId: id, created: true };
}

/** The model for (company, model_code, category), or null when none — company
 *  scoped, and it FAILS CLOSED so a read error can never read as "no model". */
async function findModel(
  sb: SupabaseClient,
  companyId: number,
  modelCode: string,
  category: string,
): Promise<{ ok: true; modelId: string | null } | { ok: false; reason: string }> {
  const { data, error } = await sb
    .from('product_models')
    .select('id')
    .eq('company_id', companyId)
    .eq('model_code', modelCode)
    .eq('category', category)
    .maybeSingle();
  if (error) return { ok: false, reason: `product_models read failed: ${error.message}` };
  const id = (data as { id?: unknown } | null)?.id;
  return { ok: true, modelId: id != null ? String(id) : null };
}
