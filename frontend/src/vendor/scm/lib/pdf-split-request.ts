// ----------------------------------------------------------------------------
// pdf-split-request — one PDF holding several bills, as one PDF per page (HC-0204).
//
// Finance gets a supplier's invoices as ONE PDF (Siti 2026-11-02: our
// attachment is a single PDF containing multiple invoices). The pile reads one
// file as one bill, so the server cuts the PDF into its pages
// (POST /payment-vouchers/split-pdf, backend lib/pdf-split.ts — pdf-lib stays
// out of this bundle) and each page joins the pile as its own bill.
// ----------------------------------------------------------------------------

import { authedFetch } from './authed-fetch';
import { fileToBase64 } from './payment-voucher-queries';

const bytesOf = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

/** The PDF's pages, each its own one-page PDF named `<name> p<n>.pdf`. */
export async function splitPdfPages(file: File): Promise<File[]> {
  const { pages } = await authedFetch<{ pages: string[] }>('/payment-vouchers/split-pdf', {
    method: 'POST', body: JSON.stringify({ dataBase64: await fileToBase64(file) }),
  });
  const base = file.name.replace(/\.pdf$/i, '');
  return pages.map((p, i) => new File([bytesOf(p)], `${base} p${i + 1}.pdf`, { type: 'application/pdf' }));
}
