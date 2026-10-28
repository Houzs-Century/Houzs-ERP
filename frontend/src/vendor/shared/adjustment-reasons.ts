// Vendored VERBATIM from packages/shared/src/adjustment-reasons.ts — the
// stock-movements wave (StockAdjustmentNew dropdown + StockAdjustments list).
// Pure data + helpers (no I/O, no supabase), so it copies byte-for-byte.
//
// Manual stock-adjustment reason codes — single source of truth for the
// dropdown (frontend) AND the backend validation gate, so the same list is
// enforced on both sides. Wei Siang 2026-06-04.
//
// Stored in inventory_movements.reason_code on ADJUSTMENT movements. Stock-take
// posting stamps COUNT automatically (a count correction).

export const ADJUSTMENT_REASONS = [
  { code: 'DAMAGE', label: 'Damage' },
  { code: 'LOSS', label: 'Loss' },
  { code: 'THEFT', label: 'Theft' },
  { code: 'FOUND', label: 'Found' },
  { code: 'COUNT', label: 'Count Correction' },
  { code: 'SAMPLE', label: 'Sample' },
  { code: 'FREEGIFT', label: 'Free Gift' },
  { code: 'WRITEOFF', label: 'Write-off' },
  { code: 'OTHER', label: 'Other' },
] as const;

export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASONS)[number]['code'];

export const ADJUSTMENT_REASON_CODES: readonly string[] = ADJUSTMENT_REASONS.map((r) => r.code);

export const isAdjustmentReasonCode = (v: unknown): v is AdjustmentReasonCode =>
  typeof v === 'string' && ADJUSTMENT_REASON_CODES.includes(v);

export const adjustmentReasonLabel = (code: string | null | undefined): string => {
  if (!code) return '—';
  const found = ADJUSTMENT_REASONS.find((r) => r.code === code);
  return found ? found.label : code;
};
