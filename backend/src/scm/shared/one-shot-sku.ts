import { normalizeCompartmentCode } from './sofa-build';

/** Slug a free-text remark into an UPPERCASE dash-joined token, capped at 40. */
export function remarkSlug(remark: string): string {
  return (remark ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, ''); // re-trim if the slice cut mid-dash
}

/**
 * SOFA one-shot SKU code (D6): `{MODEL}-{normalizeCompartmentCode(comp-slug[-n])}`.
 * The compartment portion is normalized to canonical parens so a Phase-2
 * re-selection (the configurator normalizes moduleId) produces the SAME code.
 * `n > 1` is the collision suffix; it rides the raw string so it normalizes
 * into a `(n)` group and stays normalization-stable.
 */
export function oneShotSofaCode(modelCode: string, compartment: string, slug: string, n = 1): string {
  const raw = `${compartment}-${slug}${n > 1 ? `-${n}` : ''}`;
  return `${(modelCode ?? '').trim()}-${normalizeCompartmentCode(raw)}`.toUpperCase();
}

/**
 * MATTRESS/BEDFRAME one-shot SKU code: `{baseSkuCode}-{slug}[-n]`. These have no
 * compartment axis and re-activate via pos_active (no configurator matching), so
 * a plain suffix is fine — no normalization needed.
 */
export function oneShotSimpleCode(baseCode: string, slug: string, n = 1): string {
  return `${(baseCode ?? '').trim()}-${slug}${n > 1 ? `-${n}` : ''}`;
}

/** One-shot SKU display name: base name + ` (remark)` (remark kept as typed). */
export function buildOneShotName(baseName: string, remark: string): string {
  const r = (remark ?? '').trim();
  return r ? `${baseName} (${r})` : baseName;
}
