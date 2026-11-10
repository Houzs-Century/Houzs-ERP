import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { yymmFor } from '../src/services/documentRefs';
import { nextDocNo as nextSoDocNo } from '../src/scm/routes/mfg-sales-orders';
import { nextDocNo as nextCsDocNo } from '../src/scm/routes/consignment-orders';
import { nextSiNumber } from '../src/scm/lib/si-from-do';
import { nextServicePONumber } from '../src/services/assr';
import type { Env } from '../src/types';

/* A document raised at 01:30 Malaysia time on 1 Dec is 17:30 UTC on 30 Nov.
   The Worker clock is UTC, so `getMonth()` numbered it under November.
   On a +08 laptop the old code passes the minter cases below (getMonth() is
   local time there); they fail it under TZ=UTC, as in CI. The source scan at
   the foot fails it on any machine. */
const MYT_0130_1_DEC = '2026-11-30T17:30:00Z';
const MYT_2359_30_NOV = '2026-11-30T15:59:00Z';

const ctx = (companyCode: string) => ({ get: (k: string) => (k === 'companyCode' ? companyCode : undefined) });

const atTime = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

afterEach(() => { vi.useRealTimers(); });

describe('yymmFor at the month boundary', () => {
  it('01:30 on 1 Dec in Malaysia is 2612, not 2611', () => {
    expect(yymmFor(Date.parse(MYT_0130_1_DEC))).toBe('2612');
  });
  it('23:59 on 30 Nov in Malaysia is still 2611', () => {
    expect(yymmFor(Date.parse(MYT_2359_30_NOV))).toBe('2611');
  });
  it('the year rolls over on Malaysian new year', () => {
    expect(yymmFor(Date.parse('2026-12-31T16:30:00Z'))).toBe('2701');
  });
});

describe('document minters use the Malaysian month', () => {
  it('a Sales Order made at 01:30 on 1 Dec gets a 2612 number, and the counter series is 2612', async () => {
    atTime(MYT_0130_1_DEC);
    const sb = fakeSb({ mfg_sales_orders: [{ doc_no: 'HC-SO-2611-007' }] });
    expect(await nextSoDocNo(sb, ctx('HOUZS'))).toBe('HC-SO-2612-001');
    expect(sb.rpcCalls.map((r) => r.args)).toEqual([expect.objectContaining({ p_series: 'HC-SO-2612' })]);
  });

  it('a Sales Order made at 23:59 on 30 Nov continues the November series', async () => {
    atTime(MYT_2359_30_NOV);
    const sb = fakeSb({ mfg_sales_orders: [{ doc_no: 'HC-SO-2611-007' }] });
    expect(await nextSoDocNo(sb, ctx('HOUZS'))).toBe('HC-SO-2611-008');
  });

  it('a consignment order made at 01:30 on 1 Dec gets a 2612 number', async () => {
    atTime(MYT_0130_1_DEC);
    const sb = fakeSb({ consignment_sales_orders: [{ doc_no: 'HC-CS-2611-003' }] });
    expect(await nextCsDocNo(sb, ctx('HOUZS'))).toBe('HC-CS-2612-001');
  });

  it('a sales invoice made at 01:30 on 1 Dec gets a 2612 number', async () => {
    atTime(MYT_0130_1_DEC);
    const sb = fakeSb({ sales_invoices: [] });
    expect(await nextSiNumber(sb, 'HC-')).toBe('HC-SI-2612-001');
  });

  it('a service PO made at 01:30 on 1 Dec gets an APO/2612 number', async () => {
    const binds: unknown[] = [];
    const DB = {
      prepare: (sql: string) => ({
        bind: (...b: unknown[]) => {
          if (sql.includes('next_doc_no_n')) return { first: async () => { throw new Error('function scm.next_doc_no_n does not exist'); } };
          binds.push(...b);
          return { all: async () => ({ results: [] }) };
        },
      }),
    };
    expect(await nextServicePONumber({ DB } as unknown as Env, Date.parse(MYT_0130_1_DEC))).toBe('APO/2612-001');
    expect(binds).toEqual(['APO/2612-%']);
  });
});

/* The SCM routes each built YYMM inline from `new Date().getMonth()`. This
   keeps a new minter from copying that idiom back in. No exceptions: the PO
   route moved to yymmFor() in #5464. */
describe('no document minter builds YYMM from the UTC month', () => {
  const UTC_YYMM = /String\(\s*\w+\.getFullYear\(\)\s*\)\.slice\(\s*2\s*\)\s*\}\s*\$\{\s*String\(\s*\w+\.getMonth\(\)\s*\+\s*1\s*\)/;
  const root = path.resolve(__dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
    });

  it('the pattern matches the old idiom', () => {
    expect(UTC_YYMM.test("const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;")).toBe(true);
    expect(UTC_YYMM.test('const yymm = yymmFor();')).toBe(false);
  });

  it('finds no file under backend/src using it', () => {
    const files = walk(path.join(root, 'src'));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .filter((rel) => UTC_YYMM.test(readFileSync(path.join(root, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
