import { describe, expect, test } from 'vitest';
import { utcNowText } from '../src/lib/utc-now-text';
import supplierReturnsRaw from '../src/services/assrSupplierReturns.ts?raw';
import returnDosRaw from '../src/services/assrReturnDos.ts?raw';

/* Bug: editing a supplier return trip or a supplier DO failed with a 500 on
   Postgres. datetime('now') becomes to_char(...) (text) there, and the
   updated_at / archived_at columns are timestamptz. The fix binds the time. */
describe('utcNowText', () => {
  test('matches the SQLite datetime(now) shape in UTC', () => {
    expect(utcNowText(new Date('2026-11-09T04:05:06.789Z'))).toBe('2026-11-09 04:05:06');
  });
  test('trip and DO updates bind the time instead of calling datetime(now)', () => {
    for (const source of [supplierReturnsRaw, returnDosRaw]) {
      const tripOrDoUpdates = source.match(/UPDATE assr_(supplier_returns|return_dos)[^`]*`/g) ?? [];
      expect(tripOrDoUpdates.length).toBeGreaterThan(0);
      for (const statement of tripOrDoUpdates) expect(statement).not.toContain("datetime('now')");
    }
    expect(supplierReturnsRaw).not.toContain(`sets.push("updated_at = datetime('now')")`);
  });
});
