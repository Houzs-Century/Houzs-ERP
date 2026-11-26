import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  TOTAL_HEIGHT_PARTS,
  computeTotalHeight,
  isTotalHeightCategory,
  isTotalHeightPart,
  parseInches,
  totalHeightPatch,
} from './total-height';


describe('parseInches — the leading signed number, whatever follows it', () => {
  test('an inch-marked value, ASCII or curly, reads the same', () => {
    expect(parseInches('10"')).toBe(10);
    expect(parseInches('10”')).toBe(10);
    expect(parseInches('10“')).toBe(10);
  });

  test('a bare number and a negative both parse', () => {
    expect(parseInches('10')).toBe(10);
    expect(parseInches(10)).toBe(10);
    expect(parseInches('-2')).toBe(-2);
    expect(parseInches('1.5"')).toBe(1.5);
  });

  test('blank, null, undefined and junk are all 0 — a half-filled bedframe still prices', () => {
    expect(parseInches('')).toBe(0);
    expect(parseInches(null)).toBe(0);
    expect(parseInches(undefined)).toBe(0);
    expect(parseInches('NO LEG')).toBe(0);
  });
});

describe('computeTotalHeight — divan + leg + gap', () => {
  test('the three parts add, and the result carries an ASCII inch mark', () => {
    expect(computeTotalHeight('bedframe', { divanHeight: '8"', legHeight: '1"', gap: '12"' })).toBe('21"');
  });

  test('a curly inch mark on the way in still sums — the pools, not this, hold both glyphs', () => {
    expect(computeTotalHeight('bedframe', { divanHeight: '8”', legHeight: '1“', gap: '12"' })).toBe('21"');
  });

  test('a missing part counts as zero rather than voiding the total', () => {
    expect(computeTotalHeight('bedframe', { divanHeight: '10"' })).toBe('10"');
    expect(computeTotalHeight('bedframe', { divanHeight: '10"', legHeight: '', gap: null })).toBe('10"');
  });

  test('a non-bedframe has no total height at all', () => {
    expect(computeTotalHeight('sofa', { divanHeight: '8"', legHeight: '1"', gap: '12"' })).toBe('');
    expect(computeTotalHeight('mattress', { divanHeight: '8"' })).toBe('');
    expect(computeTotalHeight('', { divanHeight: '8"' })).toBe('');
    expect(computeTotalHeight(null, { divanHeight: '8"' })).toBe('');
  });

  test('category matching is case-insensitive so BEDFRAME and bedframe agree', () => {
    expect(computeTotalHeight('BEDFRAME', { divanHeight: '8"' })).toBe('8"');
    expect(computeTotalHeight('  Bedframe ', { divanHeight: '8"' })).toBe('8"');
  });
});


describe('ALL THREE PARTS BLANK IS EMPTY — the answer the sixteen copies disagreed about', () => {
  test("a bedframe with nothing filled in computes '', not 0\"", () => {
    expect(computeTotalHeight('bedframe', {})).toBe('');
    expect(computeTotalHeight('bedframe', { divanHeight: '', legHeight: '', gap: '' })).toBe('');
    expect(computeTotalHeight('bedframe', { divanHeight: '0', legHeight: '0', gap: '0' })).toBe('');
  });

  test("CLEARING the parts computes '' — the value a caller must write back", () => {
    const cleared = computeTotalHeight('bedframe', { divanHeight: '', legHeight: '', gap: '', totalHeight: '21"' });
    expect(cleared).toBe('');
  });

  test('parts that are set but sum to zero are a REAL total, not an empty one', () => {
    expect(computeTotalHeight('bedframe', { divanHeight: '5"', legHeight: '-5"', gap: '0' })).toBe('0"');
    expect(computeTotalHeight('bedframe', { divanHeight: '-1"' })).toBe('-1"');
  });
});

describe('totalHeightPatch — the write decision, which is where the bug lived', () => {
  test('CLEARING the parts yields a patch that writes the empty value', () => {
    expect(totalHeightPatch('bedframe', {
      divanHeight: '', legHeight: '', gap: '', totalHeight: '21"',
    })).toEqual({ totalHeight: '' });
  });

  test('an EMPTY result is still a patch — emptiness must never read as "no answer"', () => {
    expect(totalHeightPatch('bedframe', { totalHeight: '8"' })).toEqual({ totalHeight: '' });
  });

  test('null only when the stored value already equals the computed one', () => {
    expect(totalHeightPatch('bedframe', { divanHeight: '8"', legHeight: '1"', gap: '12"', totalHeight: '21"' })).toBeNull();
    expect(totalHeightPatch('bedframe', {})).toBeNull();
    expect(totalHeightPatch('bedframe', { divanHeight: '', legHeight: '', gap: '' })).toBeNull();
  });

  test('a stale height is corrected, not preserved', () => {
    expect(totalHeightPatch('bedframe', { divanHeight: '8"', legHeight: '1"', gap: '12"', totalHeight: '99"' }))
      .toEqual({ totalHeight: '21"' });
  });

  test('a non-bedframe never grows the key', () => {
    expect(totalHeightPatch('sofa', { divanHeight: '8"', legHeight: '1"', gap: '12"' })).toBeNull();
    expect(totalHeightPatch('', { divanHeight: '8"' })).toBeNull();
  });
});

describe('the three parts, named once', () => {
  test('exactly divan, leg and gap trigger a recompute', () => {
    expect([...TOTAL_HEIGHT_PARTS]).toEqual(['divanHeight', 'legHeight', 'gap']);
    for (const k of TOTAL_HEIGHT_PARTS) expect(isTotalHeightPart(k)).toBe(true);
  });

  test('an unrelated variant key does not', () => {
    for (const k of ['fabricCode', 'colourId', 'seatHeight', 'specials', 'totalHeight', 'remark']) {
      expect(isTotalHeightPart(k)).toBe(false);
    }
  });

  test('isTotalHeightCategory is bedframe and nothing else', () => {
    expect(isTotalHeightCategory('bedframe')).toBe(true);
    expect(isTotalHeightCategory('BEDFRAME')).toBe(true);
    for (const c of ['sofa', 'mattress', 'accessory', 'service', 'others', '', null, undefined]) {
      expect(isTotalHeightCategory(c)).toBe(false);
    }
  });
});


describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/total-height.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/total-height.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/total-height.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});


const SRC = resolve(process.cwd(), 'src');
const SELF = 'src/vendor/shared/total-height.ts';

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

const FILES = sourceFiles().map((p) => ({ path: p, text: readFileSync(resolve(process.cwd(), p), 'utf8') }));

describe('Total Height is decided in exactly one place', () => {
  test('no file outside this module defines its own parseInches', () => {
    const offenders = FILES
      .filter((f) => f.path !== SELF && /\bconst parseInches\b|\bfunction parseInches\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('no file re-derives divan + leg + gap inline', () => {
    const offenders = FILES
      .filter((f) => f.path !== SELF)
      .filter((f) => /d === 0 && lg === 0 && g === 0|d === 0 && l === 0 && g === 0/.test(f.text)
        || /parseInches\([^)]*\)\s*\+\s*parseInches/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  const CALL_SITES = [
    'src/mobile/MobileNewSO.tsx',
    'src/pages/scm-v2/GoodsReceivedDetail.tsx',
    'src/pages/scm-v2/GrnNew.tsx',
    'src/pages/scm-v2/PurchaseConsignmentOrderDetail.tsx',
    'src/pages/scm-v2/PurchaseConsignmentOrderNew.tsx',
    'src/pages/scm-v2/PurchaseConsignmentReceiveDetail.tsx',
    'src/pages/scm-v2/PurchaseConsignmentReceiveNew.tsx',
    'src/pages/scm-v2/PurchaseConsignmentReturnDetail.tsx',
    'src/pages/scm-v2/PurchaseConsignmentReturnNew.tsx',
    'src/pages/scm-v2/PurchaseInvoiceDetail.tsx',
    'src/pages/scm-v2/PurchaseInvoiceNew.tsx',
    'src/pages/scm-v2/PurchaseOrderDetail.tsx',
    'src/pages/scm-v2/PurchaseOrderNew.tsx',
    'src/pages/scm-v2/PurchaseReturnNew.tsx',
    'src/pages/scm-v2/StockAdjustmentNew.tsx',
    'src/vendor/scm/components/SoLineCard.tsx',
  ];

  test('all sixteen writers still call computeTotalHeight', () => {
    const callers = new Set(
      FILES.filter((f) => f.path !== SELF && /computeTotalHeight\(/.test(f.text)).map((f) => f.path),
    );
    expect(callers.size).toBeGreaterThanOrEqual(CALL_SITES.length);
    const unwired = CALL_SITES.filter((p) => !callers.has(p));
    expect(unwired).toEqual([]);
  });

  test('every caller imports the rule rather than redeclaring it', () => {
    const unimported = FILES
      .filter((f) => f.path !== SELF && /computeTotalHeight\(/.test(f.text))
      .filter((f) => !/from ['"][^'"]*\/total-height['"]/.test(f.text))
      .map((f) => f.path);
    expect(unimported).toEqual([]);
  });
});
