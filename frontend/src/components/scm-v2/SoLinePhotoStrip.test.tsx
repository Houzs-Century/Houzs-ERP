import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchSoItemPhotoSignedUrl = vi.fn();
const fetchSoItemPhotoBlob = vi.fn();
const fetchBlobUrl = vi.fn();

vi.mock('../../vendor/scm/lib/sales-order-queries', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../vendor/scm/lib/sales-order-queries')>();
  return {
    ...actual,
    fetchSoItemPhotoSignedUrl: (...a: unknown[]) => fetchSoItemPhotoSignedUrl(...a),
    fetchSoItemPhotoBlob: (...a: unknown[]) => fetchSoItemPhotoBlob(...a),
  };
});

vi.mock('../../api/client', () => ({
  api: {
    fetchBlobUrl: (...a: unknown[]) => fetchBlobUrl(...a),
    downloadFile: vi.fn(),
  },
}));

const { SoLinePhotoStrip } = await import('./SoLinePhotoStrip');

const DOC_NO = 'HC-SO-002609';
const ITEM_ID = 'b5712e8b-bf87-4b7f-8780-70b86464184e';
const photoBytes = () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' });

const proxyPayload = (photoKey: string) => ({
  mode: 'proxy' as const,
  proxyPath: `/mfg-sales-orders/${DOC_NO}/items/${ITEM_ID}/photos/${encodeURIComponent(photoKey)}`,
  thumbProxyPath: `/mfg-sales-orders/${DOC_NO}/items/${ITEM_ID}/photos/${encodeURIComponent(`${photoKey}.thumb`)}`,
  expiresAt: null,
  reason: 'R2_ACCESS_KEY_ID not configured',
});

let minted = 0;

beforeEach(() => {
  minted = 0;
  fetchSoItemPhotoSignedUrl.mockReset();
  fetchSoItemPhotoBlob.mockReset();
  fetchBlobUrl.mockReset();
  globalThis.URL.createObjectURL = vi.fn(() => `blob:obj-${++minted}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => { vi.restoreAllMocks(); });

let n = 0;
const freshKey = () => `so-items/${DOC_NO}/${ITEM_ID}/strip-${++n}.jpg`;

describe('SoLinePhotoStrip', () => {
  it('renders a line with no photos as a dash and fires no request', async () => {
    render(<SoLinePhotoStrip source="so" docId={DOC_NO} itemId={ITEM_ID} photoKeys={[]} />);

    expect(screen.getByText('—')).toBeTruthy();
    await waitFor(() => {
      expect(fetchSoItemPhotoSignedUrl).not.toHaveBeenCalled();
    });
    expect(fetchSoItemPhotoBlob).not.toHaveBeenCalled();
  });

  it('shows the photo under the proxy payload production actually returns', async () => {
    const key = freshKey();
    fetchSoItemPhotoSignedUrl.mockResolvedValue(proxyPayload(key));
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    render(<SoLinePhotoStrip source="so" docId={DOC_NO} itemId={ITEM_ID} photoKeys={[key]} />);

    const img = await screen.findByAltText('Line photo');
    expect(img).toHaveProperty('src', 'blob:obj-1');
    expect(screen.queryByText('err')).toBeNull();
    expect(fetchSoItemPhotoBlob).toHaveBeenCalledWith(DOC_NO, ITEM_ID, `${key}.thumb`);
  });

  it('opens a viewer that streams the FULL object, key encoded as one segment', async () => {
    const key = freshKey();
    fetchSoItemPhotoSignedUrl.mockResolvedValue(proxyPayload(key));
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());
    fetchBlobUrl.mockResolvedValue('blob:full-size');

    render(<SoLinePhotoStrip source="so" docId={DOC_NO} itemId={ITEM_ID} photoKeys={[key]} />);
    await screen.findByAltText('Line photo');

    await userEvent.click(screen.getByTitle('Open full size'));

    await waitFor(() => expect(fetchBlobUrl).toHaveBeenCalled());
    const [path, typeHint] = fetchBlobUrl.mock.calls[0] as [string, string];
    expect(path).toBe(
      `/api/scm/mfg-sales-orders/${DOC_NO}/items/${ITEM_ID}/photos/${encodeURIComponent(key)}`,
    );
    expect(path).not.toContain('.thumb');
    expect(path).not.toContain('so-items/');
    expect(typeHint).toBe('image/jpeg');
  });

  it('marks a genuinely unreachable photo as err rather than an empty tile', async () => {
    const key = freshKey();
    const { PhotoProxyError } = await import('../../vendor/scm/lib/sales-order-queries');
    fetchSoItemPhotoSignedUrl.mockResolvedValue(proxyPayload(key));
    fetchSoItemPhotoBlob.mockRejectedValue(new PhotoProxyError(404, 'photo_not_found_in_r2'));

    render(<SoLinePhotoStrip source="so" docId={DOC_NO} itemId={ITEM_ID} photoKeys={[key]} />);

    expect(await screen.findByText('err')).toBeTruthy();
    expect(screen.queryByAltText('Line photo')).toBeNull();
    expect(screen.queryByRole('button', { name: /err/i })).toBeNull();
  });

  /* Edit capability (owner 2026-08-28, PO add-ons): absent `edit` is the
     stricter read-only default every pre-existing caller keeps; present, the
     strip grows an add tile and a delete control ONLY on keys the surface
     owns (canDeleteKey — PO passes its po-items/ prefix rule). */
  it('read-only render offers no add tile and no delete control', async () => {
    const key = freshKey();
    fetchSoItemPhotoSignedUrl.mockResolvedValue(proxyPayload(key));
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());

    render(<SoLinePhotoStrip source="so" docId={DOC_NO} itemId={ITEM_ID} photoKeys={[key]} />);

    await screen.findByAltText('Line photo');
    expect(screen.queryByTitle('Add photo')).toBeNull();
    expect(screen.queryByLabelText('Delete photo')).toBeNull();
  });

  it('edit mode renders the add tile even with zero photos and uploads the picked file', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <SoLinePhotoStrip
        source="so"
        docId={DOC_NO}
        itemId={ITEM_ID}
        photoKeys={[]}
        edit={{ onUpload, onDelete: vi.fn(), canDeleteKey: () => false }}
      />,
    );

    expect(screen.queryByText('—')).toBeNull();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File(['jpeg-bytes'], 'sample.jpg', { type: 'image/jpeg' });
    await userEvent.upload(input, file);
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0]![0]).toBe(file);
  });

  it('offers delete only on keys the surface owns, and hands the key to the handler', async () => {
    const carried = freshKey();
    const owned = `po-items/po-1/${ITEM_ID}/addon-1.jpg`;
    fetchSoItemPhotoSignedUrl.mockResolvedValue(proxyPayload(carried));
    fetchSoItemPhotoBlob.mockResolvedValue(photoBytes());
    const onDelete = vi.fn().mockResolvedValue(undefined);

    render(
      <SoLinePhotoStrip
        source="so"
        docId={DOC_NO}
        itemId={ITEM_ID}
        photoKeys={[carried, owned]}
        edit={{
          onUpload: vi.fn(),
          onDelete,
          canDeleteKey: (k) => k.startsWith('po-items/'),
        }}
      />,
    );

    const deletes = await screen.findAllByLabelText('Delete photo');
    expect(deletes).toHaveLength(1);
    await userEvent.click(deletes[0]!);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(owned));
  });
});
