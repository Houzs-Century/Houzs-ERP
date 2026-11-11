import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Phone, Truck } from 'lucide-react';
import { ResizableDetailDrawer } from '../../../components/ResizableDetailDrawer';
import { Button } from '../../../components/Button';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { fmtSen, fmtDateTime } from '../../../vendor/shared/format';
import { useNotify } from '../../../vendor/scm/components/NotifyDialog';
import { useDeliveryRemarks, useAddRemark } from '../../../vendor/scm/lib/delivery-remarks-queries';
import { useMoveStop } from '../../../vendor/scm/lib/trips-queries';
import { DoProofOfDeliveryCard, type DoPodFields } from '../DoProofOfDeliveryCard';
import type { LorryRunVM, DocRowVM } from './vm';
import { issueKeysOf } from './AllOrders';
import { DeliveryIssuesCard } from '../../../components/scm-v2/DeliveryIssuesCard';
import { issuesForRow, runKeysOf, useRunDeliveryIssues } from '../../../vendor/scm/lib/delivery-issue-queries';

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
  active: { label: 'On the way', cls: 'bg-[color:var(--hz-dk-surface-2,#e6eaf4)] text-learning' },
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

/** Change-lorry: move this order's delivery stop to another lorry run of the day
 *  at a chosen position (phase 3b). Disabled once delivered or before a DO exists. */
function ChangeLorrySection({ doc, runs, onMoved }: { doc: DocRowVM; runs: LorryRunVM[]; onMoved: () => void }) {
  const move = useMoveStop();
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [targetTripId, setTargetTripId] = useState('');
  const [position, setPosition] = useState(1);
  const [busy, setBusy] = useState(false);

  const delivered = doc.status === 'done';
  const targetRun = runs.find((r) => r.trip?.id === targetTripId) ?? null;
  const maxPos = (targetRun ? targetRun.docs.length : 0) + 1;

  const submit = async () => {
    if (!doc.latestLiveDoId || !targetTripId) return;
    setBusy(true);
    try {
      const r = await move.mutateAsync({ doId: doc.latestLiveDoId, targetTripId, position });
      if (!r.ok) void notify({ title: 'Moved with problems', body: `${r.failed ?? 0} stop update(s) failed.`, tone: 'error' });
      setOpen(false);
      onMoved();
    } catch (e) {
      void notify({ title: 'Could not change lorry', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
    setBusy(false);
  };

  const selectCls = 'h-9 w-full rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-primary';
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Change lorry</div>
      {delivered ? (
        <div className="text-[12px] text-ink-muted">Delivered — the lorry can't be changed.</div>
      ) : !doc.latestLiveDoId ? (
        <div className="text-[12px] text-ink-muted">No delivery order cut yet — assign a lorry from the board first.</div>
      ) : !open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-[12.5px] font-semibold text-primary hover:underline">
          Move this order to another lorry…
        </button>
      ) : (
        <div className="space-y-2">
          <label className="block">
            <span className="text-[11px] text-ink-muted">Lorry</span>
            <select className={selectCls} value={targetTripId} onChange={(e) => { setTargetTripId(e.target.value); setPosition(1); }}>
              <option value="">— pick a lorry run —</option>
              {runs.filter((r) => r.trip).map((r) => (
                <option key={r.trip!.id} value={r.trip!.id}>
                  {r.plate}{r.trip!.id === doc.order.trip_id ? ' (current)' : ''} · {r.docs.length} drops
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-muted">Stop no.</span>
            <select className={selectCls} value={position} onChange={(e) => setPosition(Number(e.target.value))} disabled={!targetRun}>
              {Array.from({ length: maxPos }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>Stop {n}{n === maxPos ? ' (last)' : ''}</option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || !targetTripId}>{busy ? 'Moving…' : 'Move order'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The right order-detail drawer: customer + lorry call cards, the fields, the
 *  POD/timeline (reusing DoProofOfDeliveryCard), and phase-3 placeholders for
 *  Change-lorry + Remarks. `run` is the lorry the drop sits on (null for a
 *  still-to-arrange drop). */
export function OrderDrawer({
  doc, run, runs, salespersonName, onClose,
}: {
  doc: DocRowVM | null;
  run: LorryRunVM | null;
  /** The day's runs, for the Change-lorry target picker. */
  runs: LorryRunVM[];
  salespersonName: string;
  onClose: () => void;
}) {
  const pod = useDoPod(doc?.latestLiveDoId ?? null);
  const pill = doc ? STATUS_PILL[doc.status] : null;
  const issueKeys = doc ? issueKeysOf(doc) : null;
  const issuesQ = useRunDeliveryIssues(runKeysOf(issueKeys ? [issueKeys] : []), !!doc);
  const issues = issueKeys ? issuesForRow(issuesQ.data, issueKeys) : [];

  return (
    <ResizableDetailDrawer open={!!doc} onClose={onClose} ariaLabel="Delivery order detail">
      {doc && (
        <div className="flex h-full flex-col">
          {/* header */}
          <div className="flex items-start justify-between border-b border-border p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] font-semibold text-accent">{doc.rowType === 'so' ? doc.soDocNo : (doc.codeLine || doc.soDocNo)}</span>
                {doc.jobLabel && <span className="rounded bg-[color:var(--hz-dk-surface-2,#e6eaf4)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-brand text-learning">{doc.jobLabel}</span>}
              </div>
              <div className="mt-1 truncate text-[19px] font-bold text-ink">{doc.customer || '—'}</div>
              <div className="mt-1 flex items-center gap-2">
                {pill && <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${pill.cls}`}>{pill.label}</span>}
                {issues.length > 0 && <span className="rounded-full bg-err-bg px-2 py-0.5 text-[10.5px] font-bold text-err">With issue</span>}
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

            {/* What the crew reported at POD ("Delivered with issue") + its Service Case. */}
            <DeliveryIssuesCard issues={issues} showDo />

            {/* change lorry (phase 3b) — SO deliveries only; a non-SO job is
                scheduled + crewed in its own module (DP / PMS / ASSR), not moved
                through the DO-based mover here. */}
            {doc.rowType === 'so' && <ChangeLorrySection doc={doc} runs={runs} onMoved={onClose} />}

            {/* fields — an SO delivery shows SO · DO · Ref + its money/load; a non-SO
                job shows its own job type + document and skips the order-money
                columns it does not carry. */}
            <div className="rounded-lg border border-border bg-surface p-3">
              {doc.rowType === 'so' ? (
                <>
                  <Field label="SO" value={<span className="font-mono">{doc.soDocNo}</span>} />
                  <Field label="DO" value={doc.doNumber ? <span className="font-mono">{doc.doNumber}</span> : '—'} />
                  <Field label="Ref" value={doc.ref ? <span className="font-mono">{doc.ref}</span> : '—'} />
                </>
              ) : (
                <>
                  <Field label="Job" value={doc.jobLabel ?? '—'} />
                  <Field label="Document" value={doc.codeLine ? <span className="font-mono">{doc.codeLine}</span> : '—'} />
                </>
              )}
              <Field label="Address" value={doc.address} />
              <Field label="Region" value={doc.region} />
              <Field label="Time slot" value={doc.order.time_range || '—'} />
              {doc.rowType === 'so' && <Field label="Salesperson" value={salespersonName} />}
              <Field label="Branding" value={doc.branding} />
              {doc.rowType === 'so' && <Field label="Amount" value={<span className="font-mono tabular-nums">{fmtSen(doc.amountSen)}</span>} />}
              {doc.rowType === 'so' && <Field label="Load" value={`${doc.units} unit${doc.units === 1 ? '' : 's'}`} />}
            </div>

            {/* remarks thread (phase 3) — the thread is keyed on a real SO doc no.,
                so it is shown for SO deliveries only (a non-SO job has none). */}
            {doc.rowType === 'so' && <RemarksSection soDocNo={doc.soDocNo} />}

            {/* POD + timeline — off the SO's delivery order; a non-SO job has no DO,
                its progress lives in its own module. */}
            {doc.rowType === 'so' && (
              doc.latestLiveDoId ? (
                pod.data?.deliveryOrder
                  ? <DoProofOfDeliveryCard h={pod.data.deliveryOrder} />
                  : <div className="rounded-lg border border-border bg-surface p-4 text-[12.5px] text-ink-muted">{pod.isLoading ? 'Loading proof of delivery…' : 'Proof of delivery unavailable.'}</div>
              ) : (
                <div className="rounded-lg border border-border bg-surface p-4 text-[12.5px] text-ink-muted">No delivery order cut yet — proof of delivery appears once the DO exists.</div>
              )
            )}
          </div>
        </div>
      )}
    </ResizableDetailDrawer>
  );
}
