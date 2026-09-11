import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildSeedRackLabels, MAX_SEED_RACKS } from './rack-labels';

/* The referee for this vendored pair, in the shape the repo already uses
 * (phone.canonical.test.ts, do-shipped-states.canonical.test.ts).
 *
 * It matters more here than for a read-only rule: the Seed Racks modal PREVIEWS
 * the labels it is about to create ("Creates 42 racks: Rack L1.1 … Rack L21.2")
 * from this copy, and the server writes them from the other. Let the two drift
 * and the modal states, in writing, a shape the database will not receive —
 * which is worse than having no preview at all. */
describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/rack-labels.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/rack-labels.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/rack-labels.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  /* A byte comparison passes for the wrong reason if either read came back
     empty, so prove this copy is real and behaves — the two shapes the modal
     offers, and the cap it quotes. */
  test('this copy actually builds both label shapes', () => {
    expect(buildSeedRackLabels({ prefix: 'Rack', count: 3 }))
      .toEqual(['Rack 1', 'Rack 2', 'Rack 3']);
    const grid = buildSeedRackLabels({ prefix: 'Rack', series: 'L', count: 21, levels: 2 });
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('Rack L1.1');
    expect(grid[41]).toBe('Rack L21.2');
    expect(MAX_SEED_RACKS).toBe(200);
  });
});
