const LEVEL_MODEL = { 1: 'JAGER', 2: 'CODY', 3: 'REGAL (A)', 4: 'TRION (A)' };

/** The product a KIV bedframe takes its cost from, size for size (owner 2026-11-04):
 *  BEDFRAME KIV LV2-(Q) -> CODY-(Q). Null for anything else. */
export function kivSourceCode(code) {
  const m = /^BEDFRAME KIV LV([1-4])(?:-(\([A-Z]+\)))?$/.exec(String(code).trim());
  if (!m || !m[2]) return null;
  return `${LEVEL_MODEL[m[1]]}-${m[2]}`;
}
