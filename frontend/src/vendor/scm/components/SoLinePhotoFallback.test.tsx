/* The 2026-08-10 photo outage, as a test.
 *
 * Production returned 500 {"error":"signing_failed","reason":"R2_ACCESS_KEY_ID
 * not configured"} for EVERY SO line photo, because the R2 S3-API credentials
 * were never provisioned as wrangler secrets. Every tile rendered the literal
 * text "err" — while the very same photos loaded fine through the authed proxy
 * route, which needs no credentials at all (it uses the Worker's R2 binding).
 *
 * EVERY CASE RUNS TWICE: bare, and wrapped in <StrictMode>.
 *
 * That is not thoroughness for its own sake. The first version of this fix
 * passed a 7-test suite that rendered PhotoThumb bare — a mount configuration
 * the real app never uses — and still showed "err" in production, because the
 * app mounts under <React.StrictMode> (main.tsx:228) and StrictMode's dev
 * double-invoke ran the effect, cleaned it up, and re-ran it. The discarded
 * first pass burned a component-lifetime one-shot guard, so the live second
 * pass took the error branch. Green CI, broken screen. A suite that does not
 * exercise production's mount configuration is not a test of production, so
 * the mount is now a parameter rather than an assumption.
 *
 * Behaviours pinned here:
 *   1. signing 500 must NOT show "err" if the proxy can serve the photo
 *   2. "err" must SURVIVE for a genuinely-missing photo (proxy 404) — losing
 *      the error state would be a regression, not a fix
 *   3. a line with no photos must render nothing and fire NO request
 *   4. the fallback must fetch the `.thumb` sibling, not the full-size object,
 *      and must not re-stream bytes it has already fetched
 *   5. the payload production ACTUALLY returns must render — see below
 *
 * (5) closes a hole this suite shipped with. Every case here mocked
 * `fetchSoItemPhotoSignedUrl` as REJECTING, which is how the route behaved
 * BEFORE the fallback landed. The fix changed the route: it no longer 500s at
 * all, it resolves with `{ mode: 'proxy', proxyPath, thumbProxyPath,
 * expiresAt: null, reason }` — and that resolve path, the only one production
 * has taken since, was never exercised. The tile survived it by accident,
 * because `isDirectlyLoadableUrl(undefined)` happens to be false. Both shapes
 * are pinned now: a rejection (an older deploy) and a proxy payload (this one).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, type ReactNode, type ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const fetchSoItemPhotoSignedUrl = vi.fn();
const fetchSoItemPhotoBlob = vi.fn();

/* Only the two network helpers are faked; the tile's real decision logic —
   which is what regressed — runs untouched. isDirectlyLoadableUrl and
   PhotoProxyError keep their real implementations, so the component's
   `instanceof PhotoProxyError` status check is exercised for real. */
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

/** What `GET /photos/:photoKey/signed` returns in production TODAY, for every
 *  photo: signing is impossible, so the route reports the proxy arm with a 200.
 *  Copied from backend/src/scm/lib/photoProxyFallback.ts ProxyPhotoPayload —
 *  note there is deliberately no `signedUrl` on it. */
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
  // jsdom implements neither of these.
  globalThis.URL.createObjectURL = vi.fn(() => `blob:obj-${++minted}`);
  globalThis.URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
});

afterEach(() => { vi.restoreAllMocks(); });

/* PhotoThumb's signed-URL cache, thumb-missing set and proxy BYTE cache all
   live at module level on purpose (they must survive drawer open/close), so
   every test uses its own photoKey rather than resetting module state. The
   mount variant is part of the key for the same reason. */
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
    // The regression this whole PR exists to kill.
    expect(screen.queryByText('err')).toBeNull();
  });

  /* THE COST FIX. Under fallback the tile used to fetch the BASE key with
     useFull(true), so a 40-line SO streamed 40 full-resolution JPEGs through
     the Worker on every drawer open. The proxy route authorises a `.thumb`
     against its base row (mfg-sales-orders.ts, baseKeyOf), so the thumb is asked
     for first. */
  it('asks the proxy for the .thumb sibling, not the full-size object', async () => {
    const photoKey = keyFor('thumb-first');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    renderTile(photoKey);
    await screen.findByAltText('Line photo');

    expect(fetchSoItemPhotoBlob).toHaveBeenCalledWith(DOC_NO, ITEM_ID, `${photoKey}.thumb`);
    expect(fetchSoItemPhotoBlob).not.toHaveBeenCalledWith(DOC_NO, ITEM_ID, photoKey);
  });

  /* Every photo uploaded before thumbnails shipped has no `.thumb` object. */
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

  /* A stall is not evidence the thumb is missing. If a timeout were treated
     as a 404 the tile would remember "no thumb" for the page's whole life and
     stream the full-size object on every later open. */
  it('does not remember a timeout as a missing thumb', async () => {
    const photoKey = keyFor('stall');
    fetchSoItemPhotoSignedUrl.mockRejectedValue(SIGNING_FAILED);
    fetchSoItemPhotoBlob.mockRejectedValue(
      new PhotoProxyError(408, 'The photo took too long to load — please try again.'),
    );

    const first = renderTile(photoKey);
    expect(await screen.findByText('err')).toBeTruthy();
    // Only the thumb was attempted; a 408 is rethrown, not swallowed as "no thumb".
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledTimes(1);
    first.unmount();

    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());
    renderTile(photoKey);
    await screen.findByAltText('Line photo');
    // Still asks for the thumb — the stall did not poison the thumb-missing set.
    expect(fetchSoItemPhotoBlob).toHaveBeenLastCalledWith(DOC_NO, ITEM_ID, `${photoKey}.thumb`);
  });

  /* Re-opening the drawer re-mounts every tile. The BYTES are cached at module
     level, so a reopen costs no Worker round-trip at all. */
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

  /* The upload route's own signing-failure fallback returns a RELATIVE proxy
     path. It is filtered by `startsWith('http')` at the upload call site in
     SoLineCard.tsx before it can reach the cache,
     and /signed itself cannot emit one, so this pins the invariant rather than
     a live 404: anything non-absolute must never reach <img src>. */
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
    // Exactly one object URL was ever minted, so the revoke above is complete.
    expect(minted).toBe(1);
  });

  /* ── The shape production actually serves ─────────────────────────────────
     Not a variant of the rejection cases above: a REJECTION and a RESOLVE with
     a signedUrl-less body reach the proxy through two different branches of
     loadSignedUrl, and only the rejection had a test. This is the branch every
     real request takes. */
  it('renders through the proxy when /signed RESOLVES with the proxy payload', async () => {
    const photoKey = keyFor('proxy-payload');
    fetchSoItemPhotoSignedUrl.mockResolvedValue(proxyPayload(DOC_NO, ITEM_ID, photoKey));
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    renderTile(photoKey);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:obj-1');
    expect(screen.queryByText('err')).toBeNull();
    // Thumb tier still applies on this branch.
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledWith(DOC_NO, ITEM_ID, `${photoKey}.thumb`);
  });

  /* The proxy path is behind the bearer-auth gate and an <img> sends no
     Authorization header. If the payload's proxyPath ever reached <img src> it
     would 401 invisibly — a blank tile that LOOKS fixed. */
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

  /* When signing IS eventually provisioned the proxy must stop being used —
     a fallback that fires unconditionally would pass every test above while
     silently disabling signed URLs forever. */
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
    // Thumb tier first, and no proxy round-trip at all.
    expect(img).toHaveProperty('src', 'https://r2.example.com/full.jpg.thumb?sig=xyz');
    expect(fetchSoItemPhotoBlob).not.toHaveBeenCalled();
  });

  /* The genuinely-broken case has to survive this branch too, or a missing
     photo would render as an empty tile the operator cannot tell from a
     loading one. */
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

/* The reviewer's exact reproduction, kept as its own case so a regression
   points straight at the cause rather than at "some StrictMode test". */
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
    /* The discarded first pass shares the second pass's in-flight promise
       instead of issuing its own request, and never mints an object URL it
       would then have to revoke. */
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledTimes(1);
    expect(minted).toBe(1);
    expect(revoked).toEqual([]);
  });
});
