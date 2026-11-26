
/** The env shape this reads — just the one string var. Structurally satisfied by
 *  the full worker `Env` (COSTING_DISPLAY_ENABLED?: string) and by a test literal.
 *  A null/undefined env resolves to ON, the no-regression default. */
export interface CostingDisplayEnv {
  COSTING_DISPLAY_ENABLED?: string;
}

/** Whether SCM sales-document cost/margin may be DISPLAYED at all. ON unless the
 *  var is explicitly "false" — see this file's header for why the default is ON
 *  and why the product-cost path is deliberately excluded. */
export function isCostingDisplayEnabled(env: CostingDisplayEnv | null | undefined): boolean {
  const raw = env?.COSTING_DISPLAY_ENABLED;
  if (raw == null) return true;
  return raw.trim().toLowerCase() !== "false";
}
