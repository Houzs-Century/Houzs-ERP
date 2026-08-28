// LoadingList — the warehouse's "what to load today" queue (2026-08-25, owner:
// "仓库线只扫码置 LOADED 不见价格").
//
// A storekeeper opens this to see which delivery orders are waiting to load,
// what is on each (product + quantity), where it is going, and which lorry is
// taking it — and NOTHING priced. The load action itself is the scan on the DO
// print (→ /scm/do-load), gated on the editable scm.do.load capability; this
// screen is the queue that tells them what to scan. Backed by GET
// /api/scm/loading-list, whose payload carries no money by construction
// (backend routes/loading-list.ts).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, PackageSearch, Search, Truck, MapPin, CalendarDays, QrCode } from 'lucide-react';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { fmtDate } from '../../vendor/shared/format';
import { PageHeader } from '../../components/Layout';

type LoadingLine = {
  id: string;
  itemCode: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number | null;
  variantSummary: string;
  rackId: string | null;
};
type LoadingDo = {
  id: string;
  do_number: string;
  status: string | null;
  debtor_name: string | null;
  city: string | null;
  state: string | null;
  customer_delivery_date: string | null;
  expected_delivery_at: string | null;
  lorry_plate: string | null;
  crew_driver_name: string | null;
  loading_lines: LoadingLine[];
  loading_qty_total: number;
};

type StatusFilter = 'to_load' | 'loaded' | 'all';
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'to_load', label: 'To load' },
  { key: 'loaded', label: 'Loaded' },
  { key: 'all', label: 'All' },
];

const useLoadingList = (status: StatusFilter) =>
  useQuery({
    queryKey: ['loading-list', status],
    queryFn: () => authedFetch<{ deliveryOrders: LoadingDo[] }>(`/loading-list?status=${status}`),
    staleTime: 20_000,
  });

export const LoadingList = () => {
  const [status, setStatus] = useState<StatusFilter>('to_load');
  const [search, setSearch] = useState('');
  const listQ = useLoadingList(status);

  const rows = useMemo(() => {
    const all = listQ.data?.deliveryOrders ?? [];
    const s = search.trim().toLowerCase();
    if (!s) return all;
    return all.filter((d) =>
      [d.do_number, d.debtor_name, d.lorry_plate, d.crew_driver_name, d.city, d.state]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(s)),
    );
  }, [listQ.data, search]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4">
      <PageHeader
        eyebrow="Warehouse"
        title="Loading List"
        description="Delivery orders waiting to load — what is on each, where it goes, and which lorry takes it. Scan the printed delivery order to confirm loading."
      />

      {/* Status filter + search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-line bg-surface p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatus(f.key)}
              className={`rounded px-3 py-1.5 text-sm font-medium transition ${
                status === f.key ? 'bg-accent text-white' : 'text-ink-secondary hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search DO, customer, lorry, destination…"
            className="w-full rounded-md border border-line bg-surface py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent"
          />
        </div>
      </div>

      {listQ.isLoading && (
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-6 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading the queue…
        </div>
      )}

      {listQ.isError && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          Could not load the queue. Refresh, or tell the dispatcher if it keeps failing.
        </div>
      )}

      {!listQ.isLoading && !listQ.isError && rows.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">
          <PackageSearch size={22} />
          <div>{search ? 'No delivery orders match your search.' : 'Nothing waiting to load right now.'}</div>
        </div>
      )}

      <div className="space-y-3">
        {rows.map((d) => (
          <article key={d.id} className="overflow-hidden rounded-md border border-line bg-surface">
            {/* Header row */}
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base font-semibold">{d.do_number}</span>
                  <StatusPill docType="do" status={d.status} />
                </div>
                <div className="mt-0.5 truncate text-sm">{d.debtor_name ?? '—'}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-ink-secondary">
                  <span className="inline-flex items-center gap-1">
                    <MapPin size={12} /> {[d.city, d.state].filter(Boolean).join(', ') || '—'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays size={12} /> {fmtDate(d.customer_delivery_date ?? d.expected_delivery_at)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Truck size={12} /> {d.lorry_plate ?? '—'}
                    {d.crew_driver_name ? ` · ${d.crew_driver_name}` : ''}
                  </span>
                </div>
              </div>
              {(d.status ?? '').toUpperCase() === 'DRAFT' && (
                <Link
                  to={`/scm/do-load?id=${d.id}`}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-accent bg-accent/5 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/10"
                >
                  <QrCode size={15} /> Scan to load
                </Link>
              )}
            </div>

            {/* Line items — product + qty, NO price */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-secondary">
                  <th className="px-4 py-1.5 font-medium">Item</th>
                  <th className="px-4 py-1.5 text-right font-medium">Qty</th>
                </tr>
              </thead>
              <tbody>
                {d.loading_lines.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-4 py-2 text-ink-secondary">No lines on this delivery order.</td>
                  </tr>
                )}
                {d.loading_lines.map((l) => (
                  <tr key={l.id} className="border-t border-line/60 align-top">
                    <td className="px-4 py-2">
                      <div className="font-medium">{l.description || l.itemCode || '—'}</div>
                      {(l.itemCode || l.variantSummary) && (
                        <div className="text-xs text-ink-secondary">
                          {l.itemCode && <span className="font-mono">{l.itemCode}</span>}
                          {l.itemCode && l.variantSummary ? ' · ' : ''}
                          {l.variantSummary}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-mono">
                      {l.qty ?? 0}
                      {l.uom ? <span className="ml-1 text-xs text-ink-secondary">{l.uom}</span> : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        ))}
      </div>
    </div>
  );
};

export default LoadingList;
