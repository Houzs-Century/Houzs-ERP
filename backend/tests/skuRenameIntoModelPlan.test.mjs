/* The planner behind rename-skus-into-model.mjs (DEV-41: AKEMI SOLITUDE MATT
 * SS / K renamed to HAPPI SLEEP and moved onto its Model). Every refusal is a
 * case where acting would have collided with or lost something real. The
 * renames file is pinned here too, against the AutoCount mapping sheet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMappingCsv } from '../scripts/lib/ac-mapping-csv.mjs';
import { AC_ITEM_MASTER_TSV } from '../src/services/autocount-item-master';
import { planSkuRenameIntoModel, confirmPhrase } from '../scripts/lib/sku-rename-into-model-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'scripts', 'data');

const FROM = 'AKEMI SOLITUDE MATT (SS)';
const TO = 'HAPPI SLEEP SOLITUDE MATT (SS)';
const NAME = 'HAPPI SLEEP SOLITUDE MATTRESS (107x190x30CM)';
const OLD_M = { id: 'm-old', model_code: 'SOLITUDE', category: 'MATTRESS', active: true, sizes: ['SS', 'Q', 'K', 'S', 'SK', 'SP'] };
const NEW_M = { id: 'm-new', model_code: 'HAPPI SLEEP SOLITUDE', category: 'MATTRESS', active: true, sizes: ['Q', 'S', 'SK', 'SP', 'SS', 'K'] };
const sku = (code, over = {}) => ({ id: `p-${code}`, code, name: code, status: 'ACTIVE', category: 'MATTRESS', model_id: 'm-old', size_code: 'SS', ...over });
const entry = (over = {}) => ({
  category: 'MATTRESS', fromModel: 'SOLITUDE', toModel: 'HAPPI SLEEP SOLITUDE', retireFromModel: true,
  renames: [{ from: FROM, to: TO, name: NAME }], ...over,
});

const plan = (over = {}) => planSkuRenameIntoModel({
  entry: entry(over.entry),
  models: over.models ?? [OLD_M, NEW_M],
  products: over.products ?? [
    sku(FROM),
    sku('AKEMI SOLITUDE MATT (Q)', { status: 'INACTIVE', size_code: 'Q' }),
    sku('HAPPI SLEEP SOLITUDE MATT (Q)', { model_id: 'm-new', size_code: 'Q' }),
  ],
  refs: over.refs ?? [],
});

describe('DEV-41 renames file', () => {
  const book = JSON.parse(fs.readFileSync(path.join(DATA, 'sku-renames-into-model.json'), 'utf8'));
  const e = book['DEV-41'];

  it('renames SS and K onto the HAPPI SLEEP code and name, keeping each size', () => {
    expect(e.renames.map((r) => r.from)).toEqual(['AKEMI SOLITUDE MATT (SS)', 'AKEMI SOLITUDE MATT (K)']);
    expect(e.renames.map((r) => r.to)).toEqual(['HAPPI SLEEP SOLITUDE MATT (SS)', 'HAPPI SLEEP SOLITUDE MATT (K)']);
    for (const r of e.renames) expect(r.name.startsWith('HAPPI SLEEP SOLITUDE MATTRESS (')).toBe(true);
    expect([e.fromModel, e.toModel]).toEqual(['SOLITUDE', 'HAPPI SLEEP SOLITUDE']);
  });

  it('the AutoCount item maps to the new code, so a pushed or pulled document names the renamed SKU', () => {
    const mapping = readMappingCsv(fs.readFileSync(path.join(DATA, 'autocount-erp-mapping-1561.csv'), 'utf8'));
    const erpCodes = new Set([...mapping.values()].map((m) => m.erp));
    for (const r of e.renames) {
      expect(erpCodes.has(r.to)).toBe(true);
      expect(erpCodes.has(r.from)).toBe(false);
    }
  });

  it('the new name is what the AutoCount book already calls the item', () => {
    const desc = new Map(AC_ITEM_MASTER_TSV.split('\n').map((l) => l.split('\t')).map(([ac, d]) => [ac, d]));
    const acOf = new Map([...readMappingCsv(fs.readFileSync(path.join(DATA, 'autocount-erp-mapping-1561.csv'), 'utf8')).entries()]
      .map(([ac, m]) => [m.erp, ac]));
    for (const r of e.renames) expect(desc.get(acOf.get(r.to))).toBe(r.name);
  });
});

describe('planSkuRenameIntoModel', () => {
  it('re-keys every cascade row, moves the SKU, and retires a Model left with no ACTIVE SKU', () => {
    const r = plan({ refs: [
      { table: 'mfg_sales_order_items', col: 'item_code', code: FROM, rows: 3 },
      { table: 'inventory_movements', col: 'item_code', code: FROM, rows: 2 },
      { table: 'supplier_material_bindings', col: 'item_code', code: FROM, rows: 1 },
    ] });
    const p = r.renames[0];
    expect(p.refusals).toEqual([]);
    expect(p.productId).toBe(`p-${FROM}`);
    expect(p.name).toBe(NAME);
    expect(p.rekey.map((x) => x.table)).toEqual(['mfg_sales_order_items', 'inventory_movements', 'supplier_material_bindings']);
    expect(r.toModelId).toBe('m-new');
    expect(r.retireFromModel).toBe(true);
    expect(r.totals).toEqual({ renames: 1, refused: 0, rowsToRekey: 6, retireModel: 1 });
    expect(confirmPhrase(r.totals)).toBe('RENAME 1 SKUS: REKEY 6 ROWS, RETIRE 1 MODEL');
  });

  it('refuses a new code that is already a SKU, and then keeps the old Model on', () => {
    const r = plan({ products: [sku(FROM), sku(TO, { status: 'INACTIVE', model_id: 'm-new' })] });
    expect(r.renames[0].refusals.join()).toMatch(/already a SKU/);
    expect(r.renames[0].rekey).toEqual([]);
    expect(r.retireFromModel).toBe(false);
  });

  it('refuses when a document already carries the new code, because the undo is by code', () => {
    const r = plan({ refs: [{ table: 'purchase_order_items', col: 'item_code', code: TO, rows: 1 }] });
    expect(r.renames[0].refusals.join()).toMatch(/already carries the new code/);
  });

  it('refuses when the target Model already sells that size: that is a merge', () => {
    const r = plan({ products: [sku(FROM), sku('HAPPI SLEEP SOLITUDE MATT SS2', { model_id: 'm-new', size_code: 'SS' })] });
    expect(r.renames[0].refusals.join()).toMatch(/already has ACTIVE size SS/);
  });

  it('refuses a size the target Model does not allow', () => {
    const r = plan({ models: [OLD_M, { ...NEW_M, sizes: ['Q', 'S'] }] });
    expect(r.renames[0].refusals.join()).toMatch(/not an allowed size/);
  });

  it('refuses a SKU that has moved off the source Model or been switched off since the ruling', () => {
    expect(plan({ products: [sku(FROM, { model_id: 'm-other' })] }).renames[0].refusals.join()).toMatch(/not on Model "SOLITUDE"/);
    expect(plan({ products: [sku(FROM, { status: 'INACTIVE' })] }).renames[0].refusals.join()).toMatch(/INACTIVE, not ACTIVE/);
  });

  it('refuses everything when a Model is missing or ambiguous', () => {
    expect(plan({ models: [OLD_M] }).renames[0].refusals.join()).toMatch(/target Model .* found 0/);
    expect(plan({ models: [OLD_M, NEW_M, { ...NEW_M, id: 'm-dup' }] }).renames[0].refusals.join()).toMatch(/found 2/);
  });

  it('keeps the old Model on while another of its SKUs is still ACTIVE', () => {
    const r = plan({ products: [sku(FROM), sku('AKEMI SOLITUDE MATT (Q)', { size_code: 'Q' })] });
    expect(r.renames[0].refusals).toEqual([]);
    expect(r.retireFromModel).toBe(false);
    expect(r.leftActive).toEqual(['AKEMI SOLITUDE MATT (Q)']);
  });

  it('a re-run after the apply finds no old code and writes nothing', () => {
    const r = plan({ products: [sku(TO, { model_id: 'm-new' })], models: [{ ...OLD_M, active: false }, NEW_M] });
    expect(r.renames[0].refusals.join()).toMatch(/not in the catalogue/);
    expect(r.totals.rowsToRekey).toBe(0);
    expect(r.retireFromModel).toBe(false);
  });
});
