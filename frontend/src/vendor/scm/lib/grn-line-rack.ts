// The GRN line-rack rule, shared by desktop (GoodsReceivedDetail) and the phone
// (MobileGrnLineRack) so the two cannot drift. The server holds the same rule in
// backend/src/scm/lib/grn-line-rack.ts — this only decides what to offer.
//
// A DRAFT line can be split over several racks (owner 2026-10-02); the split
// rule itself is vendor/shared/rack-split.ts, byte-mirrored with the server.
// useGrnLineRackSplit is the one logic layer both surfaces render.
import { useMemo, useState } from 'react';
import { sortByText } from './sort-options';
import { useGrnItemRacks, useSetGrnLineRacks } from './grn-queries';
import { useCrossCompanyRacks, useRacks } from './warehouse-queries';
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

/** A rack row of another company, as GET /warehouse/cross-company tags it. */
export type SiblingRack = {
  id: string;
  rack: string;
  warehouse_code: string | null;
  company_code: string | null;
  items: ReadonlyArray<{ qty: number }>;
};

const normKey = (s: string | null | undefined): string => String(s ?? '').trim().toUpperCase();

/**
 * The picker's options with what OTHER companies already have on the same
 * shelf: "Rack L5.1 · HC 6 pcs". One building is one warehouse record per
 * company and a shelf is one rack row per record, so a shelf that reads EMPTY
 * on this company's board can be full of the other company's goods; the
 * storekeeper picking a shelf for a receipt needs to know before walking there.
 * Only shelves of the receipt's own warehouse code are matched, by label; this
 * company's own rows (by id) never count as a sibling. Values are unchanged,
 * so a pick saves exactly as before.
 */
export function grnRackOptionsWithSiblingStock(
  racks: ReadonlyArray<{ id: string; rack: string }>,
  ownWarehouseCode: string | null | undefined,
  siblings: ReadonlyArray<SiblingRack>,
): { value: string; label: string }[] {
  const options = grnRackOptions(racks);
  const code = normKey(ownWarehouseCode);
  if (!code || siblings.length === 0) return options;
  const ownIds = new Set(racks.map((r) => r.id));
  const stockByLabel = new Map<string, Map<string, number>>();
  for (const s of siblings) {
    if (ownIds.has(s.id) || normKey(s.warehouse_code) !== code) continue;
    const qty = s.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
    if (qty <= 0) continue;
    const byCompany = stockByLabel.get(normKey(s.rack)) ?? new Map<string, number>();
    const company = s.company_code ?? '?';
    byCompany.set(company, (byCompany.get(company) ?? 0) + qty);
    stockByLabel.set(normKey(s.rack), byCompany);
  }
  if (stockByLabel.size === 0) return options;
  return options.map((o) => {
    const byCompany = stockByLabel.get(normKey(o.label));
    if (!byCompany) return o;
    const hint = [...byCompany.entries()].map(([company, qty]) => `${company} ${qty} pcs`).join(', ');
    return { value: o.value, label: `${o.label} · ${hint}` };
  });
}

/**
 * The racks a GRN line may be placed on, for both surfaces: this company's
 * racks of the receipt's warehouse (what a pick saves), their plain labels (how
 * a saved pick reads back), and the picker options carrying the other
 * companies' stock on the same shelf. The cross-company read is the same feed
 * the All Companies tab shows; a miss there only drops the hint.
 */
export function useGrnRackOptions(warehouseId: string | undefined) {
  const racksQ = useRacks({ warehouseId: warehouseId || undefined });
  const crossQ = useCrossCompanyRacks();
  const racks = useMemo(() => racksQ.data?.racks ?? [], [racksQ.data?.racks]);
  const ownCode = (racksQ.data?.warehouses ?? []).find((w) => w.id === warehouseId)?.code ?? null;
  const crossRacks = crossQ.data?.racks;
  // Stable per data, so a caller's own useMemo keyed on these does not rerun every render.
  const options = useMemo(
    () => grnRackOptionsWithSiblingStock(racks, ownCode, crossRacks ?? []),
    [racks, ownCode, crossRacks],
  );
  const labelById = useMemo(() => new Map<string, string>(racks.map((r) => [r.id, r.rack])), [racks]);
  return { racks, options, labelById, isLoading: racksQ.isLoading };
}

/** How a line's racks read wherever they are shown — "L3.1 ×6, L3.2 ×4" — and
 *  how many accepted units are on no rack yet (owner 2026-10-02: the GRN view
 *  page shows the racks, as the phone's line card does). */
export function lineRackSummary(
  splits: ReadonlyArray<RackSplit>,
  qtyAccepted: number,
  labelOf: (rackId: string) => string | undefined,
): { text: string; unplaced: number } {
  return {
    text: splits.map((s) => `${labelOf(s.rackId) ?? '?'} ×${s.qty}`).join(', '),
    unplaced: rackSplitRemaining(qtyAccepted, splits),
  };
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
