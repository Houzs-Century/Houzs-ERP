
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { warehouseLabel } from './warehouse-label';


describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/warehouse-label.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/warehouse-label.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/warehouse-label.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});


describe('warehouseLabel — CODE first, then name', () => {
  test('a warehouse with both prints the CODE', () => {
    expect(warehouseLabel({ code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' }))
      .toBe('KL WAREHOUSE');
  });

  test('the name is the FALLBACK, never the preference', () => {
    expect(warehouseLabel({ code: null, name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
    expect(warehouseLabel({ name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
  });

  test('a blank or whitespace code is not a code', () => {
    expect(warehouseLabel({ code: '', name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
    expect(warehouseLabel({ code: '   ', name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
  });

  test('the answer is trimmed', () => {
    expect(warehouseLabel({ code: '  KL WAREHOUSE  ', name: null })).toBe('KL WAREHOUSE');
  });

  test('nothing to show is null — never an empty-looking string', () => {
    expect(warehouseLabel({ code: null, name: null })).toBeNull();
    expect(warehouseLabel({ code: '', name: '  ' })).toBeNull();
    expect(warehouseLabel({})).toBeNull();
    expect(warehouseLabel(null)).toBeNull();
    expect(warehouseLabel(undefined)).toBeNull();
  });
});


const SRC = resolve(process.cwd(), 'src');
const SELF = 'src/vendor/scm/lib/warehouse-label.ts';

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
      if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(`src/${relative(SRC, full).split(/[\\/]/).join('/')}`);
      }
    }
  };
  walk(SRC);
  return out.sort();
}

const FILES = sourceFiles().map((p) => {
  const raw = readFileSync(resolve(process.cwd(), p), 'utf8');
  return {
    path: p,
    raw,
    text: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
  };
});

describe('a warehouse label is decided in exactly one place', () => {
  const OBJECT_FALLBACK =
    /\?\.(?:code|name)\s*(?:\|\||\?\?)\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+)*\?\.(?:code|name)/;

  const PENDING = ['src/pages/scm-v2/SalesOrderDetail.tsx'];


  test('no file spells its own warehouse code/name fallback on an object', () => {
    const offenders = FILES
      .filter((f) => f.path !== SELF)
      .filter((f) => /[Ww]arehouse|purchase_location|purchaseLocation/.test(f.text))
      .filter((f) => {
        for (const line of f.text.split('\n')) {
          if (!OBJECT_FALLBACK.test(line)) continue;
          if (/[Ww]arehouse|purchase_location|purchaseLocation/.test(line)) return true;
        }
        return false;
      })
      .map((f) => f.path);
    expect(FILES.length).toBeGreaterThan(100);
    expect(offenders).toEqual(PENDING);
  });

  const CALL_SITES = [
    'src/mobile/MobileModuleList.tsx',
    'src/mobile/MobileStockCard.tsx',
    'src/pages/scm-v2/ConsignmentOrderDetail.tsx',
    'src/pages/scm-v2/DeliveryOrderNewV2.tsx',
    'src/pages/scm-v2/Fleet.tsx',
    'src/pages/scm-v2/GrnFromPo.tsx',
    'src/pages/scm-v2/LorryDetail.tsx',
    'src/pages/scm-v2/PurchaseOrdersListV2.tsx',
    'src/pages/scm-v2/StockTakesListV2.tsx',
    'src/pages/scm-v2/StockTransfersListV2.tsx',
    'src/vendor/scm/components/ScheduleTripDrawer.tsx',
    'src/vendor/scm/lib/propose-time.ts',
  ];

  test('every converted surface still reaches the shared rule', () => {
    const callers = new Set(
      FILES.filter((f) => f.path !== SELF && /warehouseLabel\(/.test(f.raw)).map((f) => f.path),
    );
    expect(callers.size).toBeGreaterThanOrEqual(CALL_SITES.length);
    const unwired = CALL_SITES.filter((p) => !callers.has(p));
    expect(unwired).toEqual([]);
  });

  test('every caller imports the rule rather than redeclaring it', () => {
    const unimported = FILES
      .filter((f) => f.path !== SELF && /warehouseLabel\(/.test(f.raw))
      .filter((f) => !/from ['"][^'"]*\/warehouse-label['"]/.test(f.raw))
      .map((f) => f.path);
    expect(unimported).toEqual([]);
  });
});
