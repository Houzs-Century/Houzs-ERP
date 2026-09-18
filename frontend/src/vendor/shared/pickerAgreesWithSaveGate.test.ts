/* THE PICKER AND THE SAVE GATE MUST AGREE — no value may be offerable and
 * unsaveable, and none saveable and unofferable.
 *
 * The owner, 2026-09-13: 「你检查整个源代码，我们的 SO dropdown/picker 是不是从这
 * 里的开放来选，然后不要 save 不到，不要 2990s 那些突然有 bugs 选不到啊」.
 *
 * Two questions, and they have different answers:
 *
 *   "can the dropdown go EMPTY?"  — no. `restrictStringsToPool` and
 *   `restrictPricedToPool` both return the FULL master list when the pool is
 *   empty or absent, which is the same reading the save gate takes
 *   (`hasRestriction` = a non-empty array). Clearing a pool opens a picker; it
 *   cannot empty one. Pinned below.
 *
 *   "can something be offered and then refused?" — that HAS happened, and the
 *   fix is a normalisation both sides must perform identically. The backend gate
 *   says so in its own words (docs/bugs/0814): all 79 of company 1's sofa Models
 *   carry the fabric `"TARONI "` with a trailing space, and "the pickers trim …
 *   so without this the two sides disagree on TARONI alone: the screen offers it
 *   and the save refuses it, which is the exact shape of the defect this whole
 *   change is about."
 *
 * WHY THIS TEST EXISTS AT ALL. The picker filter lives in
 * `frontend/src/vendor/shared/maintenance-pools.ts` and the save gate in
 * `backend/src/scm/lib/allowed-options-check.ts`, under DIFFERENT function
 * names. `check-shared-mirrors.mjs` compares same-named pairs, so it reports
 * this pair as invisible — its own header says a rule re-implemented under
 * another name cannot be seen. Two implementations of one rule, and nothing
 * watching them. This is the thing watching them.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { restrictStringsToPool, restrictPricedToPool } from './maintenance-pools';

const REL = 'backend/src/scm/lib/allowed-options-check.ts';
const gateSource = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, REL);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`${REL} not found above ${process.cwd()} — this test must never pass on an empty read`);
};

/* A corpus of the shapes that actually occur in this data, not invented ones:
   a straight inch mark, the two curly ones Windows produces, a trailing space
   (TARONI), and an ordinary code. */
const MASTER = ['10"', '12“', '14”', 'TARONI', 'PC151'];

describe('an empty pool OPENS the picker, it never empties it', () => {
  it('strings: no pool means the whole master list', () => {
    expect(restrictStringsToPool(MASTER, [])).toEqual(MASTER);
    expect(restrictStringsToPool(MASTER, null)).toEqual(MASTER);
    expect(restrictStringsToPool(MASTER, undefined)).toEqual(MASTER);
  });

  it('priced options: no pool means the whole master list', () => {
    const opts = MASTER.map((value) => ({ value }));
    expect(restrictPricedToPool(opts, [])).toHaveLength(MASTER.length);
    expect(restrictPricedToPool(opts, null)).toHaveLength(MASTER.length);
  });

  it('the SAVE GATE reads an empty pool the same way — no restriction', () => {
    /* Read from the backend source so the two readings cannot drift apart
       silently. If this regex stops matching, the rule moved and this test must
       be re-read rather than deleted. */
    const src = gateSource();
    expect(src).toMatch(/const hasRestriction[\s\S]{0,200}?Array\.isArray\(pool\)\s*&&\s*pool\.length\s*>\s*0/);
  });
});

describe('a non-empty pool restricts the picker to exactly what the gate accepts', () => {
  it('offers the pool members and nothing else', () => {
    expect(restrictStringsToPool(MASTER, ['PC151'])).toEqual(['PC151']);
  });

  it('keeps a value already ON the line even when the pool no longer lists it', () => {
    /* Deliberate: an old order must stay editable. The gate has the matching
       allowance — this is not a disagreement, it is the same decision on both
       sides. */
    expect(restrictStringsToPool(MASTER, ['PC151'], '10"')).toEqual(['10"', 'PC151']);
  });
});

describe('both sides normalise the SAME way — the TARONI class', () => {
  it('the gate folds typographic quotes AND trims', () => {
    const src = gateSource();
    expect(src).toMatch(/const foldForPool\s*=\s*\(s: string\): string =>\s*normaliseTypographicQuotes\(s\)\.trim\(\)/);
  });

  it('a pool entry with a TRAILING SPACE still offers its value', () => {
    /* The measured case: 79 sofa Models carry `"TARONI "`. Before the fold, the
       screen offered TARONI and the save refused it. */
    expect(restrictStringsToPool(MASTER, ['TARONI '])).toEqual(['TARONI']);
  });

  it('a pool typed with a CURLY inch mark still offers the straight one', () => {
    expect(restrictStringsToPool(MASTER, ['10”'])).toEqual(['10"']);
  });

  it('a pool typed STRAIGHT still offers the curly ones', () => {
    expect(restrictStringsToPool(MASTER, ['12"', '14"'])).toEqual(['12“', '14”']);
  });

  it('the fold is quotes-and-trim ONLY — case is NOT folded, on either side', () => {
    /* Stated as an assertion because "make it lenient" is the tempting wrong
       fix: these strings also compose `variant_key`, the inventory bucket
       identity, so widening the match here would merge two real buckets. */
    expect(restrictStringsToPool(MASTER, ['taroni'])).toEqual([]);
    expect(gateSource()).toMatch(/No trim, no case folding/);
  });
});

describe('the pair is invisible to the mirror checker, so it is pinned here', () => {
  it('the gate really is a separate implementation under a different name', () => {
    const src = gateSource();
    expect(src).toContain('hasRestriction');
    /* If the backend ever imports the picker helper, this pair stops being two
       implementations and this whole file can go. Until then it cannot. */
    expect(src).not.toContain('restrictStringsToPool');
  });
});
