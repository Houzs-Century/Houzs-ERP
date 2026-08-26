// ----------------------------------------------------------------------------
// THE FIRST PAPER SETS THE RUNG, and a paper on a different rung is not let in.
//
// The owner, 2026-08-27: 「不同状态你就不要给它扫描进来吧，就当做它还没扫描到。
// 同样的东西不能在不同状态下重复扫描。它应该根据第一个状态来扫描。」
//
// 「就当做它还没扫描到」 is the load-bearing half and it is what these tests are
// about: a refused scan must leave the basket EXACTLY as it was — the row gone,
// the count unchanged, and the token free to be scanned again later in a pile it
// does belong to. A version that added the row and greyed it out would satisfy a
// looser reading and would still be wrong.
//
// Driven through the real component with the camera stubbed: the decode callback
// is captured from useQrScanner, so what the test feeds is exactly what a scan
// feeds.
// ----------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

/** The decode callback the component handed to the scanner hook. */
let decode: ((v: string) => void) | null = null;

vi.mock('../lib/use-qr-scanner', () => ({
  useQrScanner: (onDecoded: (v: string) => void) => {
    decode = onDecoded;
    return {
      scanning: true, cameraError: null, torchSupported: false, torchOn: false,
      videoRef: { current: null }, start: async () => {}, stop: () => {}, toggleTorch: async () => {},
    };
  },
}));

const { PublicDoScanBasket } = await import('./PublicDoScanBasket');

const TOK = (c: string) => c.repeat(64);
const url = (c: string) => `https://erp.houzscentury.com/d/${TOK(c)}`;

/** What the lookup endpoint will answer, keyed by token. */
let answers: Record<string, unknown> = {};

beforeEach(() => {
  decode = null;
  answers = {};
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { tokens?: string[] };
    const t = body.tokens?.[0] ?? '';
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ lines: [answers[t]] }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

const line = (token: string, doNumber: string, status: string, step: string | null, label = '') => ({
  token, doNumber, customerName: 'A Customer', area: 'Klang', status,
  step: step ? { status: step, label, note: 'note' } : null,
  blockReason: step ? null : 'This delivery order is on hold, so it must not move.',
});

async function open() {
  render(<PublicDoScanBasket />);
  await act(async () => { screen.getByText('Scan several delivery orders').click(); });
}
async function scan(c: string) {
  await act(async () => { decode!(url(c)); await Promise.resolve(); await Promise.resolve(); });
}

describe('the pile is uniform by construction', () => {
  test('a paper on a DIFFERENT rung is not added at all', async () => {
    answers[TOK('a')] = line(TOK('a'), 'HC-DO-1', 'LOADED', 'DISPATCHED', 'Confirm Loaded');
    answers[TOK('b')] = line(TOK('b'), 'HC-DO-2', 'IN_TRANSIT', 'DELIVERED', 'Confirm Delivered');

    await open();
    await scan('a');
    expect(screen.getByText('Scanned: 1')).toBeTruthy();

    await scan('b');
    /* 「就当做它还没扫描到」 — the count did not move and the row is not there. */
    expect(screen.getByText('Scanned: 1')).toBeTruthy();
    expect(screen.queryByText('HC-DO-2')).toBeNull();
    /* And it is NAMED. An operator scanning with nothing happening decides the
       scanner is broken. */
    expect(screen.getByText(/HC-DO-2 was not added/)).toBeTruthy();
  });

  test('a second paper on the SAME rung is added', async () => {
    answers[TOK('a')] = line(TOK('a'), 'HC-DO-1', 'LOADED', 'DISPATCHED', 'Confirm Loaded');
    answers[TOK('b')] = line(TOK('b'), 'HC-DO-2', 'LOADED', 'DISPATCHED', 'Confirm Loaded');
    await open();
    await scan('a');
    await scan('b');
    expect(screen.getByText('Scanned: 2')).toBeTruthy();
    expect(screen.getByText('HC-DO-2')).toBeTruthy();
  });

  test('exactly ONE button, and its words come from the rung', async () => {
    answers[TOK('a')] = line(TOK('a'), 'HC-DO-1', 'LOADED', 'DISPATCHED', 'Confirm Loaded');
    await open();
    await scan('a');
    /* Not three buttons to choose from — the pile has one next rung. */
    expect(screen.getByText('Confirm Loaded (1)')).toBeTruthy();
    expect(screen.queryByText(/Confirm Delivered/)).toBeNull();
    expect(screen.queryByText(/Confirm Departure/)).toBeNull();
  });

  test('a held paper is refused with the ladder own sentence', async () => {
    answers[TOK('a')] = line(TOK('a'), 'HC-DO-1', 'LOADED', 'DISPATCHED', 'Confirm Loaded');
    answers[TOK('b')] = line(TOK('b'), 'HC-DO-2', 'LOADED', null);
    await open();
    await scan('a');
    await scan('b');
    expect(screen.getByText('Scanned: 1')).toBeTruthy();
    expect(screen.getByText(/on hold/)).toBeTruthy();
  });

  test('emptying the basket releases the rung, so the next pile may be a different one', async () => {
    answers[TOK('a')] = line(TOK('a'), 'HC-DO-1', 'LOADED', 'DISPATCHED', 'Confirm Loaded');
    answers[TOK('b')] = line(TOK('b'), 'HC-DO-2', 'IN_TRANSIT', 'DELIVERED', 'Confirm Delivered');
    await open();
    await scan('a');
    await act(async () => { screen.getByText('Clear the list').click(); });

    /* The paper refused a moment ago is now the FIRST one in, and sets the rung
       itself. Without the release a storekeeper would have to reload the page
       between piles. */
    await scan('b');
    expect(screen.getByText('Scanned: 1')).toBeTruthy();
    expect(screen.getByText('Confirm Delivered (1)')).toBeTruthy();
  });
});
