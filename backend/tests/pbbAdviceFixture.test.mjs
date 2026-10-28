// The SHIPPED advice fixture, read from disk and run through the real reader.
//
// Why this exists: on 2026-08-24 the fixture on disk was the output of an
// older generator and the reader refused it — "2 batch rows come to RM
// 2,548.87" against a printed total of RM 11,814.44 — and nothing failed,
// because every pbb-advice test builds its own cells. The owner would have
// found it by uploading the file the demo page told him to try. A fixture a
// test never reads is a fixture that rots silently.
//
// In tests/ as .mjs because it reads files off disk — same reason as
// bankRecognitionSeed.test.mjs.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { readPbbAdvice } from '../src/acc/pbb-advice';

describe('demo-statements/PBB-IBG-advice-Jun.pdf', () => {
  it('is the generator output the reader accepts, pairing with the Jun CSV', async () => {
    const bytes = new Uint8Array(readFileSync(
      new URL('../../demo-statements/PBB-IBG-advice-Jun.pdf', import.meta.url),
    ));
    const r = await readPbbAdvice(bytes);
    /* The reader's own self-check does the heavy lifting: rows must reach the
       printed Grand Total. This pins the figures to the CSV it pairs with. */
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.advice.batches).toHaveLength(3);
    expect(r.advice.settlementDates).toEqual(['2026-06-17']);
    expect(r.advice.netSen).toBe(1181444);        // = PBB-2990HOME-Jun.csv's net
    expect(r.advice.printedNetSen).toBe(1181444);
    expect(r.advice.statementDate).toBe('2026-06-19');
  });
});
