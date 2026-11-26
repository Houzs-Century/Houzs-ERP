
export type SizeInfo = {
  label: string;
  dim:   string;
  w:     number;
  l:     number;
};

export const SIZE_INFO: Record<string, SizeInfo> = {
  K:  { label: '6FT',       dim: '183X190CM', w: 183, l: 190 },
  Q:  { label: '5FT',       dim: '152X190CM', w: 152, l: 190 },
  S:  { label: '3FT',       dim: '90X190CM',  w: 90,  l: 190 },
  SS: { label: '3.5FT',     dim: '107X190CM', w: 107, l: 190 },
  SK: { label: '200X200CM', dim: '',          w: 200, l: 200 },
  SP: { label: 'CUSTOM',    dim: '',          w: 0,   l: 0   },
};

/** "K" → "K · 6FT · 183x190CM" — for pool list displays where commander
    wants to see what the bare letter actually unpacks to. SK/SP have label
    that IS dimensions, so the dim segment is dropped to avoid the awkward
    "SK · 200X200CM · " trailing-separator look. Unknown codes pass through
    unchanged. */
export function formatSizeRich(code: string): string {
  const info = SIZE_INFO[code];
  if (!info) return code;
  if (info.dim) return `${code} · ${info.label} · ${info.dim}`;
  return `${code} · ${info.label}`;
}

/** PR #92 — Resolve a size code into label + dimensions with Maintenance
 *  override on top of the static SIZE_INFO map. Commander edits sizeLabels
 *  from Maintenance > Bedframe Sizes; this helper is the single read path
 *  used by every chip / generator / picker so a relabel ripples cleanly.
 *
 *  Lookup order per field:
 *    label:      cfg.sizeLabels[code].label → SIZE_INFO[code].label → code
 *    dimensions: cfg.sizeLabels[code].dimensions → SIZE_INFO[code].dim → ''
 *    w / l:      parsed from override dimensions when present → SIZE_INFO → 0
 *
 *  An unknown code with no override falls back to itself for the label
 *  (matches the previous SIZE_INFO[code] ?? code behaviour at every call
 *  site).
 */
export function resolveSizeInfo(
  code: string,
  cfg?: { sizeLabels?: Record<string, { label?: string; dimensions?: string } | undefined> } | null,
): SizeInfo {
  const override = cfg?.sizeLabels?.[code];
  const base = SIZE_INFO[code];
  const label = override?.label?.trim() || base?.label || code;
  const dim   = override?.dimensions?.trim() || base?.dim || '';

  let w = base?.w ?? 0;
  let l = base?.l ?? 0;
  if (override?.dimensions) {
    const m = override.dimensions.trim().match(/^(\d+)\s*[xX×]\s*(\d+)/);
    if (m && m[1] && m[2]) {
      w = parseInt(m[1], 10);
      l = parseInt(m[2], 10);
    }
  }
  return { label, dim, w, l };
}

/** PR #92 — Rich format variant that reads from Maintenance overrides.
 *  Same output shape as formatSizeRich but honours commander's edits. */
export function formatSizeRichWithCfg(
  code: string,
  cfg?: { sizeLabels?: Record<string, { label?: string; dimensions?: string } | undefined> } | null,
): string {
  const info = resolveSizeInfo(code, cfg);
  if (!info.label || info.label === code) return code;
  if (info.dim) return `${code} · ${info.label} · ${info.dim}`;
  return `${code} · ${info.label}`;
}
