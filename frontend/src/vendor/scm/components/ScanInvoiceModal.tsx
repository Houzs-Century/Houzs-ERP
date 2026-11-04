// ----------------------------------------------------------------------------
// ScanInvoiceModal — "Scan invoice" on the Purchase Invoices list: upload, check,
// then create (ScanCheckModal). Drafts are converted from posted Goods Receipt
// lines; a draft books nothing until it is posted.
// ----------------------------------------------------------------------------

import {
  PI_PENDING_KEY, createPiFromScans, discardPiScans, fetchPiPending, markPiGold, piBlock, retryPiScan, savePiReview, uploadPiScans,
  type PiCheckDoc, type PiPending, type PiReview,
} from '../lib/scan-pi-check';
import { ScanCheckModal, type CheckResult } from './ScanCheckModal';
import { ScanPiCheckCard } from './ScanPiCheckCard';

const API = {
  fetchPending: fetchPiPending,
  upload: uploadPiScans,
  save: savePiReview,
  create: (ids: string[]): Promise<CheckResult[]> => createPiFromScans(ids).then((rs) => rs.map((r) => ({ id: r.id, ok: r.ok, docNumbers: r.docNumbers ?? [], reason: r.reason ?? null, note: null }))),
  discard: discardPiScans,
  retry: retryPiScan,
  gold: markPiGold,
};

const docNumber = (d: PiCheckDoc) => d.review?.invoiceNumber ?? null;

export function ScanInvoiceModal({ onClose }: { onClose: () => void }) {
  return (
    <ScanCheckModal<PiReview, PiCheckDoc, PiPending>
      title="Scan supplier invoices"
      noun="purchase invoice"
      listName="Purchase Invoices list"
      listPath="/scm/purchase-invoices"
      dropText="Drop supplier invoices here, or click — PDF, JPEG, PNG, WEBP. A PDF with many invoices is split for you."
      dateLabel="Invoice date"
      queryKey={PI_PENDING_KEY}
      listKey={['purchase-invoices']}
      api={API}
      blockOf={(r, d) => piBlock(r, new Map(d.billLines.map((l) => [l.grnItemId, l])))}
      withDate={(r, date) => ({ ...r, invoiceDate: date })}
      docNumber={docNumber}
      renderCard={({ key, onOpenDoc, ...card }, data) => (
        <ScanPiCheckCard key={key} {...card} suppliers={data.suppliers} billLines={data.billLines} onOpenPi={(id) => onOpenDoc(`/scm/purchase-invoices/${id}`)} />
      )}
      onClose={onClose}
    />
  );
}
