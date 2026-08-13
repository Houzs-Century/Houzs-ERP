import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, the tested mirror of the app's own confirm gate
import { missingVariantAxes, isSeatlessPiece } from '../scripts/lib/variant-axes.mjs';

/* Owner, 2026-08-11: "divan only 没有 gap 的 你也可以看有些 sku 是没有的" — some
 * SKUs simply do not have the axis being asked of them, so reporting it as a
 * gap describes a defect that cannot be fixed from any source.
 *
 * The divan-only / gap half of that rule was already implemented. The seat half
 * was not: a CONSOLE is the table between two seats. The AutoCount sketch on
 * PO-009553 shows it — both seat boxes carry a figure and the console box is
 * deliberately blank. */

const keys = (group: string, variants: unknown, code: string): string[] =>
  (missingVariantAxes(group, variants, code) as { key: string }[]).map((a) => a.key);

describe('a piece with no seat is not missing a seat height', () => {
  test('a console is exempt', () => {
    expect(keys('sofa', { fabricCode: 'BO315-23' }, '8030-Console')).not.toContain('seatHeight');
    expect(isSeatlessPiece('8030-Console')).toBe(true);
    expect(isSeatlessPiece('5527-CT')).toBe(true);
  });

  test('an actual seat still is', () => {
    for (const code of ['8030-1A(LHF)', '8030-2A(RHF)', '9050-CNR', '8050-1NA', '8030-1S', '8030-L(RHF)']) {
      expect(keys('sofa', { fabricCode: 'BO315-23' }, code)).toContain('seatHeight');
      expect(isSeatlessPiece(code)).toBe(false);
    }
  });

  test('a STOOL is NOT exempt - a stool is something you sit on', () => {
    expect(keys('sofa', { fabricCode: 'BO315-23' }, '9028-STOOL')).toContain('seatHeight');
  });

  test('the exemption does not touch the fabric axis', () => {
    expect(keys('sofa', {}, '8030-Console')).toContain('fabricCode');
  });

  test('the divan-only gap rule is unchanged', () => {
    expect(keys('bedframe', { divanHeight: '8"', legHeight: '0"', fabricCode: 'PC151-01' }, 'HOK-DIVAN ONLY (K)'))
      .not.toContain('gap');
    expect(keys('bedframe', { divanHeight: '8"', legHeight: '0"', fabricCode: 'PC151-01' }, 'CASUAL-(Q)'))
      .toContain('gap');
  });
});
