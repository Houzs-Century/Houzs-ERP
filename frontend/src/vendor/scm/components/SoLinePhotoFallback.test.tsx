/* The 2026-08-10 photo outage, as a test.
 *
 * Production returned 500 {"error":"signing_failed","reason":"R2_ACCESS_KEY_ID
 * not configured"} for EVERY SO line photo, because the R2 S3-API credentials
 * were never provisioned as wrangler secrets. Every tile rendered the literal
 * text "err" — while the very same photos loaded fine through the authed proxy
 * route, which needs no credentials at all (it uses the Worker's R2 binding).
 *
 * These tests pin the three behaviours that outage exposed:
 *   1. signing 500 must NOT show "err" if the proxy can serve the photo
 *   2. "err" must SURVIVE for a genuinely-missing photo (proxy 404) — losing
 *      the error state would be a regression, not a fix
 *   3. a line with no photos must render nothing and fire NO request
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchSoItemPhotoSignedUrl = vi.fn();
const fetchSoItemPhotoBlobUrl = vi.fn();

/* Only the two network helpers are faked; the tile's real decision logic —
   which is what regressed — runs untouched. isDirectlyLoadableUrl keeps its
   real implementation. */
vi.mock('../lib/sales-order-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sales-order-queries')>();
  return {
    ...actual,
    useUploadSoItemPhoto: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteSoItemPhoto: () => ({ mutate: vi.fn(), isPending: false }),
    fetchSoItemPhotoSignedUrl: (...a: unknown[]) => fetchSoItemPhotoSignedUrl(...a),
    fetchSoItemPhotoBlobUrl: (...a: unknown[]) => fetchSoItemPhotoBlobUrl(...a),
  };
});

const { PhotoThumb } = await import('./SoLineCard');

const SIGNING_FAILED = Object.assign(
  new Error('signing_failed: R2_ACCESS_KEY_ID not configured'),
  { status: 500 },
);

let revoked: string[] = [];

beforeEach(() => {
  revoked = [];
  fetchSoItemPhotoSignedUrl.mockReset();
  fetchSoItemPhotoBlobUrl.mockReset();
  // jsdom implements neither of these.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-object-url');
  globalThis.URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
});

afterEach(() => { vi.restoreAllMocks(); });

const renderTile = (photoKey = 'so-items/abc/photo-1.jpg') =>
  render(
    <PhotoThumb
      photoKey={photoKey}
      docNo="HC-SO-002609"
      itemId="b5712e8b-bf87-4b7f-8780-70b86464184e"
      canDelete={false}
      onDelete={() => {}}
    />,
  );

describe('SO line photo tile — signing outage fallback', () => {
  it('renders the photo through the proxy when the signing endpoint 500s', async () => {
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlobUrl.mockResolvedValue('blob:proxied-photo');

    renderTile();

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:proxied-photo');
    // The regression this whole PR exists to kill.
    expect(screen.queryByText('err')).toBeNull();
    expect(fetchSoItemPhotoBlobUrl).toHaveBeenCalledWith(
      'HC-SO-002609',
      'b5712e8b-bf87-4b7f-8780-70b86464184e',
      'so-items/abc/photo-1.jpg',
    );
  });

  it('still shows "err" when the photo is genuinely missing (proxy 404s too)', async () => {
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlobUrl.mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404 }),
    );

    renderTile('so-items/abc/deleted.jpg');

    expect(await screen.findByText('err')).toBeTruthy();
    expect(screen.queryByAltText('Line photo')).toBeNull();
  });

  it('still shows "err" when the proxy refuses the request (401)', async () => {
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlobUrl.mockRejectedValue(
      Object.assign(new Error('Your session has expired'), { status: 401 }),
    );

    renderTile('so-items/abc/forbidden.jpg');

    expect(await screen.findByText('err')).toBeTruthy();
  });

  it('uses the signed URL directly and never touches the proxy when signing works', async () => {
    fetchSoItemPhotoSignedUrl.mockResolvedValue({
      signedUrl: 'https://r2.example.com/full.jpg?sig=abc',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    renderTile('so-items/abc/healthy.jpg');

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'https://r2.example.com/full.jpg?sig=abc');
    expect(fetchSoItemPhotoBlobUrl).not.toHaveBeenCalled();
  });

  /* The upload route's own signing-failure fallback returns a RELATIVE proxy
     path. Handed to <img src> it resolves against the SPA origin (no /api/scm
     prefix) and 404s, so it must be treated as "signing did not succeed". */
  it('routes to the proxy when signing returns a non-absolute URL', async () => {
    fetchSoItemPhotoSignedUrl.mockResolvedValue({
      signedUrl: '/mfg-sales-orders/HC-SO-002609/items/x/photos/y',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    fetchSoItemPhotoBlobUrl.mockResolvedValue('blob:proxied-relative');

    renderTile('so-items/abc/relative.jpg');

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:proxied-relative');
  });

  it('revokes the proxy blob on unmount so a photo grid does not leak', async () => {
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlobUrl.mockResolvedValue('blob:leaky-photo');

    const { unmount } = renderTile('so-items/abc/leak.jpg');
    await screen.findByAltText('Line photo');

    expect(revoked).toEqual([]);
    unmount();
    expect(revoked).toEqual(['blob:leaky-photo']);
  });

  it('fires no request when the tile has no document context', async () => {
    render(
      <PhotoThumb photoKey="k" canDelete={false} onDelete={() => {}} />,
    );

    await waitFor(() => {
      expect(fetchSoItemPhotoSignedUrl).not.toHaveBeenCalled();
    });
    expect(fetchSoItemPhotoBlobUrl).not.toHaveBeenCalled();
    expect(screen.queryByAltText('Line photo')).toBeNull();
    expect(screen.queryByText('err')).toBeNull();
  });
});
