// Vendored VERBATIM from apps/backend/src/lib/pos-remark-special.ts — pure
// helper (no imports, no supabase). Used by the vendored SoLineCard.

export const posRemarkSpecialOf = (
  variants: Record<string, unknown>,
): { label: string; amountSen: number } | null => {
  const n = variants.extraAddonNote;
  const text = typeof n === 'string' ? n.trim() : '';
  const raw = Number(variants.extraAddonAmountRM ?? 0);
  const amountSen = (Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0) * 100;
  if (!text && amountSen <= 0) return null;
  return { label: text || 'Extra add-on', amountSen };
};
