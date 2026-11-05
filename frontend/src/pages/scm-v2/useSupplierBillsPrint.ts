// ----------------------------------------------------------------------------
// useSupplierBillsPrint — Supplier bills on paper (batch 4, step 8): one door
// for the list's ticks, a row's Print and Print + files, and the bill page.
// The printing itself (vendor/scm/lib/supplier-bills-print.ts) is reached
// through import(), so jsPDF stays out of the first load; a print that fails
// says so and prints nothing.
// ----------------------------------------------------------------------------

import { useCallback, useRef, useState } from 'react';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import type { BillPrintDoc } from '../../vendor/scm/lib/supplier-bills-print';
import type { BillRow } from './supplier-bills';

/** A list row as the print reads it. */
export const billPrintDocOf = (r: BillRow): BillPrintDoc => ({ kind: r.kind, id: r.id, number: r.number });

export function useSupplierBillsPrint() {
  const notify = useNotify();
  const [printing, setPrinting] = useState(false);
  /* A second click while one print renders is ignored, not queued. */
  const busy = useRef(false);
  const print = useCallback(async (docs: BillPrintDoc[], withFiles: boolean, action: PdfAction): Promise<void> => {
    if (docs.length === 0 || busy.current) return;
    busy.current = true;
    setPrinting(true);
    try {
      const { printSupplierBills } = await import('../../vendor/scm/lib/supplier-bills-print');
      await printSupplierBills(docs, { withFiles, action });
    } catch (e) {
      void notify({ title: 'Print failed — nothing was printed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      busy.current = false;
      setPrinting(false);
    }
  }, [notify]);
  return { printing, print };
}
