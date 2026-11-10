// The read confirmation must never break a scan: on a phone with neither
// vibration nor audio it does nothing, and it never throws into the loop.
import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('scanHitFeedback', () => {
  test('buzzes and plays one short tone', async () => {
    const vibrate = vi.fn();
    const start = vi.fn();
    const node = { connect: vi.fn(), start, stop: vi.fn(), type: '', frequency: { value: 0 },
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } };
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    vi.stubGlobal('AudioContext', class {
      state = 'running'; currentTime = 0; destination = {};
      createOscillator() { return node; }
      createGain() { return node; }
    });
    const { scanHitFeedback } = await import('./scan-feedback');
    scanHitFeedback();
    expect(vibrate).toHaveBeenCalledWith(60);
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('a phone with no vibration and a refused AudioContext is silent, not broken', async () => {
    vi.stubGlobal('navigator', { ...navigator, vibrate: undefined });
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('refused'); } });
    const { scanHitFeedback } = await import('./scan-feedback');
    expect(() => scanHitFeedback()).not.toThrow();
  });
});
