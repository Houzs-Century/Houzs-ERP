/* HC-0006 T7: a document page offers its original scan(s). Nothing shows when
   the document was not scanned; opening one goes through the recording
   content endpoint, and a failure is said on the page. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';

const { listFetch, blobFetch } = vi.hoisted(() => ({
  listFetch: vi.fn(),
  blobFetch: vi.fn(),
}));
vi.mock('../lib/authed-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authed-fetch')>()),
  authedFetch: listFetch,
}));
vi.mock('../lib/payment-voucher-queries', () => ({ fetchDocFileBlobUrl: blobFetch }));

import { ViewOriginalScan } from './ViewOriginalScan';

const mount = () => render(<ViewOriginalScan kind="so" documentId="SO 1/2" />);

describe('ViewOriginalScan', () => {
  beforeEach(() => { listFetch.mockReset(); blobFetch.mockReset(); });

  test('shows nothing for a document with no kept scan', async () => {
    listFetch.mockResolvedValue({ files: [] });
    const { container } = mount();
    await waitFor(() => expect(listFetch).toHaveBeenCalledWith('/scan-files/so/doc/SO%201%2F2'));
    expect(container.textContent).toBe('');
  });

  test('opens the scan through the recording endpoint', async () => {
    listFetch.mockResolvedValue({ files: [{ id: 'F1', mime: 'image/jpeg' }] });
    blobFetch.mockResolvedValue({ url: 'blob:x', contentType: 'image/jpeg' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View original scan' }));
    await waitFor(() => expect(blobFetch).toHaveBeenCalledWith('/scan-files/so/F1/content'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:x', '_blank', 'noopener'));
    open.mockRestore();
  });

  test('a failed open is shown, not swallowed', async () => {
    listFetch.mockResolvedValue({ files: [{ id: 'F1', mime: 'image/jpeg' }, { id: 'F2', mime: 'application/pdf' }] });
    blobFetch.mockRejectedValue(new Error('The scan is indexed but its file is gone.'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View original scan 2' }));
    expect((await screen.findByRole('alert')).textContent).toContain('its file is gone');
  });
});
