// Every column the Delivery Order header PATCH writes must be CLASSIFIED by the
// shared lock rule (src/scm/shared/do-header-lock.ts, owner ruling 2026-09-14):
// locked once a live Sales Invoice / Delivery Return exists, or open. A new PATCH
// column nobody classified fails here, so a field cannot join the edit without
// somebody deciding whether an invoice freezes it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DO_HEADER_LOCKED_FIELDS, DO_HEADER_LOCK_COLS, DO_HEADER_OPEN_COLS } from '../src/scm/shared/do-header-lock';
import { DO_AUDIT_FIELDS } from '../src/scm/lib/do-audit-fields';

/** The [bodyKey, column] pairs the header PATCH actually maps, read from the route. */
function patchMap(): Array<[string, string]> {
  const src = readFileSync(join(__dirname, '..', 'src', 'scm', 'routes', 'delivery-orders-mfg.ts'), 'utf8');
  const start = src.indexOf("deliveryOrdersMfg.patch('/:id', async");
  expect(start, 'header PATCH handler not found — the scan would match nothing').toBeGreaterThan(0);
  const block = src.slice(start, src.indexOf('];', start));
  const pairs = [...block.matchAll(/\['(\w+)',\s*'(\w+)'\]/g)].map((m) => [m[1], m[2]] as [string, string]);
  expect(pairs.length, 'PATCH map parsed to nothing').toBeGreaterThan(30);
  return pairs;
}

describe('the DO header lock partition is exhaustive', () => {
  it('every column the header PATCH writes is classified locked or open, never both', () => {
    const unclassified = patchMap()
      .map(([, col]) => col)
      .filter((col) => !DO_HEADER_LOCK_COLS.has(col) && !DO_HEADER_OPEN_COLS.has(col));
    expect(unclassified).toEqual([]);
    for (const col of DO_HEADER_OPEN_COLS) expect(DO_HEADER_LOCK_COLS.has(col), col).toBe(false);
  });

  it('every locked field names exactly the body keys the PATCH maps to its column', () => {
    const map = patchMap();
    for (const f of DO_HEADER_LOCKED_FIELDS) {
      const mapped = map.filter(([, col]) => col === f.col).map(([k]) => k).sort();
      expect([...f.body].sort(), f.col).toEqual(mapped);
    }
  });

  it('the audit select reads every locked column (the lock diffs against it)', () => {
    const audited = new Set(DO_AUDIT_FIELDS.map(([, snake]) => snake));
    for (const col of DO_HEADER_LOCK_COLS) expect(audited.has(col), col).toBe(true);
  });
});
