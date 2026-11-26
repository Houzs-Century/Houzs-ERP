import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { byNumeric, byText, sortByNumeric, sortByText } from './sort-options';

const placeholder = fc.constantFrom('', '-', 'All', 'none', '\u2014 None \u2014', 'Unassigned');
const realLabel = fc.stringMatching(/^[a-zA-Z]x[a-zA-Z0-9 ]{0,6}$/);
const label = fc.oneof(
  fc.string({ maxLength: 8 }),
  placeholder,
  realLabel,
  fc.integer({ min: -50, max: 50 }).map((n) => `${String(n)}"`),
);
const labels = fc.array(label, { maxLength: 30 });
const mixed = fc
  .tuple(fc.array(placeholder, { maxLength: 5 }), fc.array(realLabel, { maxLength: 30 }))
  .chain(([ph, real]) =>
    fc.shuffledSubarray([...ph, ...real], { minLength: ph.length + real.length }).map((all) => ({ ph, all })),
  );

const counts = (xs: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

describe('sort-options properties', () => {
  it('sortByText is a permutation and leaves the input untouched', () => {
    fc.assert(
      fc.property(labels, (xs) => {
        const before = [...xs];
        const out = sortByText(xs);
        expect(xs).toEqual(before);
        expect(counts(out)).toEqual(counts(xs));
      }),
    );
  });

  it('sortByText puts placeholders first, then real labels in byText order', () => {
    fc.assert(
      fc.property(mixed, ({ ph, all }) => {
        const out = sortByText(all);
        expect(counts(out.slice(0, ph.length))).toEqual(counts(ph));
        const tail = out.slice(ph.length);
        for (let i = 1; i < tail.length; i += 1) {
          expect(byText(tail[i - 1], tail[i])).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('sortByText and sortByNumeric are idempotent', () => {
    fc.assert(
      fc.property(labels, (xs) => {
        const once = sortByText(xs);
        expect(sortByText(once)).toEqual(once);
        const num = sortByNumeric(xs);
        expect(sortByNumeric(num)).toEqual(num);
      }),
    );
  });

  it('byNumeric is antisymmetric', () => {
    fc.assert(
      fc.property(label, label, (a, b) => {
        expect(Math.sign(byNumeric(a, b))).toBe(-Math.sign(byNumeric(b, a)) || 0);
      }),
    );
  });
});
