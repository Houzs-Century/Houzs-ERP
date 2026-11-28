import { authedFetch } from './authed-fetch';


/** The run's public scan token, or `null` when it could not be obtained. */
export async function armPackingScanToken(tripId: string): Promise<string | null> {
  if (!tripId) return null;
  try {
    const { scanToken } = await authedFetch<{ scanToken?: string }>(
      `/trips/${encodeURIComponent(tripId)}/scan-token`,
    );
    return scanToken ?? null;
  } catch {
    return null;
  }
}

/** The public scan token for a packing list printed per lorry per delivery day
 *  (no trip behind it). `doIds` are the delivery orders printed on the sheet, in
 *  sheet order; the QR loads exactly those. `null` when it could not be obtained.
 *  `deliveryDate` is YYYY-MM-DD. Same token for a re-print of the same set. */
export async function armLorryDayScanToken(input: {
  lorryPlate: string;
  deliveryDate: string;
  doIds: readonly string[];
}): Promise<string | null> {
  const plate = input.lorryPlate.trim();
  if (!plate || !input.deliveryDate || input.doIds.length === 0) return null;
  const qs = new URLSearchParams({ plate, date: input.deliveryDate, doIds: input.doIds.join(',') });
  try {
    const { scanToken } = await authedFetch<{ scanToken?: string }>(`/trips/lorry-day-scan-token?${qs.toString()}`);
    return scanToken ?? null;
  } catch {
    return null;
  }
}
