// ----------------------------------------------------------------------------
// DoLoadScan — the landing page behind the Delivery Order print's QR (2026-08-21,
// owner: the warehouse confirms by scanning the paper that travels with the
// goods, instead of remembering a button in a list).
//
// /scm/do-load?id=<delivery order uuid>
//
// THREE SCANS, ONE STEP EACH (owner, 2026-08-25/26). It did one step — DRAFT →
// LOADED — until this change. His words:
//
//   「(a) Storekeeper 扫码确认货物装上罗里 (b) 司机出发（IN TRANSIT）(c) 送达
//    （DELIVERED）」
//   「就是我状态只要一点，它基本上都只能剩最后一个状态（下一个状态）」
//
// So the page shows the NEXT rung and only the next rung. There is no picker, no
// way back, and no way to skip one — not because the server forbids it (it does
// not; forward and lateral moves are all accepted, see do-next-step.ts) but
// because the ladder is a record of physical events and a person who can choose
// among them is a person who can record one that did not happen.
//
//   the office raises the DO     -> LOADED      shown as Confirmed
//   ① storekeeper: on the lorry  -> DISPATCHED  shown as Loaded
//   ② driver: departs            -> IN_TRANSIT  shown as In Transit
//   ③ driver: delivered          -> DELIVERED   shown as Delivered
//
// The ladder itself lives in vendor/scm/lib/do-next-step.ts, next to the
// office's one. This file renders it and owns no status logic of its own.
//
// STOCK IS NOT TOUCHED BY SCANS ② OR ③ — 「只要我一开 DO，我就扣库存。In transit、
// Delivered，这些都只是状态，看一下情况而已。」 Scan ① is a special case only
// because a DRAFT delivery order has not deducted yet: confirming it lands
// LOADED, which IS the deduction (owner 2026-08-22, DO_SHIPPED_STATES). Every
// rung past that finds the stock already out and writes nothing to inventory.
//
// SCAN ③ IS NOT A SIGNED RECEIPT AND THE SCREEN SAYS SO. See bug 0481: a "Mark
// Signed" button wrote a delivered-counting status and collected no signature,
// no photo and no GPS. This page writes DELIVERED and collects none of them
// either, so DO_SCAN_DELIVERED_EVIDENCE_NOTE is rendered beside the button
// BEFORE it is pressed, naming the loss and naming Proof of Delivery as the
// screen that captures a real one. Bug 0480 is why the capture was not
// duplicated here instead.
//
// A REPEAT SCAN NEVER DOUBLE-WRITES. After a successful rung the page shows the
// confirmation and no button at all until the paper is scanned again — one scan,
// one step. A scan of a document somebody else has already advanced simply shows
// that document's own next rung, which is the expected case on a busy dock.
// ----------------------------------------------------------------------------
import { useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, PackageCheck, XCircle, PauseCircle, Loader2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderStatus,
} from '../../vendor/scm/lib/delivery-order-queries';
import { PageHeader } from '../../components/Layout';
import {
  doScanStep,
  doScanBlockReason,
  doScanConfirmation,
  type DoScanStep,
} from '../../vendor/scm/lib/do-next-step';

export const DoLoadScan = () => {
  const [params] = useSearchParams();
  const id = params.get('id');
  const detailQ = useMfgDeliveryOrderDetail(id);
  const updateStatus = useUpdateMfgDeliveryOrderStatus();
  /* What THIS scan wrote, held locally rather than read back off the refetched
     row. Two reasons, and the second is the one that matters: the detail query
     is invalidated by the mutation, so between success and refetch the row still
     carries the OLD status and would render the same button again; and holding
     it here is what keeps one scan to one step, since the confirmation card
     stands until the paper is scanned afresh. */
  const [written, setWritten] = useState<DoScanStep['status'] | null>(null);

  const doRow = detailQ.data?.deliveryOrder as
    | {
        id: string; do_number: string; debtor_name: string | null; status: string | null;
        city: string | null; state: string | null; on_hold?: boolean | null;
      }
    | undefined;
  const lineCount = detailQ.data?.items.length ?? 0;

  /* `?? null`, never `?? false`: the column is nullable and a missing value is
     not a proven "not held". doScanStep treats only an explicit `true` as held,
     so null behaves as not-held either way — but the coercion happens where the
     rule is written, not silently here. */
  const onHold = doRow?.on_hold ?? null;
  const step = doRow ? doScanStep(doRow.status, onHold) : null;
  const blockReason = doRow ? doScanBlockReason(doRow.status, onHold) : null;

  const verdict = useMemo(() => {
    if (!id) return { tone: 'warn' as const, title: 'No delivery order in this link', body: 'The QR did not carry a delivery order. Re-print the DO and scan the code on the new copy.' };
    if (detailQ.isLoading) return null;
    if (detailQ.isError || !doRow) return { tone: 'warn' as const, title: 'Delivery order not found', body: 'This link does not match a delivery order in the company you are signed into. Check the company switcher, or re-print the DO.' };
    if (written) return { tone: 'ok' as const, title: `${doRow.do_number} updated`, body: doScanConfirmation(written) };
    if (blockReason) {
      const tone = onHold === true ? ('hold' as const) : ('warn' as const);
      return { tone, title: `${doRow.do_number}`, body: blockReason };
    }
    return null; // a rung is available — show the action
  }, [id, detailQ.isLoading, detailQ.isError, doRow, written, blockReason, onHold]);

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-4">
      <PageHeader eyebrow="Delivery" title="Scan delivery order" />
      {detailQ.isLoading && (
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-6 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading the delivery order…
        </div>
      )}
      {doRow && (
        <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm">
          <div className="font-mono text-base font-semibold">{doRow.do_number}</div>
          <div>{doRow.debtor_name ?? '—'}</div>
          <div className="text-ink-secondary">
            {[doRow.city, doRow.state].filter(Boolean).join(', ') || '—'} · {lineCount} line{lineCount === 1 ? '' : 's'}
          </div>
        </div>
      )}
      {/* Hold shares amber with the other refusals on purpose — a hold is
          reversible and deliberate, and red is what this system reserves for
          cancelled (HoldChip.tsx states the same rule). Only the ICON differs,
          so the two read apart at a glance without a second colour. */}
      {verdict && (
        <div className={`flex items-start gap-3 rounded-md border px-4 py-4 text-sm ${
          verdict.tone === 'ok'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
            : 'border-amber-300 bg-amber-50 text-amber-900'
        }`}>
          {verdict.tone === 'ok' ? <CheckCircle2 size={20} className="mt-0.5 shrink-0" />
            : verdict.tone === 'hold' ? <PauseCircle size={20} className="mt-0.5 shrink-0" />
            : <XCircle size={20} className="mt-0.5 shrink-0" />}
          <div>
            <div className="font-semibold">{verdict.title}</div>
            <div>{verdict.body}</div>
          </div>
        </div>
      )}
      {doRow && step && !verdict && (
        <>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={updateStatus.isPending}
            onClick={() =>
              updateStatus.mutate(
                { id: doRow.id, status: step.status },
                { onSuccess: () => setWritten(step.status) },
              )
            }
          >
            <PackageCheck size={18} /> {updateStatus.isPending ? 'Saving…' : step.label}
          </Button>
          <p className="text-xs text-ink-secondary">{step.note}</p>
          {updateStatus.isError && (
            <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
              {updateStatus.error instanceof Error ? updateStatus.error.message : 'Could not save — try again or tell the dispatcher.'}
            </div>
          )}
        </>
      )}
      {doRow && (
        <p className="text-xs">
          <Link className="text-accent underline" to={`/scm/delivery-orders/${doRow.id}`}>Open the full delivery order</Link>
        </p>
      )}
    </div>
  );
};

export default DoLoadScan;
