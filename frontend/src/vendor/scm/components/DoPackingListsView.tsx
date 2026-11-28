/* ----------------------------------------------------------------------------
   DoPackingListsView — the "Packing Lists" tab on Delivery Orders
   (/scm/delivery-orders?tab=packing&date=YYYY-MM-DD), owner spec 2026-11-27.

   Nobody creates a packing list: once Delivery Time Arrangement puts delivery
   orders on a lorry for a day, that lorry's packing list exists. One row per
   lorry (= one trip) for the chosen date, read through the same
   usePackingLists the Last Mile Delivery section uses, printed by the same
   usePackingPrint, so the two places can never print different sheets.

   The date is URL state (`date`), like every other filter on this page; so are
   the By lorry / By region switch (`view=region`). By region lists every
   delivery order of the day, lorry or not (owner, 2026-11-28).
   ---------------------------------------------------------------------------- */

import { useSearchParams } from 'react-router-dom';
import { Download, Eye, Printer } from 'lucide-react';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { DataTable, type Column } from '../../../components/DataTable';
import { DateField } from './DateField';
import { usePackingLists, usePackingRegions, type PackingListRow } from '../lib/packing-list-queries';
import { fmtM3, rollupDeliveryStatus, rollupLabel, shiftIsoDate } from '../lib/packing-list-model';
import { usePackingPrint } from './usePackingPrint';
import { DoPackingRegionsTable } from './DoPackingRegionsTable';
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
  const byRegion = params.get('view') === 'region';
  const query = usePackingLists({ date, warehouseId: null });
  const lists = query.data?.lists ?? [];
  const regionQuery = usePackingRegions({ date, unassignedOnly: false, enabled: byRegion });
  const regions = regionQuery.data?.regions ?? [];
  const regionDos = regions.reduce((n, r) => n + r.do_count, 0);
  const print = usePackingPrint(date);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

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
      key: 'actions', label: '', align: 'right', width: '290px',
      render: (l) => (
        <span className="inline-flex gap-1">
          <Button variant="ghost" icon={<Eye size={13} />} disabled={print.busy} onClick={() => print.one(l, 'preview')}>Open</Button>
          <Button variant="ghost" icon={<Printer size={13} />} disabled={print.busy} onClick={() => print.one(l, 'print')}>Print</Button>
          <Button variant="ghost" icon={<Download size={13} />} disabled={print.busy} onClick={() => print.one(l, 'save')}>Download</Button>
        </span>
      ),
    },
  ];

  const n = lists.length;
  const nr = regions.length;
  const kinds: Array<{ region: boolean; label: string; badge: string | null }> = [
    { region: false, label: 'By lorry', badge: query.data ? String(n) : null },
    { region: true, label: 'By region', badge: regionQuery.data ? `${regionDos} DO` : null },
  ];
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
          variant="secondary"
          icon={<Download size={14} />}
          disabled={print.busy || (byRegion ? nr === 0 : n === 0)}
          onClick={() => (byRegion ? print.regions(regions, 'save') : print.all(lists, 'save'))}
          className="w-full sm:w-auto"
        >
          {byRegion ? `Download all ${nr} ${nr === 1 ? 'region' : 'regions'}` : `Download all ${n} ${n === 1 ? 'lorry' : 'lorries'}`}
        </Button>
        {byRegion ? (
          <Button
            variant="primary"
            icon={<Printer size={14} />}
            disabled={print.busy || nr === 0}
            onClick={() => print.regions(regions, 'print')}
            className="w-full sm:w-auto"
          >
            {print.busy ? 'Preparing…' : `Print all ${nr} ${nr === 1 ? 'region' : 'regions'}`}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Printer size={14} />}
            disabled={print.busy || n === 0}
            onClick={() => print.all(lists, 'print')}
            className="w-full sm:w-auto"
          >
            {print.busy ? 'Preparing…' : `Print all ${n} ${n === 1 ? 'lorry' : 'lorries'}`}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Kind of packing list" className="inline-flex rounded-md border border-border bg-surface p-0.5">
          {kinds.map((k) => (
            <button
              key={k.label}
              type="button"
              aria-pressed={byRegion === k.region}
              onClick={() => setParam('view', k.region ? 'region' : null)}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-[12px] font-semibold ${byRegion === k.region ? 'bg-primary text-white' : 'text-ink-muted hover:text-ink'}`}
            >
              {k.label}
              {k.badge && <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${byRegion === k.region ? 'bg-white/20' : 'bg-surface-2'}`}>{k.badge}</span>}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[12px] text-ink-muted">
        {byRegion
          ? `${fmtDate(date)} · one packing list per region (the Delivery Planning regions), lorry or not. Picks by category.`
          : `${fmtDate(date)} · one packing list per lorry. Part A picks by category; Part B loads the last customer first.`}
      </p>
      {print.error && <p role="alert" className="text-[12px] text-err">{print.error}</p>}
      {byRegion ? (
        <DoPackingRegionsTable
          date={date}
          regions={regionQuery.data ? regions : null}
          loading={regionQuery.isLoading}
          error={regionQuery.error ? `Could not load the delivery orders by region for this day. ${regionQuery.error instanceof Error ? regionQuery.error.message : ''}` : null}
          busy={print.busy}
          onPrint={print.regions}
        />
      ) : (
      <DataTable<PackingListRow>
        tableId="do-packing-lists"
        exportName={`packing-lists-${date}`}
        columns={columns}
        rows={query.error ? null : query.data ? lists : null}
        loading={query.isLoading}
        error={query.error ? `Could not load the packing lists for this day. ${query.error instanceof Error ? query.error.message : ''}` : null}
        emptyLabel="No lorry has delivery orders on this day yet. A packing list appears here for every lorry once Delivery Planning puts a lorry on its delivery orders. By region lists every delivery order of the day, lorry or not."
        getRowKey={(l) => l.trip_id}
      />
      )}
    </div>
  );
}
