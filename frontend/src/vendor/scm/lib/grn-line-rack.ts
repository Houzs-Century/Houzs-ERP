// The GRN line-rack rule, shared by desktop (GoodsReceivedDetail) and the phone
// (MobileGrnLineRack) so the two cannot drift. The server holds the same rule in
// backend/src/scm/lib/grn-line-rack.ts — this only decides what to offer.
import { sortByText } from './sort-options';

/** Rack is placement only, so a PI/PR lock does not freeze it; only a
 *  CANCELLED / CLOSED receipt does. */
export function grnRackEditable(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return s === 'DRAFT' || s === 'POSTED';
}

export function grnRackOptions(racks: ReadonlyArray<{ id: string; rack: string }>): { value: string; label: string }[] {
  return sortByText(racks.map((r) => ({ value: r.id, label: r.rack })));
}
