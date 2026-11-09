/* HC-0133 — the Verification fields the screens send must be the ones the
 * server's PATCH accepts: this file and the server's copy are the same bytes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { verificationFieldsError } from './assr-verification-fields';

const norm = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

describe('one verification-fields rule for the server and the screens', () => {
  test('backend/src/scm/shared/assr-verification-fields.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/assr-verification-fields.ts')).toBe(norm('src/vendor/scm/lib/assr-verification-fields.ts'));
  });

  test('pending with takes any typed text, or null to clear', () => {
    expect(verificationFieldsError({ pending_with: 'Logistic Team' })).toBeNull();
    expect(verificationFieldsError({ pending_with: null })).toBeNull();
  });

  test('pending with that is not text is refused', () => {
    expect(verificationFieldsError({ pending_with: 42 })).toBe('pending_with must be text');
  });
});
