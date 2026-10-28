import { authedFetch } from './authed-fetch';

// ----------------------------------------------------------------------------
// armDoScanToken — put the printed QR's token on a delivery-order print header,
// in ONE place, so no call site has to remember to.
//
// WHY IT REPLACED `loadScanId`. Until 2026-08-26 the QR encoded
// `/scm/do-load?id=<delivery order uuid>` and the three print surfaces each
// stamped that id onto the header themselves. Both halves of that changed:
//
//   · The link is now the PUBLIC one (`/d/<token>`), because the owner chose a
//     no-login scan (「就跟hookka一样」) and a driver with no account cannot open
//     an /scm/ page. So the header carries a TOKEN, not a row id — and the token
//     has to be fetched, which is why this is async and the old stamping was not.
//   · `loadScanId` was doubly misnamed: it is not an id any more, and the QR
//     has done four things rather than "load" since the three-scan ladder landed.
//
// The token is minted LAZILY by the authenticated GET this calls, so a delivery
// order gains a public page at the moment somebody prints its paper and not
// before.
//
// A FAILED MINT PRINTS NO QR — it does not fall back to the old authed link.
// Two reasons, and the second is the one that matters: a paper carrying a link
// only office staff can open is worse than a paper carrying none, because the
// storekeeper discovers it at the lorry; and a silent fallback would leave two
// live URL shapes in circulation with nothing recording which paper has which.
// `generateDeliveryOrderPdf` already draws the block only when the token is
// present, so an unarmed header simply prints the document without a code.
// ----------------------------------------------------------------------------

/**
 * Return `header` with `scanToken` stamped on it, or unchanged when the token
 * could not be obtained.
 *
 * `id` is a REQUIRED argument rather than something read off `header`: the
 * Consignment Note print reuses the delivery-order renderer, and a CN must never
 * grow a control that flips a DELIVERY ORDER's status. Making the caller name
 * the delivery order it means keeps that impossible by accident — the same
 * reason the old field was explicit.
 */
export async function armDoScanToken<T extends object>(
  header: T,
  id: string,
): Promise<T & { scanToken?: string }> {
  try {
    const { scanToken } = await authedFetch<{ scanToken?: string }>(
      `/delivery-orders-mfg/${encodeURIComponent(id)}/scan-token`,
    );
    return scanToken ? { ...header, scanToken } : header;
  } catch {
    /* Never block a print on the QR. The operator asked for the document. */
    return header;
  }
}
