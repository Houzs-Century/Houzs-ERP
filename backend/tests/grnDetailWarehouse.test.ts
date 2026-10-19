// Sim, 2026-10-19: "the GRN also did not capture the warehouse". Every GRN had
// warehouse_id (500 / 500 on production), but GET /grns/:id never returned the
// warehouse_code the detail page and the phone print, so Warehouse read "—".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const src = readFileSync(path.join(__dirname, '../src/scm/routes/grns.ts'), 'utf8');
const detail = src.slice(src.indexOf("grns.get('/:id', async"), src.indexOf("grns.get('/:id/linked'"));

describe('GET /grns/:id carries the warehouse code', () => {
  test('the handler is found', () => {
    expect(detail.length).toBeGreaterThan(200);
  });
  test('reads the receiving warehouse with the header', () => {
    expect(detail).toContain('warehouse:warehouses!warehouse_id(id, code, name)');
  });
  test('returns it as warehouse_code on the grn', () => {
    expect(detail).toMatch(/warehouse_code: header\.warehouse\?\.code \?\? null/);
  });
});
