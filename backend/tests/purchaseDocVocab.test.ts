import { describe, expect, test } from 'vitest';
import poSource from '../src/scm/routes/mfg-purchase-orders.ts?raw';
import pcoSource from '../src/scm/routes/purchase-consignment-orders.ts?raw';
import { VALID_CURRENCIES, VALID_KINDS } from '../src/scm/lib/purchase-doc-vocab';

/* Both purchase routers declared three same-named constants. Two were copies;
   the third differs ON PURPOSE and neither file said so.

   That arrangement is the problem this file exists for: a deliberate difference
   sitting under the same name as two accidental copies reads as an oversight,
   and the next person to "tidy up" hands a PCO a draft state it does not have —
   or takes the PO's away. So: the copies are shared, and the difference is
   asserted. */

const normalise = (s: string) => s.replace(/\r\n/g, '\n');
const po = normalise(poSource);
const pco = normalise(pcoSource);

/** The literal Set a file declares for `name`, as a sorted array. */
function declaredSet(source: string, name: string): string[] {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

describe('the two purchase documents share what is genuinely shared', () => {
  /* Look for the DECLARATION, not for its contents. The first version of this
     test asked `declaredSet(...)` to come back empty — and `declaredSet` reads
     the quoted strings inside the Set, so a re-declaration holding anything
     else (`new Set([1])`, a spread, a variable) parsed as zero entries and
     PASSED. Proving the guard red is what surfaced that: the mutation went in
     and the suite stayed green. A check that only sees one spelling of the
     thing it forbids is not a check. */
  const declaresConst = (source: string, name: string) =>
    new RegExp(`^\\s*(export\\s+)?const ${name}\\b`, 'm').test(source);

  test('neither router still declares its own VALID_CURRENCIES or VALID_KINDS', () => {
    for (const [label, src] of [['PO', po], ['PCO', pco]] as const) {
      expect(declaresConst(src, 'VALID_CURRENCIES'), `${label} re-declares VALID_CURRENCIES`).toBe(false);
      expect(declaresConst(src, 'VALID_KINDS'), `${label} re-declares VALID_KINDS`).toBe(false);
    }
  });

  test('that check can SEE a declaration — it is not passing on a dead pattern', () => {
    /* VALID_STATUSES is declared in both, by design. If the matcher cannot find
       it, the two assertions above are passing over nothing. */
    expect(declaresConst(po, 'VALID_STATUSES'), 'the matcher cannot see a declaration it should').toBe(true);
    expect(declaresConst(pco, 'VALID_STATUSES'), 'the matcher cannot see a declaration it should').toBe(true);
  });

  test('both import them from the shared module', () => {
    for (const [label, src] of [['PO', po], ['PCO', pco]] as const) {
      expect(src, `${label} does not import purchase-doc-vocab`).toContain('purchase-doc-vocab');
    }
  });

  test('the shared sets hold what they held before the move', () => {
    expect([...VALID_CURRENCIES].sort()).toEqual(['MYR', 'RMB', 'SGD', 'USD']);
    expect([...VALID_KINDS].sort()).toEqual(['fabric', 'mfg_product', 'raw']);
  });
});

describe('VALID_STATUSES differs on purpose, and stays different', () => {
  test('both routers still declare their own — this one is NOT shared', () => {
    expect(declaredSet(po, 'VALID_STATUSES').length, 'the PO stopped declaring VALID_STATUSES').toBeGreaterThan(0);
    expect(declaredSet(pco, 'VALID_STATUSES').length, 'the PCO stopped declaring VALID_STATUSES').toBeGreaterThan(0);
  });

  test('they differ by exactly DRAFT — a PCO has no draft state', () => {
    const poStatuses = declaredSet(po, 'VALID_STATUSES');
    const pcoStatuses = declaredSet(pco, 'VALID_STATUSES');

    const onlyPo = poStatuses.filter((s) => !pcoStatuses.includes(s));
    const onlyPco = pcoStatuses.filter((s) => !poStatuses.includes(s));

    expect(
      onlyPo,
      'the PO should have exactly one status the PCO lacks, and it should be DRAFT.\n' +
        'If a new status was added to the PO alone, decide whether the PCO needs it and say so here.',
    ).toEqual(['DRAFT']);

    expect(
      onlyPco,
      'the PCO has gained a status the PO does not have:\n  ' + onlyPco.join(', ') +
        '\nThat may be right, but it is a document-model change and this test is where it gets stated.',
    ).toEqual([]);
  });

  test('the guard is reading real sets, not two empty ones', () => {
    /* Without this, deleting both declarations would make the comparison above
       "pass" on two empty arrays — the shape that reports a clean run over
       nothing. */
    expect(declaredSet(po, 'VALID_STATUSES').length).toBeGreaterThanOrEqual(5);
    expect(declaredSet(pco, 'VALID_STATUSES').length).toBeGreaterThanOrEqual(4);
  });
});
