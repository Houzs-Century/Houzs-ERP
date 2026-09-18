// ---------------------------------------------------------------------------
// r2-object-index.mjs — "does this photo actually exist?", answered once.
//
// WHY A LISTING AND NOT A GET PER KEY. A repair that removes an address has to
// know the address is dead, and the only authority for that is the bucket. One
// GET per address is ~1,400 round-trips and takes minutes; the R2 REST list
// endpoint returns 1,000 keys a page, so the whole so-items/ + po-items/ space
// is three requests. The set it builds answers every question the plan asks.
//
// The 404 shape is worth writing down because HEAD does not work here: the
// object endpoint answers 405 to HEAD, 200 + image/jpeg for a present object,
// and 404 {"code":10007} for an absent one. `verifyKeyAbsent` uses that for the
// spot-check the apply path re-runs against a handful of the keys it dropped.
//
// The API token is read by the CALLER and passed in. It is never logged, never
// interpolated into a message, and never written to a file.
// ---------------------------------------------------------------------------

const API = 'https://api.cloudflare.com/client/v4';

/**
 * Every object key under `prefixes`, as a Set.
 *
 * @param {object}   o
 * @param {string}   o.accountId
 * @param {string}   o.bucket
 * @param {string}   o.token      R2 API token — used, never printed
 * @param {string[]} o.prefixes
 * @param {Function} [o.fetchImpl] injected in tests
 * @param {number}   [o.maxPages]  runaway guard
 */
export async function listObjectKeys({ accountId, bucket, token, prefixes, fetchImpl = fetch, maxPages = 200 }) {
  const keys = new Set();
  let pages = 0;
  for (const prefix of prefixes) {
    let cursor = '';
    for (;;) {
      if (++pages > maxPages) throw new Error(`R2 listing exceeded ${maxPages} pages — refusing to loop`);
      const q = new URLSearchParams({ per_page: '1000', prefix });
      if (cursor) q.set('cursor', cursor);
      const res = await fetchImpl(`${API}/accounts/${accountId}/r2/buckets/${bucket}/objects?${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`R2 list ${prefix} failed: HTTP ${res.status}`);
      const body = await res.json();
      if (!body.success) throw new Error(`R2 list ${prefix} failed: ${JSON.stringify(body.errors)}`);
      for (const o of body.result ?? []) keys.add(o.key);
      const info = body.result_info ?? {};
      if (!info.is_truncated || !info.cursor) break;
      cursor = info.cursor;
    }
  }
  return keys;
}

/**
 * Ask the bucket directly about ONE key. Returns 'present' | 'absent', and
 * throws on anything else — an ambiguous answer must not read as "absent",
 * which is the answer that licenses a delete.
 */
export async function verifyKeyAbsent({ accountId, bucket, token, key, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `${API}/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 200) return 'present';
  if (res.status === 404) return 'absent';
  throw new Error(`R2 object probe answered HTTP ${res.status} — neither present nor absent`);
}
