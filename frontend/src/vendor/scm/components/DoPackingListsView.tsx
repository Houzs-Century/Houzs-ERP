/* ----------------------------------------------------------------------------
   DoPackingListsView — the "Packing Lists" tab on Delivery Orders
   (/scm/delivery-orders?tab=packing&date=YYYY-MM-DD), owner spec 2026-11-27.

   Nobody creates a packing list: once Delivery Time Arrangement puts delivery
   orders on a lorry for a day, that lorry's packing list exists. One row per
   lorry (= one trip) for the chosen date, read through the same
   usePackingLists the Last Mile Delivery section uses, printed by the same
   usePackingPrint, so the two places can never print different sheets.

   The date is URL state (`date`), like every other filter on this page.
   ---------------------------------------------------------------------------- */

import { useSearchParams } from 'react-router-dom';
import { Eye, Printer } from 'lucide-react';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { DataTable, type Column } from '../../../components/DataTable';
import { DateField } from './DateField';
import { usePackingLists, type PackingListRow } from '../lib/packing-list-queries';
import { fmtM3, rollupDeliveryStatus, rollupLabel, shiftIsoDate } from '../lib/packing-list-model';
import { usePackingPrint } from './usePackingPrint';
import { fmtDate, todayMY } from '../../../../../shared/src/vendor/shared/format';

const TONE_FOR: Record<string, 'neutral' | 'warning' | 'success'> = {
  Draft: 'neutral', Confirmed: 'warning', Loaded: 'warning', 'In Transit': 'warning', Delivered: 'success',
};


const isIsoDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function DoPackingListsView() {
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const rawDate = params.get('date');
  const date = isIsoDate(rawDate) ? rawDate : today;
  const query = usePackingLists({ date, warehouseId: null });
  const lists = query.data?.lists ?? [];
  const print = usePackingPrint(date);

  const setDate = (iso: string | null) => {
    const next = new URLSearchParams(params);
    if (iso && iso !== today) next.set('date', iso);
    else next.delete('date');
    setParams(next, { replace: true });
  };

  const quick: Array<{ label: string; iso: string }> = [
    { label: 'Yesterday', iso: shiftIsoDate(today, -1) },
    { label: 'Today', iso: today },
    { label: 'Tomorrow', iso: shiftIsoDate(today, 1) },
  ];

  const columns: Column<PackingListRow>[] = [
    { key: 'lorry', label: 'Lorry', width: '120px', render: (l) => <span className="font-mono font-semibold text-ink">{l.lorry_plate ?? '—'}</span>, getValue: (l) => l.lorry_plate ?? '' },
    { key: 'driver', label: 'Driver', render: (l) => l.driver_name ?? '—', getValue: (l) => l.driver_name ?? '' },
    {
      key: 'helpers', label: 'Helpers',
      render: (l) => [l.helper_1_name, l.helper_2_name].filter(Boolean).join(', ') || '—',
      getValue: (l) => [l.helper_1_name, l.helper_2_name].filter(Boolean).join(', '),
    },
    { key: 'customers', label: 'Customers', align: 'right', render: (l) => l.stop_count, getValue: (l) => l.stop_count, exportFormat: 'number' },
    { key: 'units', label: 'Units', align: 'right', render: (l) => l.units, getValue: (l) => l.units, exportFormat: 'number' },
    {
      key: 'm3', label: 'm³', align: 'right',
      render: (l) => {
        const v = fmtM3(l.m3_milli);
        return <span title={v ? undefined : 'No delivery order on this lorry carries a volume figure'}>{v ? v.replace(' m³', '') : '—'}</span>;
      },
      getValue: (l) => (l.m3_milli == null ? '' : (l.m3_milli / 1000).toFixed(2)),
    },
    {
      key: 'loading', label: 'Loading',
      render: (l) => {
        const rollup = rollupDeliveryStatus(l.stops);
        const label = rollupLabel(rollup);
        return label
          ? <Badge tone={TONE_FOR[rollup?.label ?? ''] ?? 'neutral'} caseless>{label}</Badge>
          : <span className="text-ink-muted" title="No delivery order on this lorry could be read">—</span>;
      },
      getValue: (l) => rollupLabel(rollupDeliveryStatus(l.stops)) ?? '',
    },
    {
      key: 'actions', label: '', align: 'right', width: '190px',
      render: (l) => (
        <span className="inline-flex gap-1">
          <Button variant="ghost" icon={<Eye size={13} />} disabled={print.busy} onClick={() => print.one(l, 'preview')}>Open</Button>
          <Button variant="ghost" icon={<Printer size={13} />} disabled={print.busy} onClick={() => print.one(l, 'print')}>Print</Button>
        </span>
      ),
    },
  ];

  const n = lists.length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="rounded-md border border-border bg-surface">
          <DateField
            value={date}
            onChange={(iso) => setDate(iso || null)}
            aria-label="Delivery date"
            className="border-0 bg-transparent px-2 py-1.5 text-[13px] font-semibold text-ink"
          />
        </div>
        {quick.map((q) => (
          <Button
            key={q.label}
            variant={date === q.iso ? 'primary' : 'secondary'}
            className="h-8 px-3 text-[12px]"
            aria-pressed={date === q.iso}
            onClick={() => setDate(q.iso)}
          >
            {q.label}
          </Button>
        ))}
        <span className="hidden flex-1 sm:block" />
        <Button
          variant="primary"
          icon={<Printer size={14} />}
          disabled={print.busy || n === 0}
          onClick={() => print.all(lists, 'print')}
          className="w-full sm:w-auto"
        >
          {print.busy ? 'Preparing…' : `Print all ${n} ${n === 1 ? 'lorry' : 'lorries'}`}
        </Button>
      </div>
      <p className="text-[12px] text-ink-muted">
        {fmtDate(date)} · one packing list per lorry. Part A picks by category; Part B loads the last customer first.
      </p>
      {print.error && <p role="alert" className="text-[12px] text-err">{print.error}</p>}
      <DataTable<PackingListRow>
        tableId="do-packing-lists"
        exportName={`packing-lists-${date}`}
        columns={columns}
        rows={query.error ? null : query.data ? lists : null}
        loading={query.isLoading}
        error={query.error ? `Could not load the packing lists for this day. ${query.error instanceof Error ? query.error.message : ''}` : null}
        emptyLabel="No lorry has delivery orders on this day yet. A packing list appears here for every lorry once Delivery Time Arrangement has put delivery orders on it."
        getRowKey={(l) => l.trip_id}
      />
    </div>
  );
}
