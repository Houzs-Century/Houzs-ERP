
export interface SoLineDescriptionParts {
  description: string;
  description2: string;
  specs: string;
  remark: string | null;
  notes?: string[];
}

export function composeSoLineDescription(p: SoLineDescriptionParts): string[] {
  const variantSummary = (p.specs || p.description2 || '').trim();
  const remark = p.remark && p.remark.trim() !== '' ? p.remark.trim() : null;
  const remarkShownAbove = remark !== null && variantSummary.includes(remark);
  return [
    p.description,
    variantSummary || (remarkShownAbove ? null : remark),
    ...(p.notes ?? []),
    variantSummary && remark && !remarkShownAbove ? `Remark: ${remark}` : null,
  ].filter((x): x is string => Boolean(x));
}
