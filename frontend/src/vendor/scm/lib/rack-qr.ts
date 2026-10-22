// What a rack sticker's QR says, and how a scan of one becomes a rack row.
// Kept apart from rack-label-pdf so the phone's scanner does not pull jsPDF in.
//
// The sticker carries the rack LABEL, not a row id: one shelf label is fanned
// out to a warehouse_racks row per warehouse record, and a GRN line needs the
// row of the receipt's own warehouse. So a scan is resolved against the racks
// the caller already scoped to that warehouse.

export const RACK_QR_PREFIX = 'HZRACK:';

export const rackQrPayload = (label: string): string => `${RACK_QR_PREFIX}${label.trim()}`;

export type RackScanResult =
  | { kind: 'ok'; rackId: string; label: string }
  | { kind: 'not_rack' }
  | { kind: 'not_here'; label: string }
  | { kind: 'ambiguous'; label: string };

export function resolveRackScan(
  scanned: string,
  racks: ReadonlyArray<{ id: string; rack: string }>,
): RackScanResult {
  const text = scanned.trim();
  if (!text.toUpperCase().startsWith(RACK_QR_PREFIX)) return { kind: 'not_rack' };
  const label = text.slice(RACK_QR_PREFIX.length).trim();
  if (!label) return { kind: 'not_rack' };
  const key = label.toUpperCase();
  const hits = racks.filter((r) => r.rack.trim().toUpperCase() === key);
  if (hits.length === 0) return { kind: 'not_here', label };
  if (hits.length > 1) return { kind: 'ambiguous', label };
  return { kind: 'ok', rackId: hits[0].id, label: hits[0].rack };
}

export function rackScanRefusal(r: Exclude<RackScanResult, { kind: 'ok' }>): string {
  switch (r.kind) {
    case 'not_rack': return 'That is not a rack label.';
    case 'not_here': return `Rack ${r.label} is not in this receipt's warehouse.`;
    case 'ambiguous': return `Rack ${r.label} is in more than one warehouse. Pick it from the list.`;
  }
}
