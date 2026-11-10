import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { scmAreaGuard } from '../middleware/area-guard';
import { isTripLocationPing, pingCallerAllowed } from './tripLocation';
import type { DeliveryScope } from './deliveryScope';
import type { Env, Variables } from '../env';

/*
 * Production, 7 days: POST /trips/:id/location was refused 403 415 times for 7
 * users, so drivers vanished from the Lorry Live Map. A Driver / Helper holds
 * view on scm.transportation.drivers (enough for GET /trips, which shows them
 * their own IN_PROGRESS trip) but the area guard asked `edit` for the ping.
 * These pin the fix: the guard lets ONLY the ping through without the level,
 * and the handler accepts a bypassed caller only on a trip they are crewed on.
 */

const AREA = 'scm.transportation.drivers';
const driver = {
  permissions: ['scm.access'],
  scm_l2_configured: true,
  page_access: { [AREA]: 'view' },
};

function guarded(method: string, path: string) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', driver as unknown as Variables['user']);
    await next();
  });
  app.use('/api/scm/trips/*', scmAreaGuard(AREA, { writeBypass: (c) => isTripLocationPing(c.req.method, c.req.path) }));
  app.all('/api/scm/trips/*', (c) => c.json({ bypassed: c.get('scmWriteBypassed') === true }));
  return app.request(path, { method });
}

describe('trip location ping — area guard', () => {
  it('a driver with view reaches the ping handler, flagged as bypassed', async () => {
    const res = await guarded('POST', '/api/scm/trips/7f0c/location');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bypassed: true });
  });

  it('every other trips write still needs edit', async () => {
    expect((await guarded('POST', '/api/scm/trips/7f0c/stops')).status).toBe(403);
    expect((await guarded('PATCH', '/api/scm/trips/7f0c')).status).toBe(403);
    expect((await guarded('POST', '/api/scm/trips/7f0c/location/extra')).status).toBe(403);
  });

  it('isTripLocationPing is POST + exactly /trips/:id/location', () => {
    expect(isTripLocationPing('POST', '/api/scm/trips/abc/location')).toBe(true);
    expect(isTripLocationPing('GET', '/api/scm/trips/abc/location')).toBe(false);
    expect(isTripLocationPing('POST', '/api/scm/trips/abc/locations/latest')).toBe(false);
  });
});

describe('trip location ping — pingCallerAllowed', () => {
  const crew = { driverIds: ['d1'], helperIds: ['h1', null] };
  const self = (d: string[], h: string[]): DeliveryScope => ({ mode: 'self', driverIds: new Set(d), helperIds: new Set(h) });

  it('a bypassed driver or helper crewed on the trip is accepted', () => {
    expect(pingCallerAllowed(self(['d1'], []), crew, true)).toBe(true);
    expect(pingCallerAllowed(self([], ['h1']), crew, true)).toBe(true);
  });

  it('a bypassed caller on someone else\'s trip is refused', () => {
    expect(pingCallerAllowed(self(['d2'], []), crew, true)).toBe(false);
  });

  it('a bypassed caller on the whole-board scope is refused (no area level, not crew)', () => {
    expect(pingCallerAllowed({ mode: 'all' }, crew, true)).toBe(false);
  });

  it('a caller who passed the guard on edit keeps today\'s behaviour', () => {
    expect(pingCallerAllowed({ mode: 'all' }, crew, false)).toBe(true);
    expect(pingCallerAllowed(self(['d2'], []), crew, false)).toBe(false);
  });
});
