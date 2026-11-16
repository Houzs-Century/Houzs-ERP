import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { itrackSignature, parseTrack, pollItrack } from './itrack-poll';

describe('itrackSignature', () => {
  it('is md5(md5(password) + time), lower-case hex (worked example in the iTrack doc, 2.1)', () => {
    expect(itrackSignature('Abc@34590', 1556243443)).toBe('3844afd2c3bf68f0f3f4aa0a9ee8ee6c');
  });
});

// Shape from the iTrack doc's /api/track demo (2.2).
const rec = {
  imei: '358899123456789', course: 195, gpstime: 1419906052, speed: 40,
  longitude: 101.886634, latitude: 2.703637, accstatus: 1, datastatus: 2,
};

describe('parseTrack', () => {
  const plates = new Map([['358899123456789', 'VRH 9058']]);

  it('maps a track record to a fix with the device plate (normalized), tagged device id and ISO gps time', () => {
    expect(parseTrack({ record: [rec] }, plates)).toEqual({
      fixes: [{
        deviceId: 'itrack:358899123456789', plate: 'VRH9058', lat: 2.703637, lng: 101.886634,
        speedKmh: 40, heading: 195, ignition: true, street: null,
        recordedAt: new Date(1419906052 * 1000).toISOString(),
      }],
      noPlate: [],
    });
  });

  it('maps ACC off to ignition false and "no ACC status" to null', () => {
    expect(parseTrack({ record: [{ ...rec, accstatus: 0 }] }, plates).fixes[0].ignition).toBe(false);
    expect(parseTrack({ record: [{ ...rec, accstatus: -1 }] }, plates).fixes[0].ignition).toBeNull();
  });

  it('reports a device with no plate on iTrack instead of guessing a lorry', () => {
    expect(parseTrack({ record: [{ ...rec, imei: '1' }] }, plates)).toEqual({ fixes: [], noPlate: ['1'] });
  });

  it('drops never-online devices, missing or bad positions and missing gps time', () => {
    const bad = [
      { ...rec, gpstime: 0 },
      { ...rec, latitude: undefined },
      { ...rec, latitude: 99.5 },
      { ...rec, datastatus: 1 },
    ];
    expect(parseTrack({ record: bad }, plates).fixes).toEqual([]);
    expect(parseTrack(null, plates).fixes).toEqual([]);
  });
});

describe('pollItrack token cache', () => {
  const kvStore = new Map<string, string>();
  const kv = {
    get: async (k: string) => kvStore.get(k) ?? null,
    put: async (k: string, v: string) => { kvStore.set(k, v); },
    delete: async (k: string) => { kvStore.delete(k); },
  };
  const env = { ITRACK_ACCOUNT: 'acc', ITRACK_PASSWORD: 'pw', SESSION_CACHE: kv } as unknown as Env;
  const ok = (body: unknown) => new Response(JSON.stringify({ code: 0, ...body as object }));

  afterEach(() => { vi.unstubAllGlobals(); kvStore.clear(); });

  it('logs in once, reuses the cached token, and drops it when a call fails', async () => {
    const paths: string[] = [];
    let trackFails = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/api/authorization') return ok({ record: { access_token: 'T1', expires_in: 7200 } });
      if (path === '/api/device/list') return ok({ record: [{ imei: '1', platenumber: '' }] });
      return trackFails ? new Response(JSON.stringify({ code: 10011 })) : ok({ record: [{ ...rec, imei: '1' }] });
    }));

    expect(await pollItrack(env)).toEqual({ devices: 0, stored: 0, unmatched: [], noPlate: ['1'] });
    await pollItrack(env);
    expect(paths.filter((p) => p === '/api/authorization')).toHaveLength(1);

    trackFails = true;
    await expect(pollItrack(env)).rejects.toThrow('itrack /api/track -> code 10011');
    expect(kvStore.size).toBe(0);
  });

  it('is a no-op without the two secrets', async () => {
    expect(await pollItrack({} as Env)).toEqual({ skipped: true });
  });
});
