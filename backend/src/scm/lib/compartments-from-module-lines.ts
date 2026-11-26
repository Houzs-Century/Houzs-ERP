
import { splitSofaCode } from '../shared';

export interface ModuleLineRow {
  item_code: string;
  buildKey: string | null | undefined;
}

/**
 * Compartment codes for ONE sofa build, reconstructed from its split module
 * lines. Pass the rows that share `targetBuildKey` (or all rows + the key — we
 * filter). Returns e.g. `['1A(LHF)','CNR']`; rows whose item_code has no sofa
 * module suffix (a bare model, a mattress, …) are excluded → can be `[]`.
 * Order follows input order; duplicates are preserved (the resolver de-dups by
 * MAX, so duplicates are harmless).
 */
export function buildCompartmentsFromModuleLines(
  rows: ModuleLineRow[],
  targetBuildKey?: string | null,
): string[] {
  const want = targetBuildKey != null ? String(targetBuildKey) : null;
  const out: string[] = [];
  for (const r of rows) {
    if (want !== null && String(r.buildKey ?? '') !== want) continue;
    const code = splitSofaCode(String(r.item_code ?? '')).sizeCode;
    if (code) out.push(code);
  }
  return out;
}
