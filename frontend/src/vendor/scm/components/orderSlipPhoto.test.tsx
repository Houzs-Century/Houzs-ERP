/* The photo taken on the phone must be visible on the computer.
 *
 * Owner, 2026-09-13: 「如果电话版本我用 upload 照片 OCR 的话，那这个照片 OCR 它是会
 * 秀在我的电脑版本的哪里呢？」 The answer was: nowhere he would look. The slip is
 * kept on the order and the phone shows it, but the desktop route serves
 * SalesOrderDetailV2, which had no reference to it — 0 hits in that page's
 * shipped production chunk. It rendered only on the older page reached by
 * pressing Edit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const fetchSlip = vi.fn();
vi.mock('../lib/slip', () => ({ fetchScanSlipImageBlobUrl: (k: string) => fetchSlip(k) }));

import { OrderSlipPhoto } from './OrderSlipPhoto';

afterEach(() => { cleanup(); fetchSlip.mockReset(); });

describe('OrderSlipPhoto', () => {
  it('shows the photo once it loads, and links it full size', async () => {
    fetchSlip.mockResolvedValue('blob:slip-1');
    render(<OrderSlipPhoto imageKey="k1" />);
    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toBe('blob:slip-1');
    expect(img.closest('a')?.getAttribute('href')).toBe('blob:slip-1');
  });

  it('asks for the key it was given', async () => {
    fetchSlip.mockResolvedValue('blob:slip-2');
    render(<OrderSlipPhoto imageKey="k2" />);
    await screen.findByRole('img');
    expect(fetchSlip).toHaveBeenCalledWith('k2');
  });

  it('says a failure OUT LOUD instead of rendering an empty card', async () => {
    /* "This order has no slip" and "the slip would not load" look identical
       when a failure is silent, and on a document the first one is a fact
       about the order. */
    fetchSlip.mockRejectedValue(new Error('not found'));
    render(<OrderSlipPhoto imageKey="k3" />);
    await waitFor(() => {
      expect(screen.getByText(/could not be loaded, which is not the same as this/i)).toBeTruthy();
    });
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows a loading line rather than nothing while it fetches', () => {
    fetchSlip.mockReturnValue(new Promise(() => {}));
    render(<OrderSlipPhoto imageKey="k4" />);
    expect(screen.getByText(/Loading/i)).toBeTruthy();
  });
});
