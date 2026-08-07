// The letterhead logo memo is keyed by R2 key alone, which cannot say WHOSE
// image arrived. If the active company ever moves under the fetch, one
// company's mark is filed under the other's key and prints on that company's
// documents for the rest of the session — a Houzs delivery order headed by the
// 2990 mark, with nothing anywhere reporting a problem.
//
// The server now names the company it served (x-company-code). These pin the
// client half: a mismatch is refused BEFORE the bytes are read, an absent
// header is not treated as a mismatch, and a match caches normally.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const correlatedFetch = vi.fn();

vi.mock('./requestCorrelation', () => ({
  correlatedFetch: (...args: unknown[]) => correlatedFetch(...args),
  consumeCorrelated: async (_res: unknown, fn: () => Promise<unknown>) => fn(),
  correlateError: (e: Error) => e,
  requestIdFromResponse: () => null,
}));
vi.mock('../api/client', () => ({
  api: { baseUrl: 'https://api.test' },
  tokenStore: { get: () => 'token' },
}));
vi.mock('./activeCompany', () => ({ companyHeader: () => ({ 'X-Company-Id': '2' }) }));

/** A logo response that claims to belong to `company` (null = no header, i.e.
 *  an older worker or a proxy that dropped it). `blob` records whether the body
 *  was ever read — the guard must short-circuit before that. */
function logoResponse(company: string | null) {
  const blob = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'x-company-code' ? company : null) },
    blob,
  };
}

async function freshModule() {
  vi.resetModules();
  return import('./branding');
}

/* jsdom neither decodes an image nor reports a failure — `new Image()` fires
   NEITHER onload nor onerror for a data URL, so the module's dimension probe
   would hang forever. This stand-in resolves it immediately, at a size small
   enough that the letterhead downscale (which needs a real canvas) is skipped. */
class StubImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 120;
  naturalHeight = 48;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  correlatedFetch.mockReset();
  vi.stubGlobal('Image', StubImage);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the letterhead logo refuses another company', () => {
  test('a mismatch is refused before the bytes are even read', async () => {
    const m = await freshModule();
    m.setBrandingCache(
      { ...m.DEFAULT_BRANDING, logoR2Key: 'branding/houzs-logo-1.png', printLogoR2Key: '' },
      'HOUZS',
    );

    const res = logoResponse('2990'); // the other company's bytes
    correlatedFetch.mockResolvedValue(res);
    await m.ensureBrandingLogoLoaded();

    // Nothing cached, so the letterhead falls back to text-only: a poorer
    // document, but still this company's document.
    expect(m.getBrandingLogoCache()).toBeNull();
    // And it failed on the HEADER, not on some later decode step — otherwise
    // this test would pass for the wrong reason.
    expect(res.blob).not.toHaveBeenCalled();
  });

  test('no header is not a mismatch — the guard tightens a failure, it must not invent one', async () => {
    const m = await freshModule();
    m.setBrandingCache(
      { ...m.DEFAULT_BRANDING, logoR2Key: 'branding/houzs-logo-1.png', printLogoR2Key: '' },
      'HOUZS',
    );

    const res = logoResponse(null);
    correlatedFetch.mockResolvedValue(res);
    await m.ensureBrandingLogoLoaded();

    // The body IS read and the logo caches — the request proceeds exactly as it
    // did before this guard existed.
    expect(res.blob).toHaveBeenCalled();
    expect(m.getBrandingLogoCache()).not.toBeNull();
  });

  test('a matching company is accepted and the request carries the print variant', async () => {
    const m = await freshModule();
    m.setBrandingCache(
      {
        ...m.DEFAULT_BRANDING,
        logoR2Key: 'branding/houzs-logo-1.png',
        printLogoR2Key: 'branding/houzs-print-logo-2.png',
      },
      'HOUZS',
    );

    const res = logoResponse('HOUZS');
    correlatedFetch.mockResolvedValue(res);
    await m.ensureBrandingLogoLoaded();

    expect(res.blob).toHaveBeenCalled();
    // Cached, and stamped with the company it was served for.
    const cached = m.getBrandingLogoCache();
    expect(cached?.key).toBe('branding/houzs-print-logo-2.png');
    expect(cached?.company).toBe('HOUZS');
    // The print slot is set, so the fetch must ask for it — otherwise the sheet
    // would carry the on-screen artwork.
    expect(String(correlatedFetch.mock.calls[0]?.[0])).toContain('?variant=print');
  });
});
