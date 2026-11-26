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

    const res = logoResponse('2990');
    correlatedFetch.mockResolvedValue(res);
    await m.ensureBrandingLogoLoaded();

    expect(m.getBrandingLogoCache()).toBeNull();
    expect(res.blob).not.toHaveBeenCalled();
    expect(String(correlatedFetch.mock.calls[0]?.[0]))
      .toContain(`k=${encodeURIComponent('branding/houzs-logo-1.png')}`);
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
    const cached = m.getBrandingLogoCache();
    expect(cached?.key).toBe('branding/houzs-print-logo-2.png');
    expect(cached?.company).toBe('HOUZS');
    const url = String(correlatedFetch.mock.calls[0]?.[0]);
    expect(url).toContain('variant=print');
    expect(url).toContain(`k=${encodeURIComponent('branding/houzs-print-logo-2.png')}`);
  });
});
