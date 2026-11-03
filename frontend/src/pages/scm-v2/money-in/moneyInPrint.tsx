// ----------------------------------------------------------------------------
// moneyInPrint — every Money-in print opens the ERP's one print dialog
// (PrintPreviewModal; owner 2026-08-06: 全部打印的时候都需要有这个) with the
// design's line under it (the owner's Claude Design, batch 5 §9.1): which paper
// it is — `A5 landscape · half an A4 sheet · one receipt per page · same
// letterhead as the payment voucher` for official receipts, `A4 portrait · same
// letterhead as the payment voucher · one per page` for every other paper —
// and Print now / Download PDF / View full PDF going through the PDF itself.
//
// A page asks with `open(job)`: what the dialog names and the generator call
// that delivers it. A batch that holds both papers prints them as two files,
// the A5 receipts first (batch 5 §12 A2).
// ----------------------------------------------------------------------------

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { PrintPreviewModal, usePrintPreview, type PrintPreviewRow } from '../../../components/scm-v2/PrintPreviewModal';
import type { PdfAction } from '../../../vendor/scm/lib/pdf-common';

export type Paper = 'A5' | 'A4';

/** The design's line for a paper. */
export const paperLine = (paper: Paper): string => (paper === 'A5'
  ? 'A5 landscape · half an A4 sheet · one receipt per page · same letterhead as the payment voucher'
  : 'A4 portrait · same letterhead as the payment voucher · one per page');

/** The dialog's title for a batch: `Print 3 receipts`, `Print 1 document`. */
export const batchTitle = (n: number, receipts: boolean): string =>
  `Print ${n} ${receipts ? (n === 1 ? 'receipt' : 'receipts') : (n === 1 ? 'document' : 'documents')}`;

export type PrintJob = {
  /** The document's kind (or the batch's title) under the company name. */
  title: string;
  /** The number in the band's right column (a batch: how many). */
  docNo: string;
  /** The papers it prints on, A5 before A4. */
  papers: Paper[];
  /** Identifying lines, the paper line added after them. */
  rows?: PrintPreviewRow[];
  deliver: (action: PdfAction) => Promise<void>;
};

/** The print dialog for a page: `open(job)` shows it; render `modal`. */
export function useMoneyInPrint(onFail?: (e: unknown) => void): { open: (job: PrintJob) => void; modal: ReactNode } {
  const job = useRef<PrintJob | null>(null);
  const [shown, setShown] = useState<PrintJob | null>(null);
  const deliver = useCallback(async (action: PdfAction) => {
    const j = job.current;
    if (!j) return;
    try { await j.deliver(action); } catch (e) { onFail?.(e); }
  }, [onFail]);
  const print = usePrintPreview(deliver);
  const { openPreview } = print;
  const open = useCallback((j: PrintJob) => { job.current = j; setShown(j); openPreview(); }, [openPreview]);
  const modal = print.open && shown ? (
    <PrintPreviewModal open onClose={print.close} docTitle={shown.title} docNo={shown.docNo}
      rows={[...(shown.rows ?? []), ...shown.papers.map((p) => ({ label: p === 'A5' ? 'Paper' : shown.papers.length > 1 ? 'Then' : 'Paper', value: paperLine(p) }))]}
      {...print.handlers} />
  ) : null;
  return { open, modal };
}
