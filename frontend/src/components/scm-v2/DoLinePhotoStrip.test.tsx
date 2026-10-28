/* The V2 DO detail's Photos column (mig 20260828T0746 — the DO leg of the
 * owner's 2026-08-10 photo-carry rule).
 *
 * What these pin, learned from the SO strip's production regressions:
 *
 *   1. The tile streams bytes through the AUTHED proxy (api.fetchBlobUrl) and
 *      asks for the `.thumb` tier first — production has no signing creds, so
 *      any loader that needs a signed URL renders nothing at all.
 *   2. A pre-thumb photo (`.thumb` 404s) falls back to the FULL object instead
 *      of reading as broken.
 *   3. Clicking a thumbnail opens a viewer that fetches the FULL object with
 *      the R2 key encoded as ONE path segment — un-encoded slashes make Hono's
 *      `:photoKey` param miss and the proxy 404.
 *   4. A genuinely unreachable photo reads as "err", never as an empty tile.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchBlobUrl = vi.fn();

/* Only the network edge is faked — the tile ladder and the viewer run real. */
vi.mock('../../api/client', () => ({
  api: {
    fetchBlobUrl: (...a: unknown[]) => fetchBlobUrl(...a),
    downloadFile: vi.fn(),
  },
}));

const { DoLinePhotoStrip, doLinePhotoLightboxBase } = await import('./DoLinePhotoStrip');

const DO_ID = '0f9b7a52-6c11-4f6e-9a75-0d9c33b1a001';
const ITEM_ID = 'b5712e8b-bf87-4b7f-8780-70b86464184e';
const KEY = `so-items/HC-SO-002609/${ITEM_ID}/carried.jpg`;
const BASE = doLinePhotoLightboxBase(DO_ID, ITEM_ID);

let minted = 0;

beforeEach(() => {
  minted = 0;
  fetchBlobUrl.mockReset();
  globalThis.URL.createObjectURL = vi.fn(() => `blob:obj-${++minted}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('DoLinePhotoStrip', () => {
  it('renders a line with no photos as a dash and fires no request', async () => {
    render(<DoLinePhotoStrip doId={DO_ID} itemId={ITEM_ID} photoKeys={[]} />);

    expect(screen.getByText('—')).toBeTruthy();
    await waitFor(() => expect(fetchBlobUrl).not.toHaveBeenCalled());
  });

  it('shows the photo from the authed proxy, thumb tier first', async () => {
    fetchBlobUrl.mockResolvedValue('blob:thumb-tier');

    render(<DoLinePhotoStrip doId={DO_ID} itemId={ITEM_ID} photoKeys={[KEY]} />);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:thumb-tier');
    expect(screen.queryByText('err')).toBeNull();
    const [path, typeHint] = fetchBlobUrl.mock.calls[0] as [string, string];
    expect(path).toBe(`${BASE}/${encodeURIComponent(`${KEY}.thumb`)}`);
    /* One encoded segment — the raw key's slashes must not reach the URL. */
    expect(path).not.toContain('so-items/');
    expect(typeHint).toBe('image/jpeg');
  });

  it('falls back to the full object when the thumb tier fails (pre-thumb photo)', async () => {
    fetchBlobUrl
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce('blob:full-fallback');

    render(<DoLinePhotoStrip doId={DO_ID} itemId={ITEM_ID} photoKeys={[KEY]} />);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:full-fallback');
    const paths = fetchBlobUrl.mock.calls.map((c) => c[0] as string);
    expect(paths[0]).toContain('.thumb');
    expect(paths[1]).toBe(`${BASE}/${encodeURIComponent(KEY)}`);
  });

  it('opens a viewer that streams the FULL object, key encoded as one segment', async () => {
    fetchBlobUrl.mockResolvedValue('blob:bytes');

    render(<DoLinePhotoStrip doId={DO_ID} itemId={ITEM_ID} photoKeys={[KEY]} />);
    await screen.findByAltText('Line photo');
    fetchBlobUrl.mockClear();

    await userEvent.click(screen.getByTitle('Open full size'));

    await waitFor(() => expect(fetchBlobUrl).toHaveBeenCalled());
    const [path, typeHint] = fetchBlobUrl.mock.calls[0] as [string, string];
    /* The BASE key, not the `.thumb` the tile shows — the viewer's whole job
       is the full-resolution image. */
    expect(path).toBe(`${BASE}/${encodeURIComponent(KEY)}`);
    expect(path).not.toContain('.thumb');
    expect(path).not.toContain('so-items/');
    expect(typeHint).toBe('image/jpeg');
  });

  it('marks a genuinely unreachable photo as err rather than an empty tile', async () => {
    fetchBlobUrl.mockRejectedValue(new Error('photo_not_found_in_r2'));

    render(<DoLinePhotoStrip doId={DO_ID} itemId={ITEM_ID} photoKeys={[KEY]} />);

    expect(await screen.findByText('err')).toBeTruthy();
    expect(screen.queryByAltText('Line photo')).toBeNull();
    // Not a button: a retry that repeats the same failing request is theatre.
    expect(screen.queryByRole('button', { name: /err/i })).toBeNull();
  });
});
