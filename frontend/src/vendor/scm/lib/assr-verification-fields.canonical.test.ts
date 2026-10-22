/* HC-0133 — the Verification "Pending with" options the screens offer must be
 * the ones the server's PATCH accepts: this file and the server's copy are the same bytes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pendingWithOptions, verificationFieldsError } from './assr-verification-fields';

const norm = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

describe('one verification-fields rule for the server and the screens', () => {
  test('backend/src/scm/shared/assr-verification-fields.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/assr-verification-fields.ts')).toBe(norm('src/vendor/scm/lib/assr-verification-fields.ts'));
  });

  test('every offered option (and the blank) passes the server check', () => {
    for (const o of pendingWithOptions()) {
      expect(verificationFieldsError({ pending_with: o.value === '' ? null : o.value })).toBeNull();
    }
  });
});
