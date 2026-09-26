/* ----------------------------------------------------------------------------
   PackingListsSection — the PACKING LISTS surface, under Last Mile Delivery.

   The owner put it here on purpose (2026-08-25): 「packing list 不是跟着 delivery
   order 走的，应该挂在 transportation 的 last-mile delivery 模块下。因为我们还有我
   们的 delivery 那一边，可能掺杂了不一样公司的一些 DO」— a run can legitimately
   carry both companies' delivery orders, so the list belongs to the RUN, not to
   any one document.

   ONE ROW PER TRIP for the chosen day, because that is what a packing list is:
   one lorry, one day. Three lorries out today = three rows.

   Extracted as its own component rather than written into FleetDay.tsx so that
   page keeps its size; FleetDay mounts it and owns the date + depot, which are
   already its URL state.

   THE CHIP MAY REFUSE TO ANSWER. `rollupDeliveryStatus` returns null when there
   is no readable delivery order on the run, and this renders a dash for that
   rather than a confident "Delivered 0/0" — the company predicate matching
   nothing and a run with nothing on it are the same shape from here.
   ---------------------------------------------------------------------------- */

import { useState } from 'react';
import { Printer, QrCode, PackageCheck } from 'lucide-react';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { DataTable, type Column } from '../../../components/DataTable';
import { usePackingLists, type PackingListRow } from '../lib/packing-list-queries';
import { rollupDeliveryStatus, rollupLabel, fmtM3 } from '../lib/packing-list-model';
import { generatePackingListPdf, packingRunUrl } from '../lib/packing-list-pdf';

const TONE_FOR: Record<string, 'neutral' | 'warning' | 'success'> = {
  Draft: 'neutral',
  Confirmed: 'warning',
  Loaded: 'warning',
  'In Transit': 'warning',
  Delivered: 'success',
};

export function PackingListsSection(props: { date: string; warehouseId: string | null }) {
  const { date, warehouseId } = props;
  const query = usePackingLists({ date, warehouseId });
  const [qrOpen, setQrOpen] = useState<Set<string>>(new Set());
  const lists = query.data?.lists ?? [];

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const toggleQr = (tripId: string) =>
    setQrOpen((prev) => (prev.has(tripId) ? new Set() : new Set([tripId])));
  const columns: Column<PackingListRow>[] = [
    { key: 'trip', label: 'Packing / Trip no', render: (l) => <span className="font-mono text-ink">{l.trip_no ?? '—'}</span>, getValue: (l) => l.trip_no ?? '' },
    { key: 'date', label: 'Date', render: (l) => l.trip_date ?? date, getValue: (l) => l.trip_date ?? date, exportFormat: 'date' },
    { key: 'lorry', label: 'Lorry', render: (l) => <span className="font-mono font-semibold text-ink">{l.lorry_plate ?? '—'}</span>, getValue: (l) => l.lorry_plate ?? '' },
    { key: 'driver', label: 'Driver', render: (l) => l.driver_name ?? '—', getValue: (l) => l.driver_name ?? '' },
    { key: 'dos', label: 'DOs', align: 'right', render: (l) => l.do_count, getValue: (l) => l.do_count, exportFormat: 'number' },
    { key: 'stops', label: 'Stops', align: 'right', render: (l) => l.stop_count, getValue: (l) => l.stop_count, exportFormat: 'number' },
    { key: 'units', label: 'Units', align: 'right', render: (l) => l.units, getValue: (l) => l.units, exportFormat: 'number' },
    {
      key: 'volume', label: 'Volume', align: 'right',
      render: (l) => {
        const volume = fmtM3(l.m3_milli);
        return <span title={volume ? undefined : 'No delivery order on this run carries a volume figure'}>{volume ?? '—'}</span>;
      },
      getValue: (l) => fmtM3(l.m3_milli) ?? '',
    },
    {
      key: 'status', label: 'Delivery status',
      render: (l) => {
        const rollup = rollupDeliveryStatus(l.stops);
        const label = rollupLabel(rollup);
        return (
          <>
            {label
              ? <Badge tone={TONE_FOR[rollup?.label ?? ''] ?? 'neutral'} caseless>{label}</Badge>
              : <span className="text-ink-muted" title="No delivery order on this run could be read">—</span>}
            {rollup && rollup.cancelled > 0 && <span className="ml-1.5 text-[11px] text-ink-muted">{rollup.cancelled} cancelled</span>}
          </>
        );
      },
      getValue: (l) => rollupLabel(rollupDeliveryStatus(l.stops)) ?? '',
    },
    {
      key: 'actions', label: 'Actions', align: 'right',
      render: (l) => (
        <>
          <Button variant="ghost" icon={<Printer size={13} />} onClick={() => void generatePackingListPdf(l, { date, action: 'print' })}>
            Print
          </Button>
          <Button variant="ghost" icon={<QrCode size={13} />} onClick={() => toggleQr(l.trip_id)}>
            QR
          </Button>
        </>
      ),
    },
  ];

  return (
    <div className="mt-4 space-y-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PackageCheck size={14} strokeWidth={1.75} />
        <span className="text-[13px] font-semibold text-ink">Packing lists</span>
        <span className="text-[11.5px] text-ink-muted">
          One per lorry per day. The printed sheet runs in LOADING order — the last delivery goes in first.
        </span>
      </div>

      <DataTable<PackingListRow>
        tableId="packing-lists"
        exportName={`packing-lists-${date}`}
        exportXlsx
        columns={columns}
        rows={query.error ? null : query.data ? lists : null}
        loading={query.isLoading}
        error={query.error ? `Could not load the packing lists for this day. ${query.error instanceof Error ? query.error.message : ''}` : null}
        emptyLabel="This day has no trips. A packing list is a trip, so one appears here for every lorry once Delivery Time Arrangement has sequenced the day."
        getRowKey={(list) => list.trip_id}
        expandable={{
          render: () => <QrNote origin={origin} />,
          rowKey: (list) => list.trip_id,
          expandedIds: qrOpen,
          onExpandedChange: setQrOpen,
        }}
      />
    </div>
  );
}

/* Explains the code WITHOUT minting one: minting is a write, and opening a
   disclosure panel must not create a public credential. The sheet itself arms
   the token when it is printed. */
function QrNote({ origin }: { origin: string }) {
  const runOrigin = origin ? `${origin.replace(/\/+$/, '')}/d/…` : '';
  return (
    <p className="py-1 text-[11.5px] text-ink-secondary">
      The printed sheet carries a scannable code for this run. It opens{' '}
      <span className="break-all font-mono">{runOrigin}</span> — a PUBLIC page: anyone holding the
      printed sheet can open it without signing in, and scanning it records the next step for every drop on
      this run. Treat the sheet like the goods. If one goes astray, ask the office to revoke its code.
    </p>
  );
}
