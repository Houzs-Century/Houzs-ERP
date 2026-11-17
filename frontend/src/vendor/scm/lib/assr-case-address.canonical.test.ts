/* Owner 2026-11-17 — the service case address prints in the SO's shape on the
 * screens exactly as on the server's printouts, trip stops and sheet: this file
 * and the server's copy are the same bytes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatCaseAddress } from './assr-case-address';

const norm = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

describe('one case-address format for the server and the screens', () => {
  test('backend/src/scm/shared/assr-case-address.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/assr-case-address.ts')).toBe(norm('src/vendor/scm/lib/assr-case-address.ts'));
  });

  test('an old case never shows its postcode twice', () => {
    expect(formatCaseAddress({ addr1: '1-G-9 Halaman Teratai', addr2: 'lebuh nipah 2', addr3: '11900 Bayan Lepas', postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' }))
      .toBe('1-G-9 Halaman Teratai, lebuh nipah 2, 11900 Bayan Lepas, Pulau Pinang');
  });
});
