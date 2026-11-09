import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chunkKey, chunkPoints, chunkUrl, decodePolyline, drivenPoints, parseChunkRoad, roadTrack, type ChunkCache, type Point,
} from '../src/scm/lib/gps-road-track';

const fix = (lat: number, lng: number, min: number) => ({ lat, lng, recorded_at: new Date(Date.UTC(2026, 10, 9, 1, min)).toISOString() });

function memCache(): ChunkCache & { store: Map<string, Point[] | null> } {
  const store = new Map<string, Point[] | null>();
  return { store, async get(k) { return store.has(k) ? store.get(k)! : undefined; }, async put(k, v) { store.set(k, v); } };
}

const okBody = (polyline: string, distanceM: number) => ({
  status: 'OK',
  routes: [{ legs: [{ distance: { value: distanceM }, steps: [{ polyline: { points: polyline } }] }] }],
});

afterEach(() => vi.unstubAllGlobals());

describe('the driven path along the roads', () => {
  it('drops parked drift and GPS jumps, keeps the drive in time order', () => {
    const pts = drivenPoints([
      fix(3.1, 101.6, 10),
      fix(3.0, 101.5, 0),
      fix(3.0001, 101.5001, 5), // parked: a few metres
      fix(5.4, 100.3, 15), // Penang five minutes later: a jump
    ]);
    expect(pts).toEqual([{ lat: 3.0, lng: 101.5 }, { lat: 3.1, lng: 101.6 }]);
  });

  it('chunks share their joining point so the line has no gaps', () => {
    const pts = Array.from({ length: 12 }, (_, i) => ({ lat: i, lng: i }));
    const chunks = chunkPoints(pts, 5);
    expect(chunks.map((c) => c.length)).toEqual([5, 5, 4]);
    expect(chunks[0].at(-1)).toEqual(chunks[1][0]);
    expect(chunkPoints([{ lat: 1, lng: 1 }])).toEqual([]);
  });

  it('asks Google to pass through the middle fixes, not stop at them', () => {
    const url = chunkUrl([{ lat: 3, lng: 101 }, { lat: 3.01, lng: 101.01 }, { lat: 3.02, lng: 101.02 }], 'K');
    expect(url).toContain('origin=3.00000,101.00000');
    expect(url).toContain('destination=3.02000,101.02000');
    expect(url).toContain(`waypoints=${encodeURIComponent('via:3.01000,101.01000')}`);
  });

  it('decodes Google polylines (the documented example)', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      { lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 },
    ]);
  });

  it('a road far longer than the drive is a detour Google invented, not the drive', () => {
    const chunk = [{ lat: 3, lng: 101 }, { lat: 3.01, lng: 101 }]; // ~1.1 km apart
    expect(parseChunkRoad(okBody('_p~iF~ps|U_ulLnnqC', 2000), chunk)).toHaveLength(2);
    expect(parseChunkRoad(okBody('_p~iF~ps|U_ulLnnqC', 9000), chunk)).toBeNull();
    expect(parseChunkRoad({ status: 'ZERO_RESULTS', routes: [] }, chunk)).toBeNull();
  });

  it('no Google key: straight between fixes, no call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await roadTrack({}, [fix(3, 101, 0), fix(3.01, 101, 5)], memCache());
    expect(f).not.toHaveBeenCalled();
    expect(r).toEqual({ path: [{ lat: 3, lng: 101 }, { lat: 3.01, lng: 101 }], chunks: 1, roadChunks: 0 });
  });

  it('draws the road, and the next poll reads it back instead of asking Google again', async () => {
    const road = [{ lat: 3, lng: 101 }, { lat: 3.005, lng: 101.001 }, { lat: 3.01, lng: 101 }];
    const encoded = '_}hQ_qmgRg^gEg^fE'; // the three points above
    expect(decodePolyline(encoded)).toEqual(road);
    const f = vi.fn(async () => new Response(JSON.stringify(okBody(encoded, 1300))));
    vi.stubGlobal('fetch', f);
    const cache = memCache();
    const fixes = [fix(3, 101, 0), fix(3.01, 101, 5)];
    expect(await roadTrack({ GOOGLE_MAPS_API_KEY: 'K' }, fixes, cache)).toEqual({ path: road, chunks: 1, roadChunks: 1 });
    expect(await roadTrack({ GOOGLE_MAPS_API_KEY: 'K' }, fixes, cache)).toEqual({ path: road, chunks: 1, roadChunks: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('Google failing leaves that stretch straight, with no error, and is asked again later', async () => {
    const f = vi.fn(async () => { throw new Error('timeout'); });
    vi.stubGlobal('fetch', f);
    const cache = memCache();
    const fixes = [fix(3, 101, 0), fix(3.01, 101, 5)];
    const r = await roadTrack({ GOOGLE_MAPS_API_KEY: 'K' }, fixes, cache);
    expect(r).toEqual({ path: [{ lat: 3, lng: 101 }, { lat: 3.01, lng: 101 }], chunks: 1, roadChunks: 0 });
    expect(cache.store.size).toBe(0);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'OVER_QUERY_LIMIT' }))));
    await roadTrack({ GOOGLE_MAPS_API_KEY: 'K' }, fixes, cache);
    expect(cache.store.size).toBe(0);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ZERO_RESULTS', routes: [] }))));
    await roadTrack({ GOOGLE_MAPS_API_KEY: 'K' }, fixes, cache);
    expect(cache.store.get(chunkKey(drivenPoints(fixes)))).toBeNull();
  });
});
