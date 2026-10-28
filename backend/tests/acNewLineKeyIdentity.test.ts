/* docs/bugs/0672 SITE 12 — `persistNewLineKeys` stores the AutoCount DtlKey a
 * freshly-added line was given, by zipping ascending new keys against the lines
 * the payload DECLARED as new.
 *
 * WHY THE ZIP NEEDS MORE THAN ONE TEST. Its sibling `persistLineKeys`, ninety
 * lines above it in the same file, defends the same zip three ways: ItemCode,
 * a prefix-tolerant Desc2 comparison, and an OUTRIGHT REFUSAL when a code
 * repeats with no Desc2 to separate the two. `persistNewLineKeys` had only the
 * first of the three, and even that was written `got && want && got !== want`
 * — so a BLANK code on either side passed as agreement.
 *
 * A wrong key here is not a mislabelled row. `composeEdit` addresses a book row
 * by `doc.EditDetail(dtlKey)` and deliberately STRIPS `ItemCode` off a keyed
 * line, so nothing in flight can reveal a wrong key: the correctness of
 * `linked_ac_dtlkey` IS the correctness of every future edit of that document,
 * in a live licensed account book. That is why 0672 says the two positional
 * writers of this column "matter more than their verdicts suggest".
 */
import { describe, expect, it } from 'vitest';
import { newLineTargetOf } from '../src/scm/lib/autocount-line-keys';

const payload = (lines: Array<Record<string, unknown>>) => ({ body: { Lines: lines } });

describe('newLineTargetOf carries what the zip needs to be checkable', () => {
  it('carries Desc2 for every declared-new line, so two lines of one code can be told apart', () => {
    const t = newLineTargetOf('SO', payload([
      { IsNewLine: true, ErpLineIds: ['a'], ItemCode: 'PC151-2S', Desc2: 'FABRIC BLUE' },
      { IsNewLine: true, ErpLineIds: ['b'], ItemCode: 'PC151-2S', Desc2: 'FABRIC GREY' },
    ]));
    expect(t).not.toBeNull();
    expect(t!.newDesc2).toEqual(['FABRIC BLUE', 'FABRIC GREY']);
  });

  it('still returns null when a declared-new line has no ERP ids', () => {
    expect(newLineTargetOf('SO', payload([
      { IsNewLine: true, ErpLineIds: [], ItemCode: 'X' },
    ]))).toBeNull();
  });

  it('keeps Desc2 aligned with newCodes when only SOME lines are new', () => {
    const t = newLineTargetOf('SO', payload([
      { DtlKey: 900, ItemCode: 'OLD', Desc2: 'OLD DESC' },
      { IsNewLine: true, ErpLineIds: ['b'], ItemCode: 'NEW', Desc2: 'NEW DESC' },
    ]));
    expect(t!.newCodes).toEqual(['NEW']);
    expect(t!.newDesc2).toEqual(['NEW DESC']);
    expect(t!.knownKeys).toEqual([900]);
  });
});

/* The zip's own rules are asserted structurally: `persistNewLineKeys` writes to
 * Supabase and reads AutoCount's reply, so pinning them behaviourally would mean
 * standing up both. What matters is that the three defences its sibling already
 * carries are PRESENT here — the property that was missing. */
describe('persistNewLineKeys carries the same three defences as persistLineKeys', () => {
  const src = new URL('../src/scm/lib/autocount-line-keys.ts', import.meta.url);
  const read = async () => (await import('node:fs')).readFileSync(src, 'utf8');
  const scoped = async () => {
    const s = await read();
    const a = s.indexOf('export async function persistNewLineKeys(');
    expect(a, 'persistNewLineKeys not found — re-anchor, do not delete').toBeGreaterThan(-1);
    return s.slice(a);
  };

  it('refuses a BLANK item code instead of letting it pass as agreement', async () => {
    const block = await scoped();
    /* The defect: `if (got && want && got !== want)`. A blank on either side
       skipped the comparison entirely and the key was stored anyway. */
    expect(block).not.toMatch(/if\s*\(\s*got\s*&&\s*want\s*&&\s*got\s*!==\s*want\s*\)/);
    expect(block).toMatch(/!got\s*\|\|\s*!want\s*\|\|\s*got\s*!==\s*want/);
  });

  it('compares Desc2, prefix-tolerantly, like its sibling', async () => {
    const block = await scoped();
    expect(block).toMatch(/startsWith/);
  });

  it('refuses outright when a code repeats and Desc2 cannot separate the two', async () => {
    const block = await scoped();
    expect(block).toMatch(/dupes/);
  });
});
