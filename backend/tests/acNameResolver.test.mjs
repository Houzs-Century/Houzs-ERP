/* The free-text resolver decides GOODS vs the owner's blank-line rule, so its
 * failures are what the drop rule ends up firing on.
 *
 * `import-ac-outstanding-so.mjs` resolves a code-less AutoCount sales line by
 * NAME against the live pick list, and only when that fails does the owner's
 * 2026-08-09 rule take over — priced, it becomes a charge; unpriced, it is
 * dropped. So a matcher miss and a genuinely blank line leave the run looking
 * identical, and the run prints one count for both (`docs/bugs/0711`).
 *
 * These tests pin the property that lets a probe tell them apart WITHOUT a
 * second copy of the matcher:
 *
 *   1. the traced resolver IS the resolver — same answer, every input;
 *   2. each branch reports the rule it actually took, including the two the
 *      book's own lines fell out of on 2026-09-08.
 */
import { describe, it, expect } from 'vitest';
import { buildNameResolver, buildTracedNameResolver } from '../scripts/lib/ac-name-resolver.mjs';

/* A pick list shaped like company 1's: an exact name, a name whose dimensions
   are in brackets, a bedframe whose ERP name drops the word BEDFRAME, and a
   charge. */
const PRODUCTS = [
  { code: 'AKEMI FORTRESS MATT (K)', name: 'AKEMI FORTRESS MATT (K)' },
  { code: 'AK-BASTION MATT (Q)', name: 'AKEMI BASTION MATT (Q)' },
  { code: 'JAGER-(Q)', name: 'JAGER-(Q)' },
  { code: 'TRANSPORTATION CHARGES', name: 'TRANSPORTATION CHARGES' },
];

const DESCRIPTIONS = [
  'AKEMI FORTRESS MATTRESS (183x190x36CM)',
  'AKEMI BASTION MATTRESS (153x190x25CM)',
  'NK-JAGER B/FRAME(Q) (152x190CM)',
  'DELIVERY FEE ',
  'AKEMI BASTION MATTRESS (152x190x25CM)',
  'TRANSPORTATION CHARGES',
  '',
  null,
  undefined,
  'COLOUR : 885-4',
  'LEG: FOLLOW DISPLAY',
];

describe('the traced resolver IS the resolver', () => {
  it('answers identically on every input, so a trace cannot describe a branch the import does not take', () => {
    const plain = buildNameResolver(PRODUCTS);
    const traced = buildTracedNameResolver(PRODUCTS);
    for (const d of DESCRIPTIONS) expect(traced(d).code).toBe(plain(d));
  });

  it('always names a rule, even when it matches', () => {
    const traced = buildTracedNameResolver(PRODUCTS);
    for (const d of DESCRIPTIONS) expect(typeof traced(d).via).toBe('string');
  });
});

describe('the two branches the book fell out of on 2026-09-08', () => {
  it('reads no size from 153x190, so the token match never runs', () => {
    const v = buildTracedNameResolver(PRODUCTS)('AKEMI BASTION MATTRESS (153x190x25CM)');
    expect(v.code).toBeNull();
    expect(v.via).toMatch(/no size suffix/);
    /* And it is the SIZE, not the words: the same description at a size the
       table knows resolves. A non-standard mattress size is exactly the case a
       human answers as (SP) and a size table cannot. */
    expect(buildTracedNameResolver(PRODUCTS)('AKEMI BASTION MATTRESS (152x190x25CM)').code).toBe('AK-BASTION MATT (Q)');
  });

  it('scores JAGER 1 against a threshold of 2, because the ERP name has no BEDFRAME in it', () => {
    const v = buildTracedNameResolver(PRODUCTS)('NK-JAGER B/FRAME(Q) (152x190CM)');
    expect(v.code).toBeNull();
    expect(v.size).toBe('(Q)');
    expect(v.words).toEqual(['JAGER', 'BEDFRAME']);
    expect(v.best).toBe('JAGER-(Q)');
    expect(v.bestScore).toBe(1);
  });
});

describe('the branches that DO match', () => {
  it('resolves an exact product name', () => {
    expect(buildTracedNameResolver(PRODUCTS)('TRANSPORTATION CHARGES').via).toBe('exact product name');
  });

  it('resolves a name whose dimensions are the only difference', () => {
    const v = buildTracedNameResolver(PRODUCTS)('AKEMI FORTRESS MATTRESS (183x190x36CM)');
    expect(v.code).toBe('AKEMI FORTRESS MATT (K)');
  });

  it('sends delivery wording to the charge product', () => {
    const v = buildTracedNameResolver(PRODUCTS)('DELIVERY FEE ');
    expect(v.code).toBe('TRANSPORTATION CHARGES');
    expect(v.via).toBe('delivery/transport wording');
  });

  it('answers nothing for an empty description rather than throwing', () => {
    for (const d of ['', null, undefined]) expect(buildTracedNameResolver(PRODUCTS)(d).code).toBeNull();
  });
});
