// ----------------------------------------------------------------------------
// DoLoadScan — the landing page behind the Delivery Order print's
// "SCAN · MARK LOADED" QR (2026-08-21, owner: warehouse confirms loading by
// scanning the paper that travels with the goods, instead of remembering a
// button in a list).
//
// /scm/do-load?id=<delivery order uuid>
//
// One screen, one decision. The page reads the DO and shows exactly one of:
//   DRAFT       → the [Confirm loading] button. Pressing it is the ordinary
//                 status PATCH to LOADED — audited, and the transition guard
//                 owns legality (a shipped DO can never be pulled back).
//   LOADED      → "already loaded" (a re-scan is the EXPECTED case on a busy
//                 dock — two people, one pallet — so it reads as confirmation,
//                 never as an error).
//   shipped+    → "already dispatched" — nothing to do here; stock left when
//                 the DO was dispatched, not when it was loaded.
//   CANCELLED   → says so.
//
// Deliberately NOT here: any stock movement. Loading is physical staging;
// the inventory OUT fires on DISPATCHED (shared/do-shipped-states.ts), and
// this page must never grow a reason to change that.
// ----------------------------------------------------------------------------
import { useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, PackageCheck, Truck, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderStatus,
} from '../../vendor/scm/lib/delivery-order-queries';
import { PageHeader } from '../../components/Layout';

const SHIPPED = new Set(['DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED']);

export const DoLoadScan = () => {
  const [params] = useSearchParams();
  const id = params.get('id');
  const detailQ = useMfgDeliveryOrderDetail(id);
  const updateStatus = useUpdateMfgDeliveryOrderStatus();

  const doRow = detailQ.data?.deliveryOrder as
    | { id: string; do_number: string; debtor_name: string | null; status: string | null; city: string | null; state: string | null }
    | undefined;
  const lineCount = detailQ.data?.items?.length ?? 0;
  const status = (doRow?.status ?? '').toUpperCase();
  const justLoaded = updateStatus.isSuccess;

  const verdict = useMemo(() => {
    if (!id) return { tone: 'warn' as const, title: 'No delivery order in this link', body: 'The QR did not carry a delivery order. Re-print the DO and scan the code on the new copy.' };
    if (detailQ.isLoading) return null;
    if (detailQ.isError || !doRow) return { tone: 'warn' as const, title: 'Delivery order not found', body: 'This link does not match a delivery order in the company you are signed into. Check the company switcher, or re-print the DO.' };
    if (justLoaded || status === 'LOADED') return { tone: 'ok' as const, title: `${doRow.do_number} is loaded`, body: justLoaded ? 'Loading confirmed — the dispatcher can send the truck.' : 'Loading was already confirmed. Nothing more to do here.' };
    if (SHIPPED.has(status)) return { tone: 'info' as const, title: `${doRow.do_number} has already been dispatched`, body: 'The goods left the warehouse when this order was dispatched — there is no loading step left to confirm.' };
    if (status === 'CANCELLED') return { tone: 'warn' as const, title: `${doRow.do_number} is cancelled`, body: 'A cancelled delivery order is not loaded. Check with the dispatcher before putting anything on the truck.' };
    return null; // DRAFT → show the action
  }, [id, detailQ.isLoading, detailQ.isError, doRow, status, justLoaded]);

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-4">
      <PageHeader eyebrow="Warehouse" title="Confirm loading" />
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
      {verdict && (
        <div className={`flex items-start gap-3 rounded-md border px-4 py-4 text-sm ${
          verdict.tone === 'ok' ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
          : verdict.tone === 'info' ? 'border-sky-300 bg-sky-50 text-sky-900'
          : 'border-amber-300 bg-amber-50 text-amber-900'
        }`}>
          {verdict.tone === 'ok' ? <CheckCircle2 size={20} className="mt-0.5 shrink-0" />
            : verdict.tone === 'info' ? <Truck size={20} className="mt-0.5 shrink-0" />
            : <XCircle size={20} className="mt-0.5 shrink-0" />}
          <div>
            <div className="font-semibold">{verdict.title}</div>
            <div>{verdict.body}</div>
          </div>
        </div>
      )}
      {doRow && !verdict && (
        <>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={updateStatus.isPending}
            onClick={() => updateStatus.mutate({ id: doRow.id, status: 'LOADED' })}
          >
            <PackageCheck size={18} /> {updateStatus.isPending ? 'Confirming…' : 'Confirm loading'}
          </Button>
          <p className="text-xs text-ink-secondary">
            This records that the goods are on the truck. Stock leaves the warehouse when the
            dispatcher sends the truck (Dispatch), not now.
          </p>
          {updateStatus.isError && (
            <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
              {updateStatus.error instanceof Error ? updateStatus.error.message : 'Could not confirm loading — try again or tell the dispatcher.'}
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
