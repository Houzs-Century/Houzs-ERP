
export type SoPoChipRow = {
  source_po_union?: string[] | null;
  converted_po_nos?: string[] | null;
  source_po_adj?: boolean;
};

/** Desktop cell cap. Many-POs-to-one-SO is real (12 Houzs SOs carry 2, one
    carries 3, and shipped orders can add more), so the cell shows this many and
    then says how many are hidden — it never renders only the first in silence. */
export const PO_CELL_MAX = 3;

export function poCellChips(r: SoPoChipRow): { source: string[]; raised: string[]; all: string[] } {
  const source = (r.source_po_union ?? []).filter(Boolean);
  const raised = (r.converted_po_nos ?? []).filter((n) => Boolean(n) && !source.includes(n));
  return { source, raised, all: [...source, ...raised] };
}
