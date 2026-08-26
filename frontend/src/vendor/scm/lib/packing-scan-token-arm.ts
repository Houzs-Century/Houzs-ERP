import { authedFetch } from './authed-fetch';

// ----------------------------------------------------------------------------
// armPackingScanToken — fetch the token the printed PACKING LIST's QR encodes.
//
// The trip twin of do-scan-token-arm.ts, and the same contract: the token is
// minted LAZILY by an authenticated endpoint, so a run gains a public page at
// the moment somebody prints its sheet and not before, and a FAILED MINT PRINTS
// NO QR rather than falling back to the authed link — a sheet carrying a link
// only office staff can open is worse than one carrying none, because the driver
// finds out at the lorry.
//
// `tripId` is a REQUIRED argument rather than something read off the row, for
// the reason the delivery-order twin gives: it keeps the caller naming the run
// it means, so a renderer reused for something else cannot silently arm the
// wrong document.
// ----------------------------------------------------------------------------

/** The run's public scan token, or `null` when it could not be obtained. */
export async function armPackingScanToken(tripId: string): Promise<string | null> {
  if (!tripId) return null;
  try {
    const { scanToken } = await authedFetch<{ scanToken?: string }>(
      `/trips/${encodeURIComponent(tripId)}/scan-token`,
    );
    return scanToken ?? null;
  } catch {
    /* Never block a print on the QR. The operator asked for the sheet. */
    return null;
  }
}
