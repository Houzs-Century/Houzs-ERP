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

/* ── the arithmetic ─────────────────────────────────────────────────────── */

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
    // Every current caller passes lowercase; the backend's own vocabulary is
    // upper. Both must be the same answer or the rule has two homes again.
    expect(computeTotalHeight('BEDFRAME', { divanHeight: '8"' })).toBe('8"');
    expect(computeTotalHeight('  Bedframe ', { divanHeight: '8"' })).toBe('8"');
  });
});

/* ── the half that had drifted ──────────────────────────────────────────── */

describe('ALL THREE PARTS BLANK IS EMPTY — the answer the sixteen copies disagreed about', () => {
  test("a bedframe with nothing filled in computes '', not 0\"", () => {
    expect(computeTotalHeight('bedframe', {})).toBe('');
    expect(computeTotalHeight('bedframe', { divanHeight: '', legHeight: '', gap: '' })).toBe('');
    expect(computeTotalHeight('bedframe', { divanHeight: '0', legHeight: '0', gap: '0' })).toBe('');
  });

  test("CLEARING the parts computes '' — the value a caller must write back", () => {
    // The live bug this unification fixes: SoLineCard computed exactly this ''
    // and then refused to write it (`if (!computedTotalHeight) return;`), so an
    // SO line that already carried a Total Height kept the OLD number after its
    // divan/leg/gap were blanked, and that stale number was saved, priced, and
    // gated. MobileNewSO's `if (th > 0)` did the same. The fourteen purchasing
    // screens always assigned. Assigning is now the only behaviour.
    const cleared = computeTotalHeight('bedframe', { divanHeight: '', legHeight: '', gap: '', totalHeight: '21"' });
    expect(cleared).toBe('');
  });

  test('parts that are set but sum to zero are a REAL total, not an empty one', () => {
    // Group A said 0" here; MobileNewSO's `th > 0` said "write nothing". Group A
    // wins: the parts are filled in, so the line has a total and it is zero.
    expect(computeTotalHeight('bedframe', { divanHeight: '5"', legHeight: '-5"', gap: '0' })).toBe('0"');
    expect(computeTotalHeight('bedframe', { divanHeight: '-1"' })).toBe('-1"');
  });
});

describe('totalHeightPatch — the write decision, which is where the bug lived', () => {
  test('CLEARING the parts yields a patch that writes the empty value', () => {
    // The whole fix in one assertion. SoLineCard computed '' correctly and then
    // dropped it on `if (!computedTotalHeight) return;`, leaving the stale 21"
    // in the draft to be saved, priced and gated.
    expect(totalHeightPatch('bedframe', {
      divanHeight: '', legHeight: '', gap: '', totalHeight: '21"',
    })).toEqual({ totalHeight: '' });
  });

  test('an EMPTY result is still a patch — emptiness must never read as "no answer"', () => {
    expect(totalHeightPatch('bedframe', { totalHeight: '8"' })).toEqual({ totalHeight: '' });
  });

  test('null only when the stored value already equals the computed one', () => {
    expect(totalHeightPatch('bedframe', { divanHeight: '8"', legHeight: '1"', gap: '12"', totalHeight: '21"' })).toBeNull();
    // A line whose parts were blank all along: absent totalHeight, computed ''.
    // No patch, so no write and no render loop.
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

/* ── the two copies of the module ───────────────────────────────────────── */

// The frontend cannot import from backend/src, so this rule is mirrored rather
// than shared — which is the same shape that produced sixteen copies in the
// first place. The mirror is only safe while something compares the two files.
describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/total-height.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/total-height.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/total-height.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

/* ── the corpus pin ─────────────────────────────────────────────────────── */

const SRC = resolve(process.cwd(), 'src');
const SELF = 'src/vendor/shared/total-height.ts';

/** Every .ts/.tsx under frontend/src, as repo-ish relative paths. */
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

/* THE POINT OF THIS BLOCK. Total Height was decided in sixteen places at once,
   and it got there one screen at a time — each new bedframe variant editor
   copied the nearest one because there was nothing to import. These assertions
   are what makes the seventeenth screen import instead of copy: they fail by
   NAMING the file that grew a private copy or dropped the import, so the
   failure reads as an instruction rather than a puzzle. */
describe('Total Height is decided in exactly one place', () => {
  test('no file outside this module defines its own parseInches', () => {
    const offenders = FILES
      .filter((f) => f.path !== SELF && /\bconst parseInches\b|\bfunction parseInches\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('no file re-derives divan + leg + gap inline', () => {
    // The exact arithmetic, however it is spelled: a sum of three parseInches
    // calls, or the ternary that decided the empty case.
    const offenders = FILES
      .filter((f) => f.path !== SELF)
      .filter((f) => /d === 0 && lg === 0 && g === 0|d === 0 && l === 0 && g === 0/.test(f.text)
        || /parseInches\([^)]*\)\s*\+\s*parseInches/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  /* The sixteen screens that author a bedframe's Total Height. Listed by name
     because "some files call it" is not the property worth pinning — THESE
     files calling it is. Un-wire any one of them and this test fails naming
     that exact path, which is the failure the next refactor needs to read.
     A seventeenth caller may be added freely; the two tests above are what stop
     it from arriving as a private copy. */
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
    // Sanity first: an assertion computed over an empty set passes for the
    // wrong reason, which is the exact way a checker lies while looking clean.
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
