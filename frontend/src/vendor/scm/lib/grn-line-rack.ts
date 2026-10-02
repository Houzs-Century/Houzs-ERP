// The GRN line-rack rule, shared by desktop (GoodsReceivedDetail) and the phone
// (MobileGrnLineRack) so the two cannot drift. The server holds the same rule in
// backend/src/scm/lib/grn-line-rack.ts — this only decides what to offer.
//
// A DRAFT line can be split over several racks (owner 2026-10-02); the split
// rule itself is vendor/shared/rack-split.ts, byte-mirrored with the server.
// useGrnLineRackSplit is the one logic layer both surfaces render.
import { useState } from 'react';
import { sortByText } from './sort-options';
import { useGrnItemRacks, useSetGrnLineRacks } from './grn-queries';
import {
  addToRackSplit, effectiveRackSplit, rackSplitError, rackSplitRemaining, rackSplitTotal,
  removeFromRackSplit, type RackSplit,
} from '../../shared/rack-split';

/** Rack is placement only, so a PI/PR lock does not freeze it; only a
 *  CANCELLED / CLOSED receipt does. */
export function grnRackEditable(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return s === 'DRAFT' || s === 'POSTED';
}

/** Splitting plans where the goods WILL go, so it is a draft's: once posted
 *  the goods are on the shelves and move on the rack board. */
export function grnRackSplitEditable(status: string | null | undefined): boolean {
  return String(status ?? '').toUpperCase() === 'DRAFT';
}

export function grnRackOptions(racks: ReadonlyArray<{ id: string; rack: string }>): { value: string; label: string }[] {
  return sortByText(racks.map((r) => ({ value: r.id, label: r.rack })));
}

/**
 * Put `qty` on `rackId`. When the line already sits whole on ONE other rack and
 * there is no room left, the qty is taken off that rack — "scan L3.2, 4" on a
 * line of 10 on L3.1 reads as 6 on L3.1 and 4 on L3.2, which is what the
 * storekeeper just did with the goods. Anything else that does not fit is left
 * for rackSplitError to explain.
 */
export function addRackShare(splits: ReadonlyArray<RackSplit>, qtyAccepted: number, rackId: string, qty: number): RackSplit[] {
  const room = rackSplitRemaining(qtyAccepted, splits);
  if (qty > room && splits.length === 1 && splits[0].rackId !== rackId && rackSplitTotal(splits) === qtyAccepted) {
    const keep = splits[0].qty - (qty - room);
    if (keep > 0) return [{ rackId: splits[0].rackId, qty: keep }, { rackId, qty }];
  }
  return addToRackSplit(splits, rackId, qty);
}

export function useGrnLineRackSplit({ grnId, itemId, lineRackId, qtyAccepted }: {
  grnId: string;
  itemId: string;
  lineRackId: string | null;
  qtyAccepted: number;
}) {
  const rows = useGrnItemRacks(grnId);
  const setRacks = useSetGrnLineRacks();
  const [error, setError] = useState<string | null>(null);
  const saved = (rows.data ?? []).filter((r) => r.grnItemId === itemId).map((r) => ({ rackId: r.rackId, qty: r.qty }));
  const splits = effectiveRackSplit(lineRackId, qtyAccepted, saved);

  const save = (next: RackSplit[], onSaved?: () => void) => {
    const invalid = rackSplitError(qtyAccepted, next);
    if (invalid) { setError(invalid); return; }
    setError(null);
    setRacks.mutate(
      { grnId, itemId, racks: next },
      {
        onSuccess: () => onSaved?.(),
        onError: (e) => setError(e instanceof Error && e.message ? e.message : 'The racks were not saved. Please try again.'),
      },
    );
  };

  return {
    splits,
    remaining: rackSplitRemaining(qtyAccepted, splits),
    loading: rows.isLoading,
    saving: setRacks.isPending,
    error,
    add: (rackId: string, qty: number, onSaved?: () => void) => save(addRackShare(splits, qtyAccepted, rackId, qty), onSaved),
    remove: (rackId: string, onSaved?: () => void) => save(removeFromRackSplit(splits, rackId), onSaved),
  };
}
