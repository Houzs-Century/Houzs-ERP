import { describe, it, expect } from 'vitest';
import { fakeSb, type Row } from './fake-postgrest';
import { ensureModelForSku, modelCodeForSku } from './ensure-model-for-sku';

/* ---------------------------------------------------------------------------
 * Every SKU on mfg_products must belong to a product_models row, or it never
 * shows on the MODULAR page. ensureModelForSku is the one find-or-create step
 * the bare create and the batch import share (owner 2026-09-18: the SKU-create
 * paths should be identical). These tests pin its rule:
 *   - modelCode = base_model when set, else the SKU's own code;
 *   - an existing model is LINKED, never duplicated (idempotent);
 *   - a flat product (base_model null) is its own 1:1 model;
 *   - it is company-scoped on the natural key;
 *   - a read that cannot run FAILS CLOSED — no insert.
 * ------------------------------------------------------------------------- */

describe('modelCodeForSku — the key rule', () => {
  it('a variant (base_model set) keys on the base_model', () => {
    expect(modelCodeForSku('5530', '5530-1A(LHF)')).toBe('5530');
  });
  it('a base_model with surrounding whitespace is trimmed', () => {
    expect(modelCodeForSku('  5530  ', '5530-1A(LHF)')).toBe('5530');
  });
  it('a flat product (base_model null) keys on its own code', () => {
    expect(modelCodeForSku(null, 'ACC-PILLOW-01')).toBe('ACC-PILLOW-01');
  });
  it('an empty/whitespace base_model is treated as flat', () => {
    expect(modelCodeForSku('   ', 'ACC-PILLOW-01')).toBe('ACC-PILLOW-01');
  });
});

describe('ensureModelForSku — find-or-create', () => {
  it('a flat category with base_model null creates a 1:1 model keyed on the code', async () => {
    const tables: Record<string, Row[]> = { product_models: [] };
    const sb = fakeSb(tables);
    const r = await ensureModelForSku(sb as never, {
      companyId: 1, code: 'ACC-PILLOW-01', name: 'DECOR PILLOW', category: 'ACCESSORY', baseModel: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(tables.product_models).toHaveLength(1);
    const row = tables.product_models[0]!;
    expect(row.model_code).toBe('ACC-PILLOW-01');
    expect(row.category).toBe('ACCESSORY');
    expect(row.company_id).toBe(1);
    expect(row.active).toBe(true);
    expect(row.allowed_options).toEqual({});
    expect(row.id).toBe(r.modelId);
  });

  it('an existing model is LINKED, not duplicated (idempotent)', async () => {
    const tables: Record<string, Row[]> = {
      product_models: [{ id: 'model-existing', company_id: 1, model_code: '5530', category: 'SOFA' }],
    };
    const sb = fakeSb(tables);
    const first = await ensureModelForSku(sb as never, {
      companyId: 1, code: '5530-1A(LHF)', name: 'SOFA 5530', category: 'SOFA', baseModel: '5530',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(false);
    expect(first.modelId).toBe('model-existing');
    expect(tables.product_models).toHaveLength(1);

    // A SECOND SKU of the same base_model links to the SAME model — no dup.
    const second = await ensureModelForSku(sb as never, {
      companyId: 1, code: '5530-2S(RHF)', name: 'SOFA 5530', category: 'SOFA', baseModel: '5530',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.modelId).toBe('model-existing');
    expect(tables.product_models).toHaveLength(1);
  });

  it('two SKUs sharing a base_model in one run create exactly ONE model', async () => {
    const tables: Record<string, Row[]> = { product_models: [] };
    const sb = fakeSb(tables);
    const a = await ensureModelForSku(sb as never, {
      companyId: 1, code: '9028-2A(LHF)', name: 'SOFA 9028', category: 'SOFA', baseModel: '9028',
    });
    const b = await ensureModelForSku(sb as never, {
      companyId: 1, code: '9028-L(RHF)', name: 'SOFA 9028', category: 'SOFA', baseModel: '9028',
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.modelId).toBe(b.modelId);
    expect(tables.product_models).toHaveLength(1);
  });

  it('is company-scoped: another company\'s model of the same key is not reused', async () => {
    const tables: Record<string, Row[]> = {
      product_models: [{ id: 'model-co2', company_id: 2, model_code: 'ACC-01', category: 'ACCESSORY' }],
    };
    const sb = fakeSb(tables);
    const r = await ensureModelForSku(sb as never, {
      companyId: 1, code: 'ACC-01', name: 'ACC ONE', category: 'ACCESSORY', baseModel: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.modelId).not.toBe('model-co2');
    expect(tables.product_models).toHaveLength(2);
    const mine = tables.product_models.find((m) => m.id === r.modelId)!;
    expect(mine.model_code).toBe('ACC-01');
  });

  it('a read error FAILS CLOSED — no insert', async () => {
    const tables: Record<string, Row[]> = { product_models: [] };
    // `missing` makes selecting product_models.id fail with 42703, the way a
    // real read error arrives. The helper must abort, not treat it as "no model"
    // and insert a duplicate.
    const sb = fakeSb(tables, { product_models: ['id'] });
    const r = await ensureModelForSku(sb as never, {
      companyId: 1, code: 'ACC-PILLOW-01', name: 'DECOR PILLOW', category: 'ACCESSORY', baseModel: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/read failed/i);
    expect(tables.product_models).toHaveLength(0);
  });
});
