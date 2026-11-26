import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, type ReactNode, type ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const fetchSoItemPhotoSignedUrl = vi.fn();
const fetchSoItemPhotoBlob = vi.fn();

vi.mock('../lib/sales-order-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sales-order-queries')>();
  return {
    ...actual,
    useUploadSoItemPhoto: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteSoItemPhoto: () => ({ mutate: vi.fn(), isPending: false }),
    fetchSoItemPhotoSignedUrl: (...a: unknown[]) => fetchSoItemPhotoSignedUrl(...a),
    fetchSoItemPhotoBlob: (...a: unknown[]) => fetchSoItemPhotoBlob(...a),
  };
});

const { PhotoThumb } = await import('./SoLineCard');
const { PhotoProxyError } = await import('../lib/sales-order-queries');

const SIGNING_FAILED = Object.assign(
  new Error('signing_failed: R2_ACCESS_KEY_ID not configured'),
  { status: 500 },
);

const proxyPayload = (docNo: string, itemId: string, photoKey: string) => ({
  mode: 'proxy' as const,
  proxyPath: `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}`,
  thumbProxyPath: `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(`${photoKey}.thumb`)}`,
  expiresAt: null,
  reason: 'R2_ACCESS_KEY_ID not configured',
});

const photoBytes = () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' });

const DOC_NO = 'HC-SO-002609';
const ITEM_ID = 'b5712e8b-bf87-4b7f-8780-70b86464184e';

let revoked: string[] = [];
let minted = 0;

beforeEach(() => {
  revoked = [];
  minted = 0;
  fetchSoItemPhotoSignedUrl.mockReset();
  fetchSoItemPhotoBlob.mockReset();
  globalThis.URL.createObjectURL = vi.fn(() => `blob:obj-${++minted}`);
  globalThis.URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
});

afterEach(() => { vi.restoreAllMocks(); });

const MOUNTS: { name: string; wrapper?: ({ children }: { children: ReactNode }) => ReactElement }[] = [
  { name: 'bare' },
  {
    name: 'StrictMode',
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  },
];

describe.each(MOUNTS)('SO line photo tile — signing outage fallback [$name mount]', ({ name, wrapper }) => {
  const keyFor = (label: string) => `so-items/${name}/${label}.jpg`;

  const renderTile = (photoKey: string) =>
    render(
      <PhotoThumb
        photoKey={photoKey}
        docNo={DOC_NO}
        itemId={ITEM_ID}
        canDelete={false}
        onDelete={() => {}}
      />,
      { wrapper },
    );

  it('renders the photo through the proxy when the signing endpoint 500s', async () => {
    const photoKey = keyFor('outage');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    renderTile(photoKey);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:obj-1');
    expect(screen.queryByText('err')).toBeNull();
  });

  it('asks the proxy for the .thumb sibling, not the full-size object', async () => {
    const photoKey = keyFor('thumb-first');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    renderTile(photoKey);
    await screen.findByAltText('Line photo');

    expect(fetchSoItemPhotoBlob).toHaveBeenCalledWith(DOC_NO, ITEM_ID, `${photoKey}.thumb`);
    expect(fetchSoItemPhotoBlob).not.toHaveBeenCalledWith(DOC_NO, ITEM_ID, photoKey);
  });

  it('falls back to the full object when the thumb 404s', async () => {
    const photoKey = keyFor('pre-thumb');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockImplementation(async (_d: string, _i: string, key: string) => {
      if (key.endsWith('.thumb')) throw new PhotoProxyError(404, 'photo_not_found_in_r2');
      return photoBytes();
    });

    renderTile(photoKey);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:obj-1');
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledWith(DOC_NO, ITEM_ID, `${photoKey}.thumb`);
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledWith(DOC_NO, ITEM_ID, photoKey);
  });

  it('does not remember a timeout as a missing thumb', async () => {
    const photoKey = keyFor('stall');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockRejectedValue(
      new PhotoProxyError(408, 'The photo took too long to load — please try again.'),
    );

    const first = renderTile(photoKey);
    expect(await screen.findByText('err')).toBeTruthy();
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledTimes(1);
    first.unmount();

    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());
    renderTile(photoKey);
    await screen.findByAltText('Line photo');
    expect(fetchSoItemPhotoBlob).toHaveBeenLastCalledWith(DOC_NO, ITEM_ID, `${photoKey}.thumb`);
  });

  it('re-uses cached bytes on remount instead of re-streaming', async () => {
    const photoKey = keyFor('cached');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    const first = renderTile(photoKey);
    await screen.findByAltText('Line photo');
    const callsAfterFirstOpen = fetchSoItemPhotoBlob.mock.calls.length;
    first.unmount();

    renderTile(photoKey);
    await screen.findByAltText('Line photo');

    expect(fetchSoItemPhotoBlob.mock.calls.length).toBe(callsAfterFirstOpen);
  });

  it('still shows "err" when the photo is genuinely missing (proxy 404s too)', async () => {
    const photoKey = keyFor('deleted');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockRejectedValue(new PhotoProxyError(404, 'Not found'));

    renderTile(photoKey);

    expect(await screen.findByText('err')).toBeTruthy();
    expect(screen.queryByAltText('Line photo')).toBeNull();
  });

  it('still shows "err" when the proxy refuses the request (401)', async () => {
    const photoKey = keyFor('forbidden');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockRejectedValue(
      new PhotoProxyError(401, 'Your session has expired'),
    );

    renderTile(photoKey);

    expect(await screen.findByText('err')).toBeTruthy();
  });

  it('uses the signed URL directly and never touches the proxy when signing works', async () => {
    const photoKey = keyFor('healthy');
    fetchSoItemPhotoSignedUrl.mockResolvedValue({
      signedUrl: 'https://r2.example.com/full.jpg?sig=abc',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    renderTile(photoKey);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'https://r2.example.com/full.jpg?sig=abc');
    expect(fetchSoItemPhotoBlob).not.toHaveBeenCalled();
  });

  it('routes to the proxy when signing returns a non-absolute URL', async () => {
    const photoKey = keyFor('relative');
    fetchSoItemPhotoSignedUrl.mockResolvedValue({
      signedUrl: `/mfg-sales-orders/${DOC_NO}/items/x/photos/y`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    renderTile(photoKey);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:obj-1');
  });

  it('revokes the proxy blob on unmount so a photo grid does not leak', async () => {
    const photoKey = keyFor('leak');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    const { unmount } = renderTile(photoKey);
    await screen.findByAltText('Line photo');

    expect(revoked).toEqual([]);
    unmount();
    expect(revoked).toEqual(['blob:obj-1']);
    expect(minted).toBe(1);
  });

  it('renders through the proxy when /signed RESOLVES with the proxy payload', async () => {
    const photoKey = keyFor('proxy-payload');
    fetchSoItemPhotoSignedUrl.mockResolvedValue(proxyPayload(DOC_NO, ITEM_ID, photoKey));
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    renderTile(photoKey);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:obj-1');
    expect(screen.queryByText('err')).toBeNull();
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledWith(DOC_NO, ITEM_ID, `${photoKey}.thumb`);
  });

  it('never puts the proxy path in <img src>', async () => {
    const photoKey = keyFor('never-img-src');
    const payload = proxyPayload(DOC_NO, ITEM_ID, photoKey);
    fetchSoItemPhotoSignedUrl.mockResolvedValue(payload);
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    renderTile(photoKey);

    const img = await screen.findByAltText('Line photo');
    expect(img.getAttribute('src')).not.toBe(payload.proxyPath);
    expect(img.getAttribute('src')).not.toBe(payload.thumbProxyPath);
    expect(img.getAttribute('src')).toMatch(/^blob:/);
  });

  it('still prefers the signed arm when the payload carries mode: "signed"', async () => {
    const photoKey = keyFor('signed-mode');
    fetchSoItemPhotoSignedUrl.mockResolvedValue({
      mode: 'signed',
      signedUrl: 'https://r2.example.com/full.jpg?sig=xyz',
      thumbUrl: 'https://r2.example.com/full.jpg.thumb?sig=xyz',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    renderTile(photoKey);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'https://r2.example.com/full.jpg.thumb?sig=xyz');
    expect(fetchSoItemPhotoBlob).not.toHaveBeenCalled();
  });

  it('shows "err" when the proxy payload arrives but the bytes 404', async () => {
    const photoKey = keyFor('proxy-payload-missing');
    fetchSoItemPhotoSignedUrl.mockResolvedValue(proxyPayload(DOC_NO, ITEM_ID, photoKey));
    fetchSoItemPhotoBlob.mockRejectedValue(new PhotoProxyError(404, 'photo_not_found_in_r2'));

    renderTile(photoKey);

    expect(await screen.findByText('err')).toBeTruthy();
    expect(screen.queryByAltText('Line photo')).toBeNull();
  });

  it('fires no request when the tile has no document context', async () => {
    render(
      <PhotoThumb photoKey={keyFor('no-context')} canDelete={false} onDelete={() => {}} />,
      { wrapper },
    );

    await waitFor(() => {
      expect(fetchSoItemPhotoSignedUrl).not.toHaveBeenCalled();
    });
    expect(fetchSoItemPhotoBlob).not.toHaveBeenCalled();
    expect(screen.queryByAltText('Line photo')).toBeNull();
    expect(screen.queryByText('err')).toBeNull();
  });
});

describe('StrictMode double-invoke must not spend the live pass\'s proxy attempt', () => {
  it('renders the photo, streams it once, and leaves no orphaned blob', async () => {
    const photoKey = 'so-items/strict-repro/1.jpg';
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    render(
      <StrictMode>
        <PhotoThumb
          photoKey={photoKey}
          docNo={DOC_NO}
          itemId={ITEM_ID}
          canDelete={false}
          onDelete={() => {}}
        />
      </StrictMode>,
    );

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:obj-1');
    expect(screen.queryByText('err')).toBeNull();
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledTimes(1);
    expect(minted).toBe(1);
    expect(revoked).toEqual([]);
  });
});
