import { describe, expect, it } from 'vitest';
import { drivenPath } from './lorry-road-track';

const fixes = [{ lat: 3, lng: 101 }, { lat: 3.01, lng: 101 }];

describe('drivenPath', () => {
  it('draws the road the server sent', () => {
    const path = [{ lat: 3, lng: 101 }, { lat: 3.005, lng: 101.001 }, { lat: 3.01, lng: 101 }];
    expect(drivenPath({ date: '2026-11-09', path, chunks: 1, roadChunks: 1 }, fixes)).toEqual({ path, byRoad: true });
  });
  it('says so when no stretch could be put on a road', () => {
    expect(drivenPath({ date: '2026-11-09', path: fixes, chunks: 1, roadChunks: 0 }, fixes)).toEqual({ path: fixes, byRoad: false });
  });
  it('falls back to the fixes joined straight while the road is loading or failed', () => {
    expect(drivenPath(undefined, fixes)).toEqual({ path: fixes, byRoad: false });
    expect(drivenPath({ date: '2026-11-09', path: [], chunks: 0, roadChunks: 0 }, fixes)).toEqual({ path: fixes, byRoad: false });
  });
});
