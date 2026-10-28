import { describe, it, expect } from 'vitest';
// @ts-expect-error — a .mjs helper with no type declarations, imported for the
// same reason the runtime does: this is the one function that decides whether
// the tool which migrates PRODUCTION talks over TLS.
import { pgSslMode } from '../scripts/lib/pg-ssl-mode.mjs';

/*
 * VITEST, not node:test, and that is the whole point of this file existing.
 *
 * The same assertions already ran under `node --test` in pgSslMode.node.mjs.
 * They passed, and the coverage ratchet still counted pg-ssl-mode.mjs as a file
 * with NO test executing it — the merged coverage report is built from
 * `test:coverage:light` + `test:coverage:workers`, both vitest, and a
 * `node --test` run contributes nothing to it.
 *
 * So a module can be genuinely well tested and still read as untested to the
 * gate. That is not a false positive to be waived: the gate measures EXECUTION,
 * and under the runner it can see, nothing executed this. The fix is to test it
 * where the measurement happens.
 */

describe('pgSslMode — TLS is required unless the target is loopback', () => {
  it('a production DSN requires TLS', () => {
    expect(pgSslMode('postgres://u:p@db.abcdefgh.supabase.co:5432/postgres')).toBe('require');
    expect(pgSslMode('postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres')).toBe('require');
  });

  it('loopback does not, or pg-migrate cannot reach a local database at all', () => {
    expect(pgSslMode('postgres://postgres:postgres@localhost:5432/houzs_replay')).toBe(false);
    expect(pgSslMode('postgres://postgres:postgres@127.0.0.1:5432/houzs_test')).toBe(false);
  });

  it('FAILS CLOSED on anything it cannot parse', () => {
    for (const bad of ['', '   ', 'not a url', 'localhost:5432/db', undefined, null, 42, {}]) {
      expect(pgSslMode(bad as never)).toBe('require');
    }
  });

  // The interesting attacks are the ones that LOOK local. A hostname is
  // compared whole, never by prefix or suffix, so none of these may pass.
  it('a host that merely resembles loopback still requires TLS', () => {
    for (const url of [
      'postgres://u:p@localhost.evil.com:5432/db',
      'postgres://u:p@notlocalhost:5432/db',
      'postgres://u:p@127.0.0.1.evil.com:5432/db',
      'postgres://u:p@127.0.0.2:5432/db',
      'postgres://u:p@[::1]:5432/db',
      'postgres://u:p@prod/db?host=localhost',
    ]) {
      expect(pgSslMode(url)).toBe('require');
    }
  });
});
