import type { Rack } from './warehouse-queries';

/** How many of `itemCode` a rack holds now. */
export function heldOnRack(rack: Pick<Rack, 'items'>, itemCode: string): number {
  return rack.items.filter((i) => i.item_code === itemCode).reduce((s, i) => s + Number(i.qty), 0);
}

type RackLine = { itemCode: string; qty: number; fromRackId?: string; toRackId?: string };

/**
* One sentence per line that names a rack, for the "posted" popup:
 * "3 x MAT-FIRM-K from L5.2 to CA4", "1 x BED onto CA4", "1 x BED off L5.2". Lines with no rack are left out.
 */
export function rackMovesSummary(lines: readonly RackLine[], rackLabel: (id: string) => string): string[] {
  return lines
    .filter((l) => l.fromRackId || l.toRackId)
    .map((l) => {
      const where = l.fromRackId && l.toRackId
        ? `from ${rackLabel(l.fromRackId)} to ${rackLabel(l.toRackId)}`
        : l.fromRackId ? `off ${rackLabel(l.fromRackId)}` : `onto ${rackLabel(l.toRackId ?? '')}`;
      return `${l.qty} x ${l.itemCode} ${where}`;
    });
}
