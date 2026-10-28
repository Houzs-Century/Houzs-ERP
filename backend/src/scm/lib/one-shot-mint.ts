import { oneShotSofaCode, oneShotSimpleCode, buildOneShotName, remarkSlug } from '../shared';

export type OneShotMintReq = {
  /** The SO line row object to rewrite (mutated in place: item_code + description). */
  row: Record<string, unknown>;
  category: 'SOFA' | 'BEDFRAME' | 'MATTRESS' | 'ACCESSORY';
  /** base_model (sofa); '' for non-sofa. */
  modelCode: string;
  /** Base SKU code (non-sofa) for oneShotSimpleCode. */
  baseSkuCode: string;
  /** Base SKU display name to derive the one-shot name. */
  baseName: string;
  modelId: string | null;
  branding: string | null;
  /** Normalized base compartment code (sofa); '' otherwise. */
  compartment: string;
  /** Raw remark text (drives slug + the parenthetical name). */
  remarkText: string;
  /** D9 list price (sen). */
  sellPriceSen: number;
};

const codeFor = (req: OneShotMintReq, slug: string, n: number): string =>
  req.category === 'SOFA'
    ? oneShotSofaCode(req.modelCode, req.compartment, slug, n)
    : oneShotSimpleCode(req.baseSkuCode, slug, n);

/**
 * Resolve collision-free codes and build mfg_products rows for the minted
 * one-shot SKUs. MUTATES each req.row (item_code → minted code; description →
 * base + " (remark)") so the SO line points at the new SKU. `takenCodes` is the
 * set of codes already in the DB; in-request collisions are also de-duped.
 * `idGen`/`now` are injected for deterministic tests.
 */
export function buildOneShotMints(
  reqs: OneShotMintReq[],
  takenCodes: Set<string>,
  docNo: string,
  idGen: () => string,
  now: string,
): Array<Record<string, unknown>> {
  const used = new Set(takenCodes);
  const rows: Array<Record<string, unknown>> = [];
  for (const req of reqs) {
    const slug = remarkSlug(req.remarkText);
    let n = 1;
    let code = codeFor(req, slug, n);
    while (used.has(code)) { n += 1; code = codeFor(req, slug, n); }
    used.add(code);
    req.row.item_code = code;
    req.row.description = buildOneShotName(String(req.row.description ?? req.baseName), req.remarkText);
    rows.push({
      id:             idGen(),
      code,
      name:           buildOneShotName(req.baseName, req.remarkText),
      category:       req.category,
      base_model:     req.modelCode || null,
      model_id:       req.modelId,
      branding:       req.branding,
      description:    req.remarkText.trim() || null,
      sell_price_sen: req.sellPriceSen,
      cost_price_sen: null,
      status:         'ACTIVE',
      pos_active:     false,
      one_shot:       true,
      source_doc_no:  docNo,
      created_at:     now,
      updated_at:     now,
    });
  }
  return rows;
}
