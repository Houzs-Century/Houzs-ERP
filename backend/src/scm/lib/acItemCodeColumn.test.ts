import { describe, expect, test } from 'vitest';
import outboxSrc from './autocount-outbox.ts?raw';
import migrationSrc from '../../db/migrations-pg/0326_supplier_binding_ac_item_code.sql?raw';

describe('the write-back reads ac_item_code, not supplier_sku', () => {
  const outbox = outboxSrc as string;

  test('the binding read asks for ac_item_code', () => {
    const line = outbox.split('\n').find((l) => l.includes("select: 'item_code, supplier_id"));
    expect(line, 'the bindingsFor select was not found').toBeTruthy();
    expect(line).toContain('ac_item_code');
  });

  test('ac_item_code wins and supplier_sku is only the fallback', () => {
    const body = outbox.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(body).toMatch(/const acCode\s*=[\s\S]{0,200}?const sku\s*=\s*acCode\s*\|\|/);
  });

  test('the fallback is still there, and that is deliberate', () => {
    const body = outbox.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(body).toContain('r.supplier_sku');
  });
});

describe('migration 0326 adds the column without changing any document', () => {
  const sql = migrationSrc as string;

  test('it only ADDs a nullable column', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ac_item_code text/);
    expect(sql).not.toMatch(/ac_item_code[^;]*NOT NULL/i);
    expect(sql).not.toMatch(/ac_item_code[^;]*DEFAULT/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });

  test('both columns carry a COMMENT saying which reader owns them', () => {
    expect(sql).toContain('COMMENT ON COLUMN scm.supplier_material_bindings.ac_item_code');
    expect(sql).toContain('COMMENT ON COLUMN scm.supplier_material_bindings.supplier_sku');
  });
});
