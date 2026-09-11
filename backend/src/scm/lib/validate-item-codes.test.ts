import { describe, expect, it } from 'vitest';
import {
  validateItemCodes, unknownItemCodeResponse,
  findFreeTextSoLines, freeTextSoLineResponse,
} from './validate-item-codes';
import { parsePgrestInList } from './pgrest-in-list';

/* ═══════════════════════════════════════════════════════════════════════════
   Owner 2026-08-08 (HC-SO-2607-013 "square pillow"): every SO line is a REAL
   catalog SKU — free text never saves. These pin the two new halves of the
   guard: requireActive (a NEW pick must be an ACTIVE product, like every
   picker offer) and the free-text refusal (a blank code with typed text).
   ═══════════════════════════════════════════════════════════════════════════ */

type Row = Record<string, unknown> & { _table: string };

/* Model the WIRE: postgrest-js `.in()` quotes [,()] but never escapes, so a
   value carrying `"` (inch mark) or `\` drops itself and every value after it
   when PostgREST parses the list (docs/bugs/0780); a list without those two
   characters round-trips unchanged. `.filter(_, 'in', pgrestInList(...))` sends
   an escaped payload that survives — the fix under test. */
const wireIn = (vs: readonly unknown[]): unknown[] =>
  vs.some((v) => typeof v === 'string' && /["\\]/.test(v))
    ? parsePgrestInList(`(${[...new Set(vs)].map((s) => (typeof s === 'string' && /[,()]/.test(s) ? `"${s}"` : `${s}`)).join(',')})`)
    : [...vs];

const makeSb = (rows: Row[]) => ({
  from(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const run = () => rows
      .filter((r) => r._table === table)
      .filter((r) => eqs.every(([col, v]) => r[col] === v))
      .filter((r) => ins.every(([col, vs]) => vs.includes(r[col])));
    const builder: any = {
      select: () => builder,
      eq: (col: string, v: unknown) => { eqs.push([col, v]); return builder; },
      in: (col: string, vs: unknown[]) => { ins.push([col, wireIn(vs)]); return builder; },
      filter: (col: string, op: string, payload: string) => {
        if (op === 'in') ins.push([col, parsePgrestInList(payload)]);
        return builder;
      },
      then: (resolve: (v: { data: Row[]; error: null }) => void) =>
        resolve({ data: run(), error: null }),
    };
    return builder;
  },
});

const sb = () => makeSb([
  { _table: 'mfg_products', code: 'CODY-(K)', company_id: 1, status: 'ACTIVE' },
  { _table: 'mfg_products', code: 'OLD-SOFA', company_id: 1, status: 'INACTIVE' },
  { _table: 'mfg_products', code: 'SVC-DELIVERY', company_id: 1, status: 'ACTIVE' },
]);

describe('validateItemCodes requireActive', () => {
  it('an ACTIVE code passes, and service SKUs are ordinary catalog members', async () => {
    expect(await validateItemCodes(sb(), ['CODY-(K)', 'SVC-DELIVERY'], 1, { requireActive: true }))
      .toEqual({ ok: true });
  });

  it('an INACTIVE code is refused as a NEW pick…', async () => {
    expect(await validateItemCodes(sb(), ['OLD-SOFA'], 1, { requireActive: true }))
      .toEqual({ ok: false, unknown: [], inactive: ['OLD-SOFA'] });
  });

  it('…but passes the default existence-only check (unchanged-code line edits)', async () => {
    expect(await validateItemCodes(sb(), ['OLD-SOFA'], 1)).toEqual({ ok: true });
  });

  it('multi-line partial-bad refuses the WHOLE batch, listing every offender at once', async () => {
    expect(await validateItemCodes(sb(), ['CODY-(K)', 'NOPE-1', 'NOPE-2', 'OLD-SOFA'], 1, { requireActive: true }))
      .toEqual({ ok: false, unknown: ['NOPE-1', 'NOPE-2'], inactive: ['OLD-SOFA'] });
  });

  it('blank codes still skip the lookup (the free-text rule owns them, not this one)', async () => {
    expect(await validateItemCodes(sb(), ['', '  ', null, undefined], 1, { requireActive: true }))
      .toEqual({ ok: true });
  });

  /* docs/bugs/0780. A catalogued code carrying an inch mark (`"`) must not read
     as unknown. The old `.in('code', …)` quoted it without escaping, so the read
     dropped it and this gate reported a real SKU as "not in the catalog". The
     escaped read finds it. A revert to `.in()` trips the wireIn model and fails. */
  it('a code carrying an inch mark (") is found, not reported unknown — docs/bugs/0780', async () => {
    const INCH = 'DUNLOPILLO GENERASI 5" MATT (SS)';
    const inchSb = makeSb([{ _table: 'mfg_products', code: INCH, company_id: 1, status: 'ACTIVE' }]);
    expect(await validateItemCodes(inchSb, [INCH], 1, { requireActive: true })).toEqual({ ok: true });
  });
});

describe('unknownItemCodeResponse', () => {
  it('names unknown and inactive codes separately', () => {
    const body = unknownItemCodeResponse(['NOPE-1'], ['OLD-SOFA']);
    expect(body.error).toBe('unknown_item_code');
    expect(body.message).toContain('not in the product catalog: NOPE-1');
    expect(body.message).toContain('no longer active in the product catalog: OLD-SOFA');
    expect(body.unknown).toEqual(['NOPE-1']);
    expect(body.inactive).toEqual(['OLD-SOFA']);
  });

  it('keeps the legacy single-argument shape (no inactive key)', () => {
    const body = unknownItemCodeResponse(['NOPE-1']);
    expect('inactive' in body).toBe(false);
  });
});

describe('findFreeTextSoLines — the square-pillow shape', () => {
  it('a blank code with typed text IS free text', () => {
    expect(findFreeTextSoLines([
      { itemCode: '', description: 'Square pillow Col: BO315-22' },
    ])).toEqual(['Square pillow Col: BO315-22']);
  });

  it('a picked code with a description is a normal line; blank+blank is the scan placeholder', () => {
    expect(findFreeTextSoLines([
      { itemCode: 'CODY-(K)', description: 'CODY King bedframe' },
      { itemCode: '', description: '' },
      { itemCode: '  ', description: '   ' },
    ])).toEqual([]);
  });

  it('whitespace-only codes do not shield the text', () => {
    expect(findFreeTextSoLines([{ itemCode: '   ', description: 'Round pillow' }]))
      .toEqual(['Round pillow']);
  });

  it('the refusal body names every offending line', () => {
    const body = freeTextSoLineResponse(['Square pillow', 'Round pillow']);
    expect(body.error).toBe('so_free_text_line');
    expect(body.message).toContain('"Square pillow"');
    expect(body.message).toContain('"Round pillow"');
    expect(body.lines).toEqual(['Square pillow', 'Round pillow']);
  });
});
