// HC-0158 / Sim 2026-10-26: a stock-take line's source POs (`source_pos`) as the
// printed sheet and the Excel write them. The screen draws its own note.

/** "HC-PO-010089 (1), HC-PO-010120 (2)"; '' when no PO traces. */
export const fmtSourcePos = (pos: ReadonlyArray<{ po: string; qty: number }> | null | undefined): string =>
  (pos ?? []).map((p) => `${p.po} (${p.qty})`).join(', ');
