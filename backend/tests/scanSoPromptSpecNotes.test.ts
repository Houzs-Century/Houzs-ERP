// HC-0190: a bedframe spec note written beside or between rows must go to the
// nearest bedframe row above it. Lives in tests/ because it reads the source and
// backend/src is typechecked against the Workers runtime, which has no node:fs.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('scan-so prompt', () => {
  test('margin spec notes belong to the nearest bedframe row above', () => {
    const source = readFileSync('src/scm/routes/scan-so.ts', 'utf8');
    expect(source).toContain('SPEC NOTES BESIDE OR BETWEEN ROWS');
    expect(source).toContain('nearest BEDFRAME row ABOVE it, never to a pillow, mattress, protector or other accessory row');
  });
});
