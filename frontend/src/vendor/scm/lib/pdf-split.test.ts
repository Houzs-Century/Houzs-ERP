/* HC-0204: the server's pages come back as files named by page, in order. */
import { describe, expect, test, vi } from 'vitest';

const authedFetch = vi.fn();
vi.mock('./authed-fetch', () => ({ authedFetch: (...a: unknown[]) => authedFetch(...a) }));
vi.mock('./payment-voucher-queries', () => ({ fileToBase64: async () => 'UERG' }));

import { splitPdfPages } from './pdf-split';

describe('splitPdfPages', () => {
  test('sends the PDF, names each page it gets back', async () => {
    authedFetch.mockResolvedValueOnce({ pages: [btoa('%PDF-a'), btoa('%PDF-b')] });
    const out = await splitPdfPages(new File(['x'], 'Supplier Nov.PDF', { type: 'application/pdf' }));
    expect(authedFetch).toHaveBeenCalledWith('/payment-vouchers/split-pdf', expect.objectContaining({ method: 'POST', body: JSON.stringify({ dataBase64: 'UERG' }) }));
    expect(out.map((f) => [f.name, f.type, f.size])).toEqual([
      ['Supplier Nov p1.pdf', 'application/pdf', 6],
      ['Supplier Nov p2.pdf', 'application/pdf', 6],
    ]);
  });
});
