// Field photos upload the moment they are taken, so after a page reload (iOS
// often reloads under the camera) the screen asks the server for the photos it
// had already uploaded for that stop. Pinned here: the stop is recorded at
// /init, the list returns only the caller's own (real user id, not the pinned
// SCM staff id every caller shares) uploaded, unexpired, active-company photos
// for that stop, the image route refuses anyone else's, and Remove expires the
// session so the reaper deletes it and it is not listed again.
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, any>;

function memoryDb(seed: Row[]) {
  const table: Row[] = seed.map((r) => ({ ...r }));
  const from = (name: string) => {
    const preds: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let patch: Row = {};
    let lim = Infinity;
    const run = () => {
      if (name === 'showrooms') return { data: [], error: null };
      if (op === 'insert') { table.push(patch); return { data: [patch], error: null }; }
      const hit = table.filter((r) => preds.every((p) => p(r)));
      if (op === 'update') { for (const r of hit) Object.assign(r, patch); return { data: hit, error: null }; }
      return { data: hit.slice(0, lim), error: null };
    };
    const q: any = {
      select: () => q,
      insert: (p: Row) => { op = 'insert'; patch = p; return q; },
      update: (p: Row) => { op = 'update'; patch = p; return q; },
      eq: (k: string, v: unknown) => { preds.push((r) => r[k] === v); return q; },
      gt: (k: string, v: string) => { preds.push((r) => String(r[k]) > v); return q; },
      in: (k: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[k])); return q; },
      order: () => q,
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => {
        const { data } = run();
        return { data: (data as Row[])[0] ?? null, error: null };
      },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  return { sb: { from, rpc: async () => ({ data: null, error: null }) }, table };
}

let db = memoryDb([]);

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/db/supabase', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSupabaseService: () => db.sb,
}));

import { slips } from '../src/scm/routes/slips';

const CO = 3;
const SYSTEM_STAFF = '00000000-0000-4000-8000-000000000001';
const LATER = '2099-01-01T00:00:00.000Z';
const EARLIER = '2000-01-01T00:00:00.000Z';

function app(houzsUserId: number | null, company = CO) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, db.sb as never);
    c.set('companyId' as never, company as never);
    c.set('user' as never, { id: SYSTEM_STAFF, user_metadata: {} } as never);
    c.set('houzsUser' as never, (houzsUserId == null ? undefined : { id: houzsUserId, permissions_set: new Set(['*']) }) as never);
    await next();
  });
  a.route('/slips', slips);
  return a;
}

const row = (over: Row): Row => ({
  id: over.upload_session_id, staff_id: SYSTEM_STAFF, company_id: CO, status: 'uploaded',
  content_type: 'image/jpeg', expires_at: LATER, created_at: '2026-11-10T01:00:00Z', ...over,
});

function bucket(objects: Record<string, string> = {}) {
  return {
    put: async () => {}, delete: async () => {}, head: async () => null,
    get: async (k: string) => (k in objects ? { body: new Blob([objects[k]!]).stream() } : null),
  };
}

afterEach(() => { db = memoryDb([]); });

describe('field photo re-list after a reload', () => {
  test('/init records the stop for the real caller', async () => {
    const res = await app(9).request('/slips/init', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileSize: 8, contentType: 'image/jpeg', contentHash: 'ab'.repeat(32), purpose: 'field_photo', fieldContext: 'do:do-1' }),
    }, { SLIPS: bucket() });
    expect(res.status).toBe(200);
    expect(db.table[0]).toMatchObject({ company_id: CO, order_draft_id: 'field:u9:do:do-1', status: 'pending' });
  });

  test('/init without a context stores none, and a payment slip never carries one', async () => {
    for (const body of [
      { fileSize: 8, contentType: 'image/jpeg', contentHash: 'ab'.repeat(32), purpose: 'field_photo' },
      { fileSize: 8, contentType: 'image/jpeg', contentHash: 'ab'.repeat(32), fieldContext: 'do:do-1' },
    ]) {
      const res = await app(9).request('/slips/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { SLIPS: bucket() });
      expect(res.status).toBe(200);
    }
    expect(db.table.map((r) => r.order_draft_id)).toEqual([undefined, undefined]);
  });

  test('/init refuses a context with control characters', async () => {
    const res = await app(9).request('/slips/init', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileSize: 8, contentType: 'image/jpeg', contentHash: 'ab'.repeat(32), purpose: 'field_photo', fieldContext: 'do:\u0000' }),
    }, { SLIPS: bucket() });
    expect(res.status).toBe(400);
  });

  test('lists only this caller\'s uploaded, unexpired photos for this stop in the active company', async () => {
    db = memoryDb([
      row({ upload_session_id: 'mine', r2_key: 'slips/mine.jpg', order_draft_id: 'field:u9:do:do-1' }),
      row({ upload_session_id: 'other-user', r2_key: 'slips/o.jpg', order_draft_id: 'field:u10:do:do-1' }),
      row({ upload_session_id: 'other-stop', r2_key: 'slips/s.jpg', order_draft_id: 'field:u9:do:do-2' }),
      row({ upload_session_id: 'other-co', r2_key: 'slips/c.jpg', order_draft_id: 'field:u9:do:do-1', company_id: 4 }),
      row({ upload_session_id: 'claimed', r2_key: 'slips/p.jpg', order_draft_id: 'field:u9:do:do-1', status: 'promoted' }),
      row({ upload_session_id: 'still-pending', r2_key: 'slips/q.jpg', order_draft_id: 'field:u9:do:do-1', status: 'pending' }),
      row({ upload_session_id: 'expired', r2_key: 'slips/e.jpg', order_draft_id: 'field:u9:do:do-1', expires_at: EARLIER }),
    ]);
    const res = await app(9).request('/slips/field-photos?context=do%3Ado-1', {}, { SLIPS: bucket() });
    expect(res.status).toBe(200);
    const json = await res.json() as { photos: Array<{ uploadSessionId: string; r2Key: string }> };
    expect(json.photos.map((p) => p.uploadSessionId)).toEqual(['mine']);
    expect(json.photos[0]!.r2Key).toBe('slips/mine.jpg');
  });

  test('the list needs a context and a real caller', async () => {
    expect((await app(9).request('/slips/field-photos', {}, { SLIPS: bucket() })).status).toBe(400);
    expect((await app(null).request('/slips/field-photos?context=do:do-1', {}, { SLIPS: bucket() })).status).toBe(401);
  });

  test('the image route serves the caller\'s own photo and refuses another user\'s', async () => {
    db = memoryDb([
      row({ upload_session_id: 'mine', r2_key: 'slips/mine.jpg', order_draft_id: 'field:u9:do:do-1' }),
      row({ upload_session_id: 'theirs', r2_key: 'slips/theirs.jpg', order_draft_id: 'field:u10:do:do-1' }),
      row({ upload_session_id: 'slip', r2_key: 'slips/pay.jpg', order_draft_id: null }),
    ]);
    const env = { SLIPS: bucket({ 'slips/mine.jpg': 'JPEGDATA', 'slips/theirs.jpg': 'X', 'slips/pay.jpg': 'Y' }) };
    const ok = await app(9).request('/slips/field-photos/mine/image', {}, env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(await ok.text()).toBe('JPEGDATA');
    expect((await app(9).request('/slips/field-photos/theirs/image', {}, env)).status).toBe(404);
    // A payment slip is not a field photo and is not served here.
    expect((await app(9).request('/slips/field-photos/slip/image', {}, env)).status).toBe(404);
    // Same session id, other company: not found.
    expect((await app(9, 4).request('/slips/field-photos/mine/image', {}, env)).status).toBe(404);
  });

  test('Remove expires the session, so it is not listed again and the reaper takes it', async () => {
    db = memoryDb([row({ upload_session_id: 'mine', r2_key: 'slips/mine.jpg', order_draft_id: 'field:u9:do:do-1' })]);
    const res = await app(9).request('/slips/field-photos/mine/discard', { method: 'POST' }, { SLIPS: bucket() });
    expect(res.status).toBe(200);
    expect(Date.parse(db.table[0]!.expires_at)).toBeLessThanOrEqual(Date.now());
    expect(db.table[0]!.status).toBe('uploaded');
    const list = await (await app(9).request('/slips/field-photos?context=do:do-1', {}, { SLIPS: bucket() })).json() as { photos: unknown[] };
    expect(list.photos).toEqual([]);
  });

  test('Remove refuses a photo a Complete already claimed, and another user\'s photo', async () => {
    db = memoryDb([
      row({ upload_session_id: 'claimed', r2_key: 'slips/p.jpg', order_draft_id: 'field:u9:do:do-1', status: 'promoted' }),
      row({ upload_session_id: 'theirs', r2_key: 'slips/t.jpg', order_draft_id: 'field:u10:do:do-1' }),
    ]);
    expect((await app(9).request('/slips/field-photos/claimed/discard', { method: 'POST' }, { SLIPS: bucket() })).status).toBe(409);
    expect((await app(9).request('/slips/field-photos/theirs/discard', { method: 'POST' }, { SLIPS: bucket() })).status).toBe(404);
    expect(db.table.map((r) => r.expires_at)).toEqual([LATER, LATER]);
  });
});
