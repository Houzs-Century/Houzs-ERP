// ----------------------------------------------------------------------------
// CrossCompanyRacks — the "All Companies" tab on the Warehouse page. The same
// physical warehouse exists as one record per company; this READ-ONLY view
// widens across every company the caller may see (backend
// GET /warehouse/cross-company -> scopeToAllowedCompanies) and shows one
// combined list with a Company column, so you can see the whole physical
// warehouse regardless of which company owns each rack. Editing / stock / zone
// stay on the per-company tabs — this view never writes.
//
// Grouping / sorting / filtering reuse the ONE tested logic layer
// (vendor/scm/lib/warehouse-floorplan.ts); this file is presentation only.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { SearchInput } from '../../components/Button';
import { fmtDate, fmtQty } from '@2990s/shared';
import { useCrossCompanyRacks, type CrossCompanyRack } from '../../vendor/scm/lib/warehouse-queries';
import {
  compareRackLabels, EMPTY_FILTERS, itemDescription, matchSlot, resolvedZoneLabel,
  statusCounts, toSlot, type FloorFilters, type Slot, type SlotStatus,
} from '../../vendor/scm/lib/warehouse-floorplan';

/* A cross-company row is a slot plus the company + physical warehouse it sits
   in (the floor-plan slot model carries neither, since that view is already
   pinned to one company + one warehouse). */
type CcSlot = Slot & { companyCode: string; warehouseCode: string };

const STATUS_LABEL: Record<SlotStatus, string> = { occupied: 'Occupied', reserved: 'Reserved', empty: 'Empty' };

/* Status pill classes — control flow, not a colour table, so each status maps to
   the shared Ink & Petrol semantic tokens. */
function statusPill(st: SlotStatus): string {
  if (st === 'occupied') return 'bg-primary-soft text-primary-ink';
  if (st === 'reserved') return 'bg-warning-bg text-warning-text';
  return 'bg-surface-2 text-ink-muted';
}

function toCcSlot(r: CrossCompanyRack): CcSlot {
  return { ...toSlot(r), companyCode: r.company_code ?? '—', warehouseCode: r.warehouse_code ?? '—' };
}

export function CrossCompanyRacks() {
  const query = useCrossCompanyRacks();
  const resp = query.data;

  const [filters, setFilters] = useState<FloorFilters>(EMPTY_FILTERS);
  const [company, setCompany] = useState<string>('');
  const [warehouse, setWarehouse] = useState<string>('');

  const slots = useMemo<CcSlot[]>(() => (resp?.racks ?? []).map(toCcSlot), [resp]);
  const warehouseOptions = resp?.warehouses ?? [];
  const companyOptions = resp?.companies ?? [];

  const rows = useMemo(() => {
    const matched = slots.filter(
      (s) =>
        (!company || s.companyCode === company) &&
        (!warehouse || s.warehouseCode === warehouse) &&
        matchSlot(s, filters),
    );
    return matched.sort(
      (a, b) =>
        a.companyCode.localeCompare(b.companyCode) ||
        a.warehouseCode.localeCompare(b.warehouseCode) ||
        compareRackLabels(a.rack.rack, b.rack.rack),
    );
  }, [slots, company, warehouse, filters]);

  const counts = useMemo(() => statusCounts(rows), [rows]);
  const setFilter = (patch: Partial<FloorFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const selectCls =
    'h-9 rounded-md border border-border-subtle bg-surface px-2.5 text-[12.5px] text-ink-secondary outline-none focus:border-primary';

  if (query.isLoading) return <Placeholder>Loading racks across companies…</Placeholder>;
  if (query.isError) return <Placeholder>Could not load the cross-company view. Try again.</Placeholder>;
  if (slots.length === 0) return <Placeholder>No racks in any company you can see.</Placeholder>;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput
            value={filters.q}
            onChange={(v) => setFilter({ q: v })}
            placeholder="Search slot, product, customer or doc no…"
            aria-label="Search racks"
            className="min-w-[220px] flex-1"
            leadingIcon={<Search size={14} strokeWidth={1.75} />}
            inputClassName="!w-full !bg-surface-2 !pl-8"
          />
          <select className={selectCls} value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Filter by company">
            <option value="">All companies</option>
            {companyOptions.map((co) => (
              <option key={co.id} value={co.code ?? ''}>{co.code ?? `#${co.id}`}</option>
            ))}
          </select>
          <select className={selectCls} value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="Filter by warehouse">
            <option value="">All warehouses</option>
            {warehouseOptions.map((w) => (
              <option key={w.code} value={w.code}>{w.code}</option>
            ))}
          </select>
          <select className={selectCls} value={filters.status} onChange={(e) => setFilter({ status: e.target.value as SlotStatus | '' })} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="occupied">Occupied</option>
            <option value="reserved">Reserved</option>
            <option value="empty">Empty</option>
          </select>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-3 border-t border-[#f0f2ee] pt-2.5 text-[12px] text-ink-muted">
          <span><span className="font-semibold tabular-nums text-ink">{rows.length}</span> racks</span>
          <span className="tabular-nums">Occupied {counts.occupied}</span>
          <span className="tabular-nums">Reserved {counts.reserved}</span>
          <span className="tabular-nums">Empty {counts.empty}</span>
          <span className="text-ink-muted">Read-only — edit racks on a company's own tab.</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-border-subtle text-left">
              {['Company', 'Warehouse', 'Slot', 'Status', 'Product', 'Customer', 'Qty', 'In date', 'Document', 'Zone'].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const zone = resolvedZoneLabel(s);
              return (
                <tr key={s.rack.id} className="border-b border-border-subtle/60 hover:bg-surface-2">
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">{s.companyCode}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-secondary">{s.warehouseCode}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-semibold text-ink">{s.id}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusPill(s.status)}`}>{STATUS_LABEL[s.status]}</span>
                  </td>
                  <td className="px-3 py-2 text-ink">{s.itemCount === 0 ? '—' : s.itemCount === 1 ? itemDescription(s.items[0]) : `${s.itemCount} items`}</td>
                  <td className="px-3 py-2 text-ink-secondary">{s.customer || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-secondary">{s.itemCount === 0 ? '—' : fmtQty(s.qty)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-secondary">{s.inDate ? fmtDate(s.inDate) : '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-secondary">{s.doc || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-secondary">{zone ?? '—'}{s.rack.zone ? '' : zone ? ' (auto)' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center text-[13px] text-ink-muted">
      {children}
    </div>
  );
}
