/* The "By region" half of the Packing Lists tab (owner 2026-11-27): one row per
   Delivery Planning region for the date, every DO delivering there whether or
   not a lorry is arranged. Prints Part A only (packing-list-pdf.ts). */

import { Download, Eye, Printer } from 'lucide-react';
import { Button } from '../../../components/Button';
import { DataTable, type Column } from '../../../components/DataTable';
import { packingScanTimesFor, type PackingRegionRow, type PackingScanStatus } from '../lib/packing-list-queries';
import { fmtScanTime, regionCategoryUnits, regionLorrySummary } from '../lib/packing-list-model';
import { ScanTimeCell } from './PackingScanTimeCell';
import { partCountFor } from '../lib/packing-list-split';
import type { PdfAction } from '../lib/pdf-common';

type Props = {
  date: string;
  regions: PackingRegionRow[] | null;
  loading: boolean;
  error: string | null;
  scanSheets: readonly PackingScanStatus[] | undefined;
  busy: boolean;
  onPrint: (rows: readonly PackingRegionRow[], action: PdfAction) => void;
};

const count = (n: number) => <span className="tabular-nums">{n}</span>;

export function DoPackingRegionsTable({ date, regions, loading, error, scanSheets, busy, onPrint }: Props) {
  const times = (r: PackingRegionRow) => packingScanTimesFor(scanSheets, 'region', r.region);
  const units = (r: PackingRegionRow) => regionCategoryUnits(r);
  const columns: Column<PackingRegionRow>[] = [
    { key: 'region', label: 'Region', width: '120px', render: (r) => <span className="font-semibold text-ink">{r.label}</span>, getValue: (r) => r.label },
    {
      key: 'lorries', label: 'Lorries',
      render: (r) => <span className="whitespace-normal break-words font-mono text-[12px]" title={regionLorrySummary(r)}>{regionLorrySummary(r)}</span>,
      getValue: (r) => regionLorrySummary(r),
    },
    { key: 'dos', width: '64px', label: 'DOs', align: 'right', render: (r) => count(r.do_count), getValue: (r) => r.do_count, exportFormat: 'number' },
    { key: 'customers', width: '96px', label: 'Customers', align: 'right', render: (r) => count(r.customer_count), getValue: (r) => r.customer_count, exportFormat: 'number' },
    { key: 'mattress', width: '96px', label: 'Mattress', align: 'right', render: (r) => count(units(r).MATTRESS), getValue: (r) => units(r).MATTRESS, exportFormat: 'number' },
    { key: 'bedframe', width: '96px', label: 'Bedframe', align: 'right', render: (r) => count(units(r).BEDFRAME), getValue: (r) => units(r).BEDFRAME, exportFormat: 'number' },
    { key: 'accessories', width: '96px', label: 'Accessories', align: 'right', render: (r) => count(units(r).ACCESSORIES), getValue: (r) => units(r).ACCESSORIES, exportFormat: 'number' },
    { key: 'sofa', width: '96px', label: 'Sofa pcs', align: 'right', render: (r) => count(units(r).SOFA), getValue: (r) => units(r).SOFA, exportFormat: 'number' },
    { key: 'units', width: '64px', label: 'Units', align: 'right', render: (r) => <span className="font-semibold tabular-nums">{r.units}</span>, getValue: (r) => r.units, exportFormat: 'number' },
    {
      key: 'prepared', label: 'Prepared', width: '132px',
      render: (r) => <ScanTimeCell times={times(r)} date={date} what="prepared" expectedParts={partCountFor(r.do_count)} />,
      getValue: (r) => fmtScanTime(times(r)?.prepared_at ?? null, date),
    },
    {
      key: 'loaded', label: 'Loaded', width: '132px',
      render: (r) => <ScanTimeCell times={times(r)} date={date} what="loaded" expectedParts={partCountFor(r.do_count)} />,
      getValue: (r) => fmtScanTime(times(r)?.loaded_at ?? null, date),
    },
    {
      key: 'actions', label: '', align: 'right', width: '270px',
      render: (r) => (
        <span className="inline-flex gap-1">
          <Button variant="ghost" icon={<Eye size={13} />} disabled={busy} onClick={() => onPrint([r], 'preview')}>Open</Button>
          <Button variant="ghost" icon={<Printer size={13} />} disabled={busy} onClick={() => onPrint([r], 'print')}>Print</Button>
          <Button variant="ghost" icon={<Download size={13} />} disabled={busy} onClick={() => onPrint([r], 'save')}>Download</Button>
        </span>
      ),
    },
  ];

  return (
    <DataTable<PackingRegionRow>
      tableId="do-packing-regions"
      exportName={`packing-regions-${date}`}
      columns={columns}
      rows={error ? null : regions}
      loading={loading}
      error={error}
      emptyLabel="No delivery orders are due for delivery on this day."
      getRowKey={(r) => r.region}
    />
  );
}
