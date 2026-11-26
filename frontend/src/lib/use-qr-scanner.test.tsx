import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useQrScanner } from './use-qr-scanner';

let frames: string[] = [];
let pending: FrameRequestCallback[] = [];
let now = 0;

function Harness({ onDecoded }: { onDecoded: (v: string) => void }) {
  const s = useQrScanner(onDecoded);
  return (
    <div>
      <video ref={s.videoRef} data-testid="v" />
      <button onClick={() => void s.start()}>start</button>
    </div>
  );
}

async function tickFrames(n: number, msPerFrame = 100) {
  for (let i = 0; i < n; i += 1) {
    const cb = pending.pop();
    pending = [];
    if (!cb) return;
    now += msPerFrame;
    await act(async () => {
      cb(now);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  frames = [];
  pending = [];
  now = 0;

  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.push(cb);
    return pending.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});

  vi.stubGlobal(
    'BarcodeDetector',
    class {
      async detect() {
        const v = frames.shift();
        return v ? [{ rawValue: v, format: 'qr_code' }] : [];
      }
    },
  );

  const track = { stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: vi.fn() };
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getVideoTracks: () => [track], getTracks: () => [track] })) },
  });

  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, value: 1280 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, value: 720 });
  Object.defineProperty(HTMLVideoElement.prototype, 'readyState', { configurable: true, value: 4 });
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
});

afterEach(() => vi.unstubAllGlobals());

describe('the camera keeps decoding', () => {
  test('three different codes in a row all arrive — the loop does not stop on a hit', async () => {
    const got: string[] = [];
    const { getByText } = render(<Harness onDecoded={(v) => got.push(v)} />);
    await act(async () => { getByText('start').click(); });

    frames = ['https://x/d/' + 'a'.repeat(64), 'https://x/d/' + 'b'.repeat(64), 'https://x/d/' + 'c'.repeat(64)];
    await tickFrames(3);

    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
  });

  test('a paper HELD in front of the lens adds exactly once', async () => {
    const got: string[] = [];
    const { getByText } = render(<Harness onDecoded={(v) => got.push(v)} />);
    await act(async () => { getByText('start').click(); });

    const one = 'https://x/d/' + 'a'.repeat(64);
    frames = Array.from({ length: 10 }, () => one);
    await tickFrames(10, 100);
    expect(got).toEqual([one]);

    frames = [one];
    await tickFrames(1, 2000);
    expect(got).toEqual([one, one]);
  });

  test('a frame with nothing in it is not an event', async () => {
    const got: string[] = [];
    const { getByText } = render(<Harness onDecoded={(v) => got.push(v)} />);
    await act(async () => { getByText('start').click(); });
    frames = [];
    await tickFrames(5);
    expect(got).toEqual([]);
    expect(pending.length).toBeGreaterThan(0);
  });
});

function StatusHarness() {
  const s = useQrScanner(() => {});
  return (
    <div>
      <video ref={s.videoRef} />
      <button onClick={() => void s.start()}>start</button>
      <button onClick={() => s.stop()}>stop</button>
    </div>
  );
}

function stubCamera(getUserMedia: () => Promise<unknown>) {
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn(getUserMedia) } });
}

describe('the camera is released', () => {
  test('closing the page stops every track', async () => {
    const track = { stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: vi.fn() };
    stubCamera(async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }));
    const { getByText, unmount } = render(<StatusHarness />);
    await act(async () => { getByText('start').click(); });
    expect(track.stop).not.toHaveBeenCalled();
    unmount();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  test('a camera that answers AFTER the scanner closed is stopped, not kept', async () => {
    const track = { stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: vi.fn() };
    let answer: (v: unknown) => void = () => {};
    stubCamera(() => new Promise((r) => { answer = r; }));
    const { getByText, unmount } = render(<StatusHarness />);
    act(() => { getByText('start').click(); });
    unmount();
    await act(async () => { answer({ getVideoTracks: () => [track], getTracks: () => [track] }); });
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  test('a second tap while the camera is still opening does not open a second one', async () => {
    const track = { stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: vi.fn() };
    let answer: (v: unknown) => void = () => {};
    const gum = vi.fn(() => new Promise((r) => { answer = r; }));
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: gum } });
    const { getByText } = render(<StatusHarness />);
    act(() => { getByText('start').click(); getByText('start').click(); });
    await act(async () => { answer({ getVideoTracks: () => [track], getTracks: () => [track] }); });
    expect(gum).toHaveBeenCalledTimes(1);
  });
});

describe('a read confirms itself', () => {
  test('vibrates once per physical scan, not once per frame', async () => {
    const vibrate = vi.fn();
    const track = { stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: vi.fn() };
    vi.stubGlobal('navigator', {
      ...navigator, vibrate,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getVideoTracks: () => [track], getTracks: () => [track] })) },
    });
    const { getByText } = render(<Harness onDecoded={() => {}} />);
    await act(async () => { getByText('start').click(); });
    frames = Array.from({ length: 6 }, () => 'HZRACK:L1.1');
    await tickFrames(6, 100);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});
