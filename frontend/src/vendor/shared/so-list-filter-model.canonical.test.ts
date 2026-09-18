import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseSoListFilters, serializeSoListFilters, SO_FILTER_FIELDS } from './so-list-filter-model';

/* The referee for this vendored pair (same shape as rack-labels.canonical.test.ts).
 *
 * The phone sheet and the desktop bar BUILD filter rows from this copy; the list
 * endpoint VALIDATES them with the backend copy and answers 400 invalid_filter
 * for anything it refuses. Let the two drift and a filter the screen offers is
 * refused by the server — the user taps Apply and the list errors. */
describe('the two copies of the SO list filter model are the same file', () => {
  test('backend/src/scm/shared/so-list-filter-model.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/so-list-filter-model.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/so-list-filter-model.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  /* A byte comparison passes for the wrong reason if either read came back
     empty, so prove this copy is real and round-trips a row. */
  test('this copy actually parses what it serialises', () => {
    expect(SO_FILTER_FIELDS.length).toBeGreaterThan(10);
    const rows = parseSoListFilters(['createdBy:me', 'balance:gt:100']).filters;
    expect(serializeSoListFilters(rows)).toEqual(['createdBy:me', 'balance:gt:100']);
  });
});
