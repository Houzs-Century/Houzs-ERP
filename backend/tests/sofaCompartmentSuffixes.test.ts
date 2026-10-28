/* The scripts copy of the sofa compartment list, and the question it answers.
 *
 * The list itself is duplicated — scripts/*.mjs is plain Node and cannot import
 * SOFA_COMPARTMENTS out of the TypeScript Worker bundle. THIS FILE is what makes
 * the duplicate safe: it imports both and asserts them equal, so the copy cannot
 * drift silently. Delete this test and the duplication becomes the bug class
 * CLAUDE.md names.
 *
 * The behavioural half pins decomposeGroup, whose whole reason to exist is that
 * docs/bugs/0672's discriminator ("do the sharing rows name different
 * products?") answered 295 of 296 and meant nothing, because a sofa's
 * compartments DO name different products.
 */
import { describe, it, expect } from 'vitest';
import { SOFA_COMPARTMENTS as SCRIPT_SET, decomposeGroup } from '../scripts/lib/sofa-compartment-suffixes.mjs';
import { SOFA_COMPARTMENTS as SRC_LIST } from '../src/services/autocount-sofa-collapse';

describe('the scripts copy of the compartment list', () => {
  it('holds exactly what autocount-sofa-collapse.ts holds', () => {
    const fromSrc = [...SRC_LIST].map((s) => s.toUpperCase()).sort();
    const fromScript = [...SCRIPT_SET].sort();
    expect(fromScript).toEqual(fromSrc);
  });
});

describe('decomposeGroup — is this group ONE sofa, or a key collision?', () => {
  it('accepts one model split into distinct compartments', () => {
    const r = decomposeGroup(['REGAL-1A(LHF)', 'REGAL-CNR', 'REGAL-2A(RHF)']);
    expect(r.ok).toBe(true);
    expect((r as { model: string }).model).toBe('REGAL');
  });

  it('accepts codes in any letter case and with stray whitespace', () => {
    expect(decomposeGroup([' regal-1s ', 'REGAL-CNR']).ok).toBe(true);
  });

  /* The case 0672's discriminator got wrong: different products, but by design. */
  it('does NOT call a sofa a collision merely because the codes differ', () => {
    const codes = ['TRION-1S', 'TRION-2S'];
    expect(new Set(codes).size).toBe(2);
    expect(decomposeGroup(codes).ok).toBe(true);
  });

  it('refuses two different models on one key', () => {
    const r = decomposeGroup(['REGAL-1S', 'TRION-CNR']);
    expect(r.ok).toBe(false);
    expect((r as { why: string }).why).toMatch(/different models/);
  });

  it('refuses a code with no compartment suffix', () => {
    const r = decomposeGroup(['AMN-SOFA PILLOW', 'REGAL-1S']);
    expect(r.ok).toBe(false);
  });

  it('refuses a suffix that is not a known compartment', () => {
    const r = decomposeGroup(['REGAL-1S', 'REGAL-QUEEN']);
    expect(r.ok).toBe(false);
    expect((r as { why: string }).why).toMatch(/not a compartment suffix/);
  });

  /* THIS ASSERTION IS THE OPPOSITE OF WHAT IT SAID FIRST, and the reversal is
     the finding. The rule refused a repeated compartment until probe run
     34143079454 flagged 14 of 394 groups, every one of them for that reason
     alone (`9058-1NA, 9058-1NA, 9058-CNR`, `R819-1S(R), R819-1S(R)`). A
     four-seater is 1A(LHF) + 1NA + 1NA + 1A(RHF); two identical recliners is a
     book line of quantity two. Refusing those answered a different question. */
  it('ACCEPTS a repeated compartment — a four-seater has two armless middles', () => {
    const r = decomposeGroup(['9058-1NA', '9058-1NA', '9058-CNR']);
    expect(r.ok).toBe(true);
    expect((r as { repeated: string[] }).repeated).toEqual(['1NA']);
  });

  it('reports no repeat when every compartment is distinct', () => {
    const r = decomposeGroup(['REGAL-1S', 'REGAL-CNR']);
    expect((r as { repeated: string[] }).repeated).toEqual([]);
  });

  /* A caller that forgets to filter to groups of >1 must not read a clean
     answer out of a single row. */
  it('refuses a group of one rather than passing it', () => {
    expect(decomposeGroup(['REGAL-1S']).ok).toBe(false);
    expect(decomposeGroup([]).ok).toBe(false);
  });
});
