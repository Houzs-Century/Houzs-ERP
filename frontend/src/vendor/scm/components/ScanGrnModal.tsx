// ----------------------------------------------------------------------------
// ScanGrnModal — "Scan Delivery Order" on the Goods Receipt list: upload, check,
// then create (ScanCheckModal). Drafts are converted from PO lines, and nothing
// posts stock until the draft is posted.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { writeFailedAs } from '../lib/mutation-error';
import {
  PENDING_KEY, createFromScans, discardScans, fetchPending, fetchPoLines, localBlock, markGold, receiptItems, retryScan, saveReview, uploadScans,
  type CheckDoc, type CheckPoLine, type GrnReview, type PendingResp,
} from '../lib/scan-gr-check';
import { ScanCheckModal, type CheckResult } from './ScanCheckModal';
import { ScanGrnCheckCard } from './ScanGrnCheckCard';

type Data = PendingResp['data'];

const API = {
  fetchPending: () => fetchPending().then((r) => r.data),
  upload: uploadScans,
  save: saveReview,
  create: (ids: string[]): Promise<CheckResult[]> => createFromScans(ids).then((rs) => rs.map((r) => ({ id: r.id, ok: r.ok, docNumbers: r.grnNumbers ?? [], reason: r.reason ?? null, note: r.giftNote ?? null }))),
  discard: discardScans,
  retry: retryScan,
  gold: markGold,
};


export function ScanGrnModal({ onClose }: { onClose: () => void }) {
  // PO lines of a supplier the operator switched to, which the list did not carry.
  const [extra, setExtra] = useState<CheckPoLine[]>([]);
  const extraById = useMemo(() => new Map(extra.map((l) => [l.poItemId, l])), [extra]);
  const linesOf = (d: Data) => {
    const m = new Map(d.poLines.map((l) => [l.poItemId, l]));
    for (const [k, l] of extraById) m.set(k, l);
    return m;
  };
  const known = useMemo(() => new Set(extra.map((l) => l.supplierId)), [extra]);
  const [asked] = useState(() => new Set<string>());

  return (
    <ScanCheckModal<GrnReview, CheckDoc, Data>
      title="Scan delivery orders"
      noun="goods receipt"
      listName="Goods Receipt list"
      listPath="/scm/grns"
      dropText="Drop delivery orders here, or click — PDF, JPEG, PNG, WEBP. A PDF with many delivery orders is split for you."
      dateLabel="Received date"
      queryKey={PENDING_KEY}
      listKey={['grns']}
      api={API}
      blockOf={(r, d) => localBlock(r, linesOf(d))}
      withDate={(r, date) => ({ ...r, deliveryDate: date })}
      itemsOf={receiptItems}
      onEdit={(r) => {
        const s = r.supplierId;
        if (!s || known.has(s) || asked.has(s)) return;
        asked.add(s);
        fetchPoLines(s).then((ls) => setExtra((cur) => [...cur, ...ls])).catch(writeFailedAs('Could not load that supplier\'s PO lines'));
      }}
      renderCard={({ key, onOpenDoc, ...card }, data) => (
        <ScanGrnCheckCard key={key} {...card} suppliers={data.suppliers} poLines={[...linesOf(data).values()]} onOpenGrn={(id) => onOpenDoc(`/scm/grns/${id}`)} />
      )}
      onClose={onClose}
    />
  );
}
