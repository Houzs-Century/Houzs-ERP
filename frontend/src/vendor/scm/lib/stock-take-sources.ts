// The PO(s) holding a stock-take line's stock (Sim 2026-10-26), as the server
// sends them: oldest first, a PO number or the source of PO-less stock ("AC
// opening" = the AutoCount balance brought over at go-live). One formatter so
// the screen, the PDF and the Excel say the same thing.

export type StockSource = { label: string; po: boolean; qty: number };

/** Sum several lines' sources by label, first-seen order kept (a model's header row). */
export const mergeStockSources = (lists: ReadonlyArray<readonly StockSource[] | null | undefined>): StockSource[] => {
  const out = new Map<string, StockSource>();
  for (const list of lists) {
    for (const s of list ?? []) {
      const cur = out.get(s.label);
      if (cur) cur.qty += s.qty;
      else out.set(s.label, { ...s });
    }
  }
  return [...out.values()];
};

/** "HC-PO-010089 (1), AC opening (2)"; '' when nothing holds stock. */
export const fmtStockSources = (sources: readonly StockSource[] | null | undefined): string =>
  (sources ?? []).map((s) => `${s.label} (${s.qty})`).join(', ');
