import { useCallback, useState } from 'react';
import type { PackingListRow, PackingRegionRow } from '../lib/packing-list-queries';
import type { PdfAction } from '../lib/pdf-common';

export function usePackingPrint(date: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(`The packing list could not be made. ${err instanceof Error ? err.message : ''}`.trim());
    } finally {
      setBusy(false);
    }
  }, []);

  const one = useCallback((list: PackingListRow, action: PdfAction) => {
    void run(async () => {
      const { generatePackingListPdf } = await import('../lib/packing-list-pdf');
      await generatePackingListPdf(list, { date, action });
    });
  }, [date, run]);

  const all = useCallback((lists: readonly PackingListRow[], action: PdfAction) => {
    void run(async () => {
      const { generatePackingListsPdf } = await import('../lib/packing-list-pdf');
      await generatePackingListsPdf(lists, { date, action });
    });
  }, [date, run]);

  const regions = useCallback((rows: readonly PackingRegionRow[], action: PdfAction) => {
    void run(async () => {
      const { generatePackingRegionsPdf } = await import('../lib/packing-list-pdf');
      await generatePackingRegionsPdf(rows, { date, action });
    });
  }, [date, run]);

  return { busy, error, one, all, regions };
}
