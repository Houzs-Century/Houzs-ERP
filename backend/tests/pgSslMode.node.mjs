// pgSslMode decides whether the tool that migrates PRODUCTION talks over TLS.
// Every case below is written from the direction that matters: the only inputs
// allowed to return `false` are the two loopback names, and everything else —
// including garbage — must come back 'require'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSslMode } from '../scripts/lib/pg-ssl-mode.mjs';

test('a production DSN requires TLS', () => {
  assert.equal(pgSslMode('postgres://u:p@db.abcdefgh.supabase.co:5432/postgres'), 'require');
  assert.equal(pgSslMode('postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres'), 'require');
});

test('the CI scratch container does not, or the replay cannot connect at all', () => {
  assert.equal(pgSslMode('postgres://postgres:postgres@localhost:5432/houzs_replay'), false);
  assert.equal(pgSslMode('postgres://postgres:postgres@127.0.0.1:5432/houzs_test'), false);
});

test('FAILS CLOSED on anything it cannot parse', () => {
  for (const bad of ['', '   ', 'not a url', 'localhost:5432/db', undefined, null, 42, {}]) {
    assert.equal(pgSslMode(bad), 'require', `${JSON.stringify(bad)} must require TLS`);
  }
});

// The interesting attacks are the ones that LOOK local. A hostname is compared
// whole, never by prefix or suffix, so none of these may pass.
test('a host that merely resembles localhost still requires TLS', () => {
  for (const url of [
    'postgres://u:p@localhost.evil.com:5432/db',
    'postgres://u:p@notlocalhost:5432/db',
    'postgres://u:p@127.0.0.1.evil.com:5432/db',
    'postgres://u:p@127.0.0.2:5432/db',
    'postgres://u:p@[::1]:5432/db',
    'postgres://u:p@prod/db?host=localhost',
  ]) {
    assert.equal(pgSslMode(url), 'require', `${url} must require TLS`);
  }
});
