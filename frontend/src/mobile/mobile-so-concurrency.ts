import { authedFetch } from '../vendor/scm/lib/authed-fetch';

type Fetcher = typeof authedFetch;
type SoVersionDetail = { salesOrder?: { version?: number | string; status?: string | null } };

/** Confirm one order using a version loaded immediately before the mutation. */
export async function confirmSoWithFreshVersion(
  docNo: string,
  fetcher: Fetcher = authedFetch,
): Promise<void> {
  const path = `/mfg-sales-orders/${encodeURIComponent(docNo)}`;
  const detail = await fetcher<SoVersionDetail>(path);
  const version = Number(detail.salesOrder?.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('This order has no concurrency version. Refresh before confirming it.');
  }
  await fetcher(`${path}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'CONFIRMED', expectedStatus: 'DRAFT', version }),
  });
}

/** Upload one line photo while proving ownership of the order's edit lease. */
export async function uploadSoItemPhotoWithLease(
  docNo: string,
  itemId: string,
  file: File,
  lease: string,
  fetcher: Fetcher = authedFetch,
): Promise<void> {
  if (!lease.trim()) throw new Error('A Sales Order edit lease is required for photo upload.');
  const fd = new FormData();
  fd.append('file', file);
  await fetcher(
    `/mfg-sales-orders/${encodeURIComponent(docNo)}/items/${encodeURIComponent(itemId)}/photos`,
    { method: 'POST', headers: { 'X-SO-Edit-Lease': lease }, body: fd },
  );
}
