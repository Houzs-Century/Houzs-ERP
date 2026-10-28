import { describe, expect, test } from 'vitest';
import { renameCompartmentMeta, type CompartmentMetaLike } from './compartmentRename';

const SEEDS: Record<string, CompartmentMetaLike> = {
  Console: { imageKey: 'sofa-modules/Console.svg', description: 'Console - fabric-wrapped' },
  '1S': { imageKey: 'sofa-modules/1S.svg', description: '1 seat' },
};
const seed = (code: string): CompartmentMetaLike => SEEDS[code] ?? {};

describe('renameCompartmentMeta', () => {
  test('a seeded code renamed to an unseeded one keeps its art (the 2026-10-02 Console photo loss)', () => {
    const out = renameCompartmentMeta({}, 'Console', 'Console Fabric', seed);
    expect(out['Console Fabric'].imageKey).toBe('sofa-modules/Console.svg');
    expect(out['Console Fabric'].description).toBe('Console - fabric-wrapped');
    expect(out.Console).toBeUndefined();
  });

  test('keystroke by keystroke, the pinned art survives to the final code', () => {
    let meta = renameCompartmentMeta({}, 'Console', 'Console ', seed);
    meta = renameCompartmentMeta(meta, 'Console ', 'Console F', seed);
    meta = renameCompartmentMeta(meta, 'Console F', 'Console Fabric', seed);
    expect(Object.keys(meta)).toEqual(['Console Fabric']);
    expect(meta['Console Fabric'].imageKey).toBe('sofa-modules/Console.svg');
  });

  test('stored overrides move with the code and win over the seed', () => {
    const out = renameCompartmentMeta(
      { Console: { imageKey: 'sofa-compartments/Console/a.jpg', description: 'mine', defaultPriceSen: 500 } },
      'Console', 'Console Fabric', seed,
    );
    expect(out['Console Fabric']).toEqual({ imageKey: 'sofa-compartments/Console/a.jpg', description: 'mine', defaultPriceSen: 500 });
  });

  test('renaming onto a code with its own art shows that art, not the carried bundled one', () => {
    const out = renameCompartmentMeta({ X: { imageKey: 'sofa-modules/Console.svg' } }, 'X', '1S', seed);
    expect(out['1S']).toBeUndefined();
  });

  test('an uploaded photo is kept even when the new code has its own art', () => {
    const out = renameCompartmentMeta({ X: { imageKey: 'sofa-compartments/X/p.jpg' } }, 'X', '1S', seed);
    expect(out['1S'].imageKey).toBe('sofa-compartments/X/p.jpg');
  });

  test('existing meta on the target code is left untouched', () => {
    const meta = { Console: { description: 'a' }, '1S': { description: 'b' } };
    expect(renameCompartmentMeta(meta, 'Console', '1S', seed)).toBe(meta);
  });

  test('an unseeded code with no meta leaves nothing behind', () => {
    expect(renameCompartmentMeta({}, 'Foo', 'Bar', seed)).toEqual({});
  });
});
