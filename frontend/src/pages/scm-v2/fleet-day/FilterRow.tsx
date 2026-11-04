import { Search } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FilterPills } from '../../../components/FilterPills';
import { SearchInput } from '../../../components/Button';
import {
  type FleetFilters, type StatusFilter, type SlotFilter, filtersActive, EMPTY_FILTERS,
} from './vm';

const STATUS_OPTS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'scheduled', label: 'Not started' },
  { value: 'active', label: 'On the way' },
  { value: 'done', label: 'Delivered' },
  { value: 'overdue', label: 'Late' },
];

const SLOT_OPTS: Array<{ value: SlotFilter; label: string }> = [
  { value: 'ALL', label: 'All slots' },
  { value: 'AM', label: 'AM' },
  { value: 'PM', label: 'PM' },
];

/** The shared filter row: region pills · status · salesperson · AM/PM · Late-only
 *  · Reset, with the search field on the right. Writes straight into `filters`. */
export function FleetDayFilterRow({
  filters, onChange, regionTabs, salespeople, lateCount,
}: {
  filters: FleetFilters;
  onChange: (next: FleetFilters) => void;
  regionTabs: Array<{ key: string; label: string }>;
  salespeople: Array<{ id: string; label: string }>;
  lateCount: number;
}) {
  const set = (patch: Partial<FleetFilters>) => onChange({ ...filters, ...patch });
  const selectCls = 'h-9 rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-primary';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterPills
        value={filters.region}
        onChange={(v) => set({ region: v })}
        options={[{ value: 'ALL', label: 'All' }, ...regionTabs.map((r) => ({ value: r.key, label: r.label }))]}
      />

      <span className="h-5 w-px bg-border" />

      <select className={selectCls} value={filters.status} onChange={(e) => set({ status: e.target.value as StatusFilter })} aria-label="Status">
        {STATUS_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <select className={selectCls} value={filters.salespersonId} onChange={(e) => set({ salespersonId: e.target.value })} aria-label="Salesperson">
        <option value="ALL">All salespeople</option>
        {salespeople.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>

      {/* AM / PM segmented */}
      <div className="inline-flex overflow-hidden rounded-md border border-border">
        {SLOT_OPTS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => set({ slot: o.value })}
            className={cn(
              'px-2.5 py-1.5 text-[11.5px] font-semibold',
              filters.slot === o.value ? 'bg-primary text-white' : 'bg-surface text-ink-secondary hover:bg-surface-2',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => set({ lateOnly: !filters.lateOnly })}
        className={cn(
          'rounded-full border px-3 py-1 text-[11.5px] font-semibold',
          filters.lateOnly ? 'border-err bg-err text-white' : 'border-err/40 text-err hover:bg-err-bg',
        )}
      >
        Late only · {lateCount}
      </button>

      {filtersActive(filters) && (
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_FILTERS, query: '' })}
          className="text-[11.5px] text-accent underline decoration-dotted underline-offset-2"
        >
          Reset
        </button>
      )}

      <span className="flex-1" />

      <SearchInput
        value={filters.query}
        onChange={(v) => set({ query: v })}
        placeholder="Customer phone, name, SO / DO no."
        leadingIcon={<Search size={14} strokeWidth={1.75} />}
        className="w-full sm:w-auto"
        widthClassName="w-full sm:w-[320px]"
        inputClassName="pl-8"
        aria-label="Search deliveries"
      />
    </div>
  );
}
