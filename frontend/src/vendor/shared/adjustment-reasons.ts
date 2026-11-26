
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
