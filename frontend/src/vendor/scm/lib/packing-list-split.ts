import { PACKING_QR_MAX_DOS, type PackingListRow, type PackingRegionDo, type PackingRegionRow } from './packing-list-queries';

/** Which part of a split packing list a sheet is; null for a whole sheet. */
export type SheetPart = { no: number; count: number };

export type SheetPiece<T> = { sheet: T; part: SheetPart | null };

/** "Part 1 of 2", or '' for a whole sheet. */
export function partLabel(part: SheetPart | null): string {
  return part ? `Part ${part.no} of ${part.count}` : '';
}

/** How many parts a sheet of `doCount` delivery orders prints as (one QR covers at most 60). */
export function partCountFor(doCount: number): number {
  return Math.max(1, Math.ceil(doCount / PACKING_QR_MAX_DOS));
}

function chunkEvenly<T>(items: readonly T[], weight: (t: T) => number, parts: number): T[][] {
  const total = items.reduce((n, t) => n + weight(t), 0);
  const size = Math.ceil(total / parts);
  const out: T[][] = [[]];
  let inPart = 0;
  for (const t of items) {
    const w = weight(t);
    if (w > 0 && inPart + w > size && out.length < parts) {
      out.push([]);
      inPart = 0;
    }
    out[out.length - 1]!.push(t);
    inPart += w;
  }
  return out.filter((c) => c.length > 0);
}

/**
 * A lorry's packing list, split by delivery order (owner 2026-11-28) into parts of at most
 * 60 DOs so each part carries its own QR. Parts are cut in delivery order and kept even
 * (65 DOs -> 33 + 32). A trip list is never split: its QR is the trip's, not the DOs'.
 */
export function splitPackingList(list: PackingListRow): SheetPiece<PackingListRow>[] {
  const stops = [...list.stops].sort((a, b) => a.stop_no - b.stop_no);
  const doCount = stops.filter((s) => s.do_id).length;
  const count = partCountFor(doCount);
  if (count === 1 || list.source === 'trip') return [{ sheet: list, part: null }];
  const chunks = chunkEvenly(stops, (s) => (s.do_id ? 1 : 0), count);
  return chunks.map((chunk, i) => ({
    sheet: {
      ...list,
      stops: chunk,
      stop_count: chunk.length,
      do_count: chunk.filter((s) => s.do_id).length,
      units: chunk.reduce((n, s) => n + s.units, 0),
      m3_milli: null,
    },
    part: { no: i + 1, count: chunks.length },
  }));
}

const byText = (a: string, b: string) => a.localeCompare(b);

function regionTotals(region: PackingRegionRow, dos: PackingRegionDo[]): PackingRegionRow {
  return {
    ...region,
    do_count: dos.length,
    customer_count: new Set(dos.map((d) => (d.debtor_code ?? d.customer_name ?? d.do_id).toUpperCase())).size,
    units: dos.reduce((n, d) => n + d.units, 0),
    lorry_plates: [...new Set(dos.map((d) => d.lorry_plate).filter((p): p is string => !!p))].sort(byText),
    not_arranged: dos.filter((d) => !d.lorry_plate).length,
    dos,
  };
}

/** A region's packing list split the same way, in the sheet's own order. */
export function splitPackingRegion(region: PackingRegionRow): SheetPiece<PackingRegionRow>[] {
  const count = partCountFor(region.dos.length);
  if (count === 1) return [{ sheet: region, part: null }];
  const chunks = chunkEvenly(region.dos, () => 1, count);
  return chunks.map((dos, i) => ({ sheet: regionTotals(region, dos), part: { no: i + 1, count: chunks.length } }));
}
