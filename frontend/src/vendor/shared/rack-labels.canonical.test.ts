import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildSeedRackLabels, MAX_SEED_RACKS } from './rack-labels';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/rack-labels.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/rack-labels.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/rack-labels.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

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
