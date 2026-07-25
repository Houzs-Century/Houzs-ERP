import { describe, it, expect } from 'vitest';
import { buildDistanceMatrixUrl, parseDistanceMatrix } from './maps';

describe('buildDistanceMatrixUrl', () => {
  it('lists every point as both origin and destination', () => {
    const url = buildDistanceMatrixUrl(
      [{ lat: 3.1, lng: 101.7 }, { lat: 3.2, lng: 101.6 }],
      'KEY123',
    );
    // origins and destinations both carry the encoded "3.1,101.7|3.2,101.6".
    const enc = encodeURIComponent('3.1,101.7|3.2,101.6');
    expect(url).toContain(`origins=${enc}`);
    expect(url).toContain(`destinations=${enc}`);
    expect(url).toContain('region=my');
    expect(url).toContain('key=KEY123');
  });
});

describe('parseDistanceMatrix', () => {
  it('builds NxN duration/distance matrices with a zero diagonal', () => {
    const body = {
      status: 'OK',
      rows: [
        { elements: [
          { status: 'OK', duration: { value: 0 }, distance: { value: 0 } },
          { status: 'OK', duration: { value: 600 }, distance: { value: 5000 } },
        ] },
        { elements: [
          { status: 'OK', duration: { value: 660 }, distance: { value: 5200 } },
          { status: 'OK', duration: { value: 0 }, distance: { value: 0 } },
        ] },
      ],
    };
    const r = parseDistanceMatrix(body, 2);
    expect(r.ok).toBe(true);
    expect(r.durationSeconds).toEqual([[0, 600], [660, 0]]);
    expect(r.distanceMetres).toEqual([[0, 5000], [5200, 0]]);
  });

  it('treats a per-element non-OK as 0 rather than throwing', () => {
    const body = {
      status: 'OK',
      rows: [
        { elements: [
          { status: 'OK', duration: { value: 0 }, distance: { value: 0 } },
          { status: 'NOT_FOUND' },
        ] },
        { elements: [
          { status: 'ZERO_RESULTS' },
          { status: 'OK', duration: { value: 0 }, distance: { value: 0 } },
        ] },
      ],
    };
    const r = parseDistanceMatrix(body, 2);
    expect(r.ok).toBe(true);
    expect(r.durationSeconds[0][1]).toBe(0);
    expect(r.durationSeconds[1][0]).toBe(0);
  });

  it('returns ok:false on a top-level non-OK status', () => {
    expect(parseDistanceMatrix({ status: 'REQUEST_DENIED' }, 2).ok).toBe(false);
  });
});
