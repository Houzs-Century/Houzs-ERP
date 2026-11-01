import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Phone, Truck } from 'lucide-react';
import { ResizableDetailDrawer } from '../../../components/ResizableDetailDrawer';
import { Button } from '../../../components/Button';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { fmtSen, fmtDateTime } from '../../../vendor/shared/format';
import { useNotify } from '../../../vendor/scm/components/NotifyDialog';
import { useDeliveryRemarks, useAddRemark } from '../../../vendor/scm/lib/delivery-remarks-queries';
import { DoProofOfDeliveryCard, type DoPodFields } from '../DoProofOfDeliveryCard';
import type { LorryRunVM, DocRowVM } from './vm';

/** Dispatch / customer-service remarks thread for one order (phase 3). */
function RemarksSection({ soDocNo }: { soDocNo: string }) {
  const remarks = useDeliveryRemarks(soDocNo);
  const addRemark = useAddRemark();
  const notify = useNotify();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const list = remarks.data ?? [];

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await addRemark.mutateAsync({ soDocNo, body });
      setDraft('');
    } catch (e) {
      void notify({ title: 'Could not add remark', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
    setBusy(false);
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Remarks</div>
      {remarks.isLoading
        ? <div className="text-[12px] text-ink-muted">Loading…</div>
        : list.length === 0 && <div className="text-[12px] text-ink-muted">No remarks yet.</div>}
      <div className="space-y-2">
        {list.map((r) => (
          <div key={r.id} className="rounded-md border border-accent/20 bg-accent-soft/50 px-2.5 py-1.5">
            <div className="whitespace-pre-wrap text-[12.5px] text-ink">{r.body}</div>
            <div className="mt-0.5 text-[10.5px] text-ink-muted">{r.authorName ?? 'Unknown'} · {fmtDateTime(r.createdAt)}</div>
          </div>
        ))}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Add a remark for dispatch / customer service…"
        rows={2}
        className="mt-2 w-full resize-none rounded-md border border-border bg-surface px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-primary"
      />
      <div className="mt-1.5 flex justify-end">
        <Button variant="primary" onClick={() => void submit()} disabled={busy || !draft.trim()}>
          {busy ? 'Adding…' : 'Add remark'}
        </Button>
      </div>
    </div>
  );
}

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  done: { label: 'Delivered', cls: 'bg-synced-bg text-synced' },
  active: { label: 'On the way', cls: 'bg-[#e6eaf4] text-learning' },
  overdue: { label: 'Late', cls: 'bg-err-bg text-err' },
  scheduled: { label: 'Not started', cls: 'bg-surface-dim text-ink-muted' },
};

function useDoPod(doId: string | null) {
  return useQuery({
    queryKey: ['fleet-do-pod', doId ?? ''],
    queryFn: () => authedFetch<{ deliveryOrder: DoPodFields & Record<string, unknown> }>(`/delivery-orders-mfg/${doId}`),
    enabled: !!doId,
    staleTime: 15_000,
  });
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-b border-border-subtle py-2 last:border-b-0">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-0.5 text-[13px] text-ink">{value || '—'}</div>
    </div>
  );
}

/** The right order-detail drawer: customer + lorry call cards, the fields, the
 *  POD/timeline (reusing DoProofOfDeliveryCard), and phase-3 placeholders for
 *  Change-lorry + Remarks. `run` is the lorry the drop sits on (null for a
 *  still-to-arrange drop). */
export function OrderDrawer({
  doc, run, salespersonName, onClose,
}: {
  doc: DocRowVM | null;
  run: LorryRunVM | null;
  salespersonName: string;
  onClose: () => void;
}) {
  const pod = useDoPod(doc?.latestLiveDoId ?? null);
  const pill = doc ? STATUS_PILL[doc.status] : null;

  return (
    <ResizableDetailDrawer open={!!doc} onClose={onClose} ariaLabel="Delivery order detail">
      {doc && (
        <div className="flex h-full flex-col">
          {/* header */}
          <div className="flex items-start justify-between border-b border-border p-4">
            <div className="min-w-0">
              <div className="font-mono text-[11px] font-semibold text-accent">{doc.soDocNo}</div>
              <div className="mt-1 truncate text-[19px] font-bold text-ink">{doc.customer || '—'}</div>
              <div className="mt-1 flex items-center gap-2">
                {pill && <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${pill.cls}`}>{pill.label}</span>}
                {doc.late && doc.lateReason && <span className="text-[11.5px] text-err">{doc.lateReason}</span>}
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-muted hover:bg-surface-2 hover:text-ink">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* customer + lorry cards */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-surface p-3">
                <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Customer</div>
                <div className="mt-1 text-[13px] text-ink">{doc.phone || 'No phone'}</div>
                {doc.phone && (
                  <a href={`tel:${doc.phone}`} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-semibold text-primary hover:bg-primary-soft">
                    <Phone size={13} /> Call customer
                  </a>
                )}
              </div>
              <div className="rounded-lg border border-border bg-surface p-3" style={run ? { borderLeft: `3px solid ${run.color}` } : undefined}>
                <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Lorry</div>
                {run ? (
                  <>
                    <div className="mt-1 text-[13px] text-ink">
                      <span className="font-mono font-semibold">{run.plate}</span>
                      {doc.stopNo != null && <span className="text-ink-muted"> · stop {doc.stopNo}</span>}
                    </div>
                    <div className="text-[12px] text-ink-secondary">{run.driverName ?? 'No driver'}</div>
                    {run.driverPhone && (
                      <a href={`tel:${run.driverPhone}`} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-semibold text-primary hover:bg-primary-soft">
                        <Phone size={13} /> Call driver
                      </a>
                    )}
                  </>
                ) : (
                  <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-ink-muted"><Truck size={13} /> Not on a lorry yet</div>
                )}
              </div>
            </div>

            {/* change lorry — phase 3 */}
            <div className="rounded-lg border border-dashed border-border bg-surface-2 p-3 text-[12px] text-ink-muted">
              Change lorry &amp; renumber stops arrives with the move-stop update.
            </div>

            {/* fields */}
            <div className="rounded-lg border border-border bg-surface p-3">
              <Field label="SO" value={<span className="font-mono">{doc.soDocNo}</span>} />
              <Field label="DO" value={doc.doNumber ? <span className="font-mono">{doc.doNumber}</span> : '—'} />
              <Field label="Ref" value={doc.ref ? <span className="font-mono">{doc.ref}</span> : '—'} />
              <Field label="Address" value={doc.address} />
              <Field label="Region" value={doc.region} />
              <Field label="Time slot" value={doc.order.time_range || '—'} />
              <Field label="Salesperson" value={salespersonName} />
              <Field label="Branding" value={doc.branding} />
              <Field label="Amount" value={<span className="font-mono tabular-nums">{fmtSen(doc.amountSen)}</span>} />
              <Field label="Load" value={`${doc.units} unit${doc.units === 1 ? '' : 's'}`} />
            </div>

            {/* remarks thread (phase 3) */}
            <RemarksSection soDocNo={doc.soDocNo} />

            {/* POD + timeline */}
            {doc.latestLiveDoId ? (
              pod.data?.deliveryOrder
                ? <DoProofOfDeliveryCard h={pod.data.deliveryOrder} />
                : <div className="rounded-lg border border-border bg-surface p-4 text-[12.5px] text-ink-muted">{pod.isLoading ? 'Loading proof of delivery…' : 'Proof of delivery unavailable.'}</div>
            ) : (
              <div className="rounded-lg border border-border bg-surface p-4 text-[12.5px] text-ink-muted">No delivery order cut yet — proof of delivery appears once the DO exists.</div>
            )}
          </div>
        </div>
      )}
    </ResizableDetailDrawer>
  );
}
