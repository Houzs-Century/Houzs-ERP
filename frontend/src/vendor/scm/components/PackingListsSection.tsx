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
  const [qrFor, setQrFor] = useState<string | null>(null);
  const lists = query.data?.lists ?? [];

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="mt-4 space-y-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PackageCheck size={14} strokeWidth={1.75} />
        <span className="text-[13px] font-semibold text-ink">Packing lists</span>
        <span className="text-[11.5px] text-ink-muted">
          One per lorry per day. The printed sheet runs in LOADING order — the last delivery goes in first.
        </span>
      </div>

      {query.isLoading && <p className="text-[12.5px] text-ink-muted">Loading this day&rsquo;s packing lists…</p>}

      {query.error && (
        <p className="rounded-md border border-err/40 bg-err/5 p-3 text-[12.5px] text-err">
          Could not load the packing lists for this day. {query.error instanceof Error ? query.error.message : ''}
        </p>
      )}

      {!query.isLoading && !query.error && lists.length === 0 && (
        <p className="text-[12.5px] text-ink-muted">
          This day has no trips. A packing list is a trip, so one appears here for every lorry once Delivery Time
          Arrangement has sequenced the day.
        </p>
      )}

      {lists.length > 0 && (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b-2 border-border text-left text-[10.5px] uppercase tracking-wider text-ink-muted">
              <th className="py-1.5 pr-2">Packing / Trip no</th>
              <th className="py-1.5 pr-2">Date</th>
              <th className="py-1.5 pr-2">Lorry</th>
              <th className="py-1.5 pr-2">Driver</th>
              <th className="py-1.5 pr-2 text-right">DOs</th>
              <th className="py-1.5 pr-2 text-right">Stops</th>
              <th className="py-1.5 pr-2 text-right">Units</th>
              <th className="py-1.5 pr-2 text-right">Volume</th>
              <th className="py-1.5 pr-2">Delivery status</th>
              <th className="py-1.5 pr-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((list) => (
              <PackingRow
                key={list.trip_id}
                list={list}
                date={date}
                origin={origin}
                qrOpen={qrFor === list.trip_id}
                onToggleQr={() => setQrFor((prev) => (prev === list.trip_id ? null : list.trip_id))}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PackingRow(props: {
  list: PackingListRow;
  date: string;
  origin: string;
  qrOpen: boolean;
  onToggleQr: () => void;
}) {
  const { list, date, origin, qrOpen, onToggleQr } = props;
  const rollup = rollupDeliveryStatus(list.stops);
  const label = rollupLabel(rollup);
  const volume = fmtM3(list.m3_milli);
  const runUrl = origin ? packingRunUrl(origin, list, date) : '';

  return (
    <>
      <tr className="border-b border-border align-top">
        <td className="py-2 pr-2 font-mono text-ink">{list.trip_no ?? '—'}</td>
        <td className="py-2 pr-2 text-ink-secondary">{list.trip_date ?? date}</td>
        <td className="py-2 pr-2 font-mono font-semibold text-ink">{list.lorry_plate ?? '—'}</td>
        <td className="py-2 pr-2 text-ink">{list.driver_name ?? '—'}</td>
        <td className="py-2 pr-2 text-right text-ink">{list.do_count}</td>
        <td className="py-2 pr-2 text-right text-ink">{list.stop_count}</td>
        <td className="py-2 pr-2 text-right text-ink">{list.units}</td>
        <td
          className="py-2 pr-2 text-right text-ink"
          title={volume ? undefined : 'No delivery order on this run carries a volume figure'}
        >
          {volume ?? '—'}
        </td>
        <td className="py-2 pr-2">
          {label
            ? <Badge tone={TONE_FOR[rollup?.label ?? ''] ?? 'neutral'} caseless>{label}</Badge>
            : <span className="text-ink-muted" title="No delivery order on this run could be read">—</span>}
          {rollup && rollup.cancelled > 0 && (
            <span className="ml-1.5 text-[11px] text-ink-muted">{rollup.cancelled} cancelled</span>
          )}
        </td>
        <td className="py-2 pr-2 text-right">
          <Button
            variant="ghost"
            icon={<Printer size={13} />}
            onClick={() => void generatePackingListPdf(list, { date, action: 'print' })}
          >
            Print
          </Button>
          <Button variant="ghost" icon={<QrCode size={13} />} onClick={onToggleQr}>
            QR
          </Button>
        </td>
      </tr>
      {qrOpen && (
        <tr className="border-b border-border">
          <td colSpan={10} className="py-2 pr-2 text-[11.5px] text-ink-secondary">
            The printed sheet carries a scannable code for this run. It opens{' '}
            <span className="break-all font-mono">{runUrl}</span> — a signed-in page, so whoever scans it has to be
            logged in.
          </td>
        </tr>
      )}
    </>
  );
}
