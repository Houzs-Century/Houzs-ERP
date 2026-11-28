import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import {
  listDriversHandler,
  createDriverHandler,
  patchDriverHandler,
  getDriverPhotoHandler,
  postDriverPhotoHandler,
} from './drivers';

type Row = Record<string, unknown>;

const driverRow = (over: Row = {}): Row => ({
  id: 'd1',
  driver_code: 'DRV-001',
  name: 'Rahman',
  phone: '+60123456789',
  ic_number: null,
  vehicle: null,
  in_house: false,
  threepl_company_id: 'carrier-1',
  active: true,
  created_at: '2026-11-28T00:00:00.000Z',
  warehouse_id: null,
  photo_r2_key: null,
  license_no: null,
  license_expiry: null,
  address: null,
  emergency_contact_name: null,
  emergency_contact_phone: null,
  ...over,
});

function fakeBucket() {
  const store = new Map<string, { value: ArrayBuffer; contentType: string }>();
  return {
    store,
    put: async (key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { value, contentType: opts?.httpMetadata?.contentType ?? 'application/octet-stream' });
    },
    get: async (key: string) => {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        body: hit.value,
        writeHttpMetadata: (h: Headers) => h.set('content-type', hit.contentType),
      };
    },
  };
}

function harness(opts: { drivers?: Row[]; companyId?: number; bucket?: ReturnType<typeof fakeBucket> } = {}) {
  const sb = fakeSb({ drivers: opts.drivers ?? [] });
  const bucket = opts.bucket ?? fakeBucket();
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', (opts.companyId ?? 1) as Variables['companyId']);
    c.set('user', { id: 'u1' } as unknown as Variables['user']);
    await next();
  });
  app.get('/drivers', listDriversHandler);
  app.post('/drivers', createDriverHandler);
  app.patch('/drivers/:id', patchDriverHandler);
  app.get('/drivers/:id/photo', getDriverPhotoHandler);
  app.post('/drivers/:id/photo', postDriverPhotoHandler);
  const env = { POD_BUCKET: bucket } as unknown as Env;
  return { sb, bucket, env, app };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patchJson = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('create carries the office profile fields', () => {
  it('persists licence, address and emergency contact on insert', async () => {
    const h = harness();
    const res = await h.app.request('/drivers', json({
      name: 'Imran', phone: '+60127654321', inHouse: false,
      licenseNo: 'D1234567', licenseExpiry: '2027-05-01',
      address: '12 Jalan Baru, KL', emergencyContactName: 'Siti', emergencyContactPhone: '011-222 333',
    }), h.env);
    expect(res.status).toBe(201);
    const body = await res.json() as { driver: Row };
    expect(body.driver.license_no).toBe('D1234567');
    expect(body.driver.license_expiry).toBe('2027-05-01');
    expect(body.driver.address).toBe('12 Jalan Baru, KL');
    expect(body.driver.emergency_contact_name).toBe('Siti');
    expect(body.driver.emergency_contact_phone).toBe('011-222 333');
    const stored = h.sb.tables.drivers[0];
    expect(stored.license_no).toBe('D1234567');
    expect(stored.emergency_contact_phone).toBe('011-222 333');
  });

  it('refuses a licence expiry that is not a real date (400, not a 500)', async () => {
    const h = harness();
    const res = await h.app.request('/drivers', json({
      name: 'Imran', phone: '+60127654321', licenseExpiry: '2027-13-40',
    }), h.env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_license_expiry');
  });
});

describe('PATCH edits the profile without disturbing the carrier link', () => {
  it('persists the changed profile fields', async () => {
    const h = harness({ drivers: [driverRow()] });
    const res = await h.app.request('/drivers/d1', patchJson({
      licenseNo: 'X99', licenseExpiry: '2028-01-15', address: 'New address', emergencyContactName: 'Ali',
    }), h.env);
    expect(res.status).toBe(200);
    const stored = h.sb.tables.drivers[0];
    expect(stored.license_no).toBe('X99');
    expect(stored.license_expiry).toBe('2028-01-15');
    expect(stored.address).toBe('New address');
    expect(stored.emergency_contact_name).toBe('Ali');
  });

  it('leaves in_house and the carrier link untouched when only a profile field changes', async () => {
    const h = harness({ drivers: [driverRow({ in_house: false, threepl_company_id: 'carrier-1' })] });
    await h.app.request('/drivers/d1', patchJson({ address: 'Somewhere' }), h.env);
    const stored = h.sb.tables.drivers[0];
    expect(stored.in_house).toBe(false);
    expect(stored.threepl_company_id).toBe('carrier-1');
  });

  it('clears a profile field when sent blank', async () => {
    const h = harness({ drivers: [driverRow({ address: 'Old' })] });
    await h.app.request('/drivers/d1', patchJson({ address: '' }), h.env);
    expect(h.sb.tables.drivers[0].address).toBeNull();
  });

  it('refuses a bad licence expiry on edit too', async () => {
    const h = harness({ drivers: [driverRow()] });
    const res = await h.app.request('/drivers/d1', patchJson({ licenseExpiry: 'soon' }), h.env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_license_expiry');
  });
});

describe('driver photo endpoint', () => {
  it('stores the object + key on POST and streams it back on GET', async () => {
    const h = harness({ drivers: [driverRow()] });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const post = await h.app.request('/drivers/d1/photo?name=lic.png', {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes,
    }, h.env);
    expect(post.status).toBe(200);
    const key = (await post.json() as { photo_r2_key: string }).photo_r2_key;
    expect(key.startsWith('driver/d1/')).toBe(true);
    expect(h.sb.tables.drivers[0].photo_r2_key).toBe(key);
    expect(h.bucket.store.has(key)).toBe(true);

    const get = await h.app.request(`/drivers/d1/photo?k=${encodeURIComponent(key)}`, {}, h.env);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it('404s on GET when the driver has no photo', async () => {
    const h = harness({ drivers: [driverRow({ photo_r2_key: null })] });
    const res = await h.app.request('/drivers/d1/photo', {}, h.env);
    expect(res.status).toBe(404);
  });

  it('404s on POST for an unknown driver', async () => {
    const h = harness({ drivers: [driverRow()] });
    const res = await h.app.request('/drivers/nope/photo', {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array([9]),
    }, h.env);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('driver_not_found');
  });

  it('refuses an empty upload', async () => {
    const h = harness({ drivers: [driverRow()] });
    const res = await h.app.request('/drivers/d1/photo', {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array([]),
    }, h.env);
    expect(res.status).toBe(400);
  });
});

describe('the list carries the profile columns', () => {
  it('returns photo_r2_key and licence fields in the row', async () => {
    const h = harness({ drivers: [driverRow({ photo_r2_key: 'driver/d1/x.png', license_no: 'L1' })] });
    const res = await h.app.request('/drivers', {}, h.env);
    const body = await res.json() as { drivers: Row[] };
    expect(body.drivers[0].photo_r2_key).toBe('driver/d1/x.png');
    expect(body.drivers[0].license_no).toBe('L1');
  });
});
