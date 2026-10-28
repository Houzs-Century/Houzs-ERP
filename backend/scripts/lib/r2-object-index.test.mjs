/**
 * node --test backend/scripts/lib/r2-object-index.test.mjs
 * Zero dependencies; fetch is injected, so nothing here touches the network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listObjectKeys, verifyKeyAbsent } from './r2-object-index.mjs';

const page = (keys, cursor) => ({
  ok: true,
  json: async () => ({
    success: true,
    result: keys.map((k) => ({ key: k })),
    result_info: cursor ? { is_truncated: true, cursor } : { is_truncated: false },
  }),
});

test('listing follows the cursor to the end of a prefix', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return url.includes('cursor=c1') ? page(['b']) : page(['a'], 'c1');
  };
  const keys = await listObjectKeys({ accountId: 'acct', bucket: 'buck', token: 't', prefixes: ['so-items/'], fetchImpl });
  assert.deepEqual([...keys].sort(), ['a', 'b']);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes('prefix=so-items%2F'));
});

test('the token rides in the header and never in the URL', async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, init }; return page(['a']); };
  await listObjectKeys({ accountId: 'acct', bucket: 'buck', token: 'SECRET', prefixes: ['po-items/'], fetchImpl });
  assert.ok(!captured.url.includes('SECRET'));
  assert.equal(captured.init.headers.Authorization, 'Bearer SECRET');
});

test('an HTTP error is thrown, never read as an empty bucket', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(
    () => listObjectKeys({ accountId: 'a', bucket: 'b', token: 't', prefixes: ['so-items/'], fetchImpl }),
    /HTTP 403/,
  );
});

test('a runaway listing is stopped rather than looped forever', async () => {
  const fetchImpl = async () => page(['a'], 'always-more');
  await assert.rejects(
    () => listObjectKeys({ accountId: 'a', bucket: 'b', token: 't', prefixes: ['so-items/'], fetchImpl, maxPages: 3 }),
    /exceeded 3 pages/,
  );
});

test('the single-key probe answers present / absent and refuses anything else', async () => {
  const at = (status) => async () => ({ status });
  assert.equal(await verifyKeyAbsent({ accountId: 'a', bucket: 'b', token: 't', key: 'k', fetchImpl: at(200) }), 'present');
  assert.equal(await verifyKeyAbsent({ accountId: 'a', bucket: 'b', token: 't', key: 'k', fetchImpl: at(404) }), 'absent');
  await assert.rejects(
    () => verifyKeyAbsent({ accountId: 'a', bucket: 'b', token: 't', key: 'k', fetchImpl: at(405) }),
    /neither present nor absent/,
  );
});
