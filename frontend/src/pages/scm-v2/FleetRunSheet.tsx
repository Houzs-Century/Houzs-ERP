// ----------------------------------------------------------------------------
// FleetRunSheet — Fleet Module A4, the PRINTABLE driver run-sheet. One clean
// sheet PER LORRY: a trip summary (date, driver, helper, plate, drops, revenue),
// the route map for that lorry, and the ordered stop list (no., customer, full
// address, phone, house type, time window, ETA, access note). This is the paper
// the driver takes on the road.
//
// A READ / RENDER layer over GET /trips/day — same data as the Fleet Map page,
// laid out for print (@media print, one lorry per page). ?trip=<id> prints just
// that lorry; otherwise every lorry on the day prints.
// ----------------------------------------------------------------------------

import { useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Printer, ArrowLeft } from 'lucide-react';
import { Button } from '../../components/Button';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import { fmtSen, fmtDate, todayMY } from '../../vendor/shared/format';
import { useFleetDay, type FleetDayTrip } from '../../vendor/scm/lib/fleet-day-queries';
import { assignRouteColors, routeColorFor } from '../../vendor/scm/lib/fleet-colors';
import { buildMapRoutes, etaLabel, windowLabel, kmLabel } from '../../vendor/scm/lib/fleet-day-model';
import { FleetDayMap } from '../../vendor/scm/components/FleetDayMap';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

function crewLine(t: FleetDayTrip): string {
  const helpers = t.helpers.map((h) => h.name).filter(Boolean);
  return helpers.length ? helpers.join(', ') : '—';
}

export function FleetRunSheet() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const date = params.get('date') || todayMY();
  const warehouseId = params.get('warehouseId') || '';
  const onlyTrip = params.get('trip') || null;

  const query = useFleetDay({ date, warehouseId: warehouseId || null });
  const allTrips = useMemo(() => query.data?.trips ?? [], [query.data]);
  const colors = useMemo(() => assignRouteColors(allTrips.map((t) => t.id)), [allTrips]);
  const sheets = useMemo(
    () => (onlyTrip ? allTrips.filter((t) => t.id === onlyTrip) : allTrips),
    [allTrips, onlyTrip],
  );

  // Give the map tiles a moment to paint before a print is triggered manually;
  // the button opens the Print preview, never auto-prints on load.
  useEffect(() => { document.title = `Run-sheet ${date}`; }, [date]);

  const print = usePrintPreview(() => window.print());

  return (
    /* `print-area` is the app's print opt-in (index.css). Without it the global
       `body * { visibility: hidden }` swallowed this page whole and the Print
       button produced a blank sheet — the local @media print block below only
       ever governed layout, never visibility. */
    <div className="fleet-runsheet print-area mx-auto max-w-[900px] px-4 py-4">
      {/* Screen-only toolbar — hidden when printing. */}
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>Back</Button>
        <span className="flex-1" />
        <span className="text-[12px] text-ink-muted">
          {fmtDate(date)} · {sheets.length} {sheets.length === 1 ? 'lorry' : 'lorries'}
        </span>
        <Button variant="primary" icon={<Printer size={14} />} onClick={print.openPreview} disabled={sheets.length === 0}>
          Print
        </Button>
      </div>
      {/* Same Print preview every document in the app opens. The run sheet is
          printed from the page itself, not a jspdf file, so there is nothing to
          download or open in a tab — Print is the only exit. */}
      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Driver Run-Sheet"
        docNo={fmtDate(date)}
        rows={[
          { label: 'Lorries', value: `${sheets.length} ${sheets.length === 1 ? 'lorry' : 'lorries'}` },
          {
            label: 'Stops',
            value: `${sheets.reduce((n, t) => n + (t.stops?.length ?? 0), 0)} in total`,
          },
          { value: 'One lorry per page.' },
        ]}
        onPrint={print.handlers.onPrint}
      />

      {query.isLoading && <p className="no-print text-[13px] text-ink-muted">Loading…</p>}
      {!query.isLoading && sheets.length === 0 && (
        <p className="no-print text-[13px] text-ink-muted">No trips to print for this day.</p>
      )}

      {sheets.map((t) => {
        const routes = buildMapRoutes([t], colors);
        const color = routeColorFor(colors, t.id);
        return (
          <section key={t.id} className="runsheet-page mb-8 rounded-md border border-border bg-surface p-5">
            {/* header */}
            <div className="mb-3 flex items-start justify-between gap-4 border-b border-border pb-3">
              <div>
                <h1 className="text-[18px] font-bold text-ink">Driver Run-Sheet</h1>
                <p className="text-[12.5px] text-ink-secondary">{fmtDate(date)}</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-[16px] font-bold text-ink">{t.lorry?.plate ?? '—'}</p>
                <p className="text-[12px] text-ink-secondary">{t.trip_no ?? ''}{t.is_outsourced ? ' · outsourced' : ''}</p>
              </div>
            </div>

            {/* summary grid */}
            <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-4">
              <div><span className="block text-[10.5px] uppercase tracking-wider text-ink-muted">Driver</span><span className="text-ink">{t.driver?.name ?? '—'}</span></div>
              <div><span className="block text-[10.5px] uppercase tracking-wider text-ink-muted">Helper(s)</span><span className="text-ink">{crewLine(t)}</span></div>
              <div><span className="block text-[10.5px] uppercase tracking-wider text-ink-muted">Depot</span><span className="text-ink">{t.warehouse?.name ?? '—'}</span></div>
              <div><span className="block text-[10.5px] uppercase tracking-wider text-ink-muted">Total drops</span><span className="text-ink">{t.total_drops}</span></div>
              <div><span className="block text-[10.5px] uppercase tracking-wider text-ink-muted">Total revenue</span><span className="text-ink">{fmtSen(t.total_revenue_sen)}</span></div>
              <div><span className="block text-[10.5px] uppercase tracking-wider text-ink-muted">Route distance</span><span className="text-ink">{t.total_distance_km != null ? `${t.total_distance_km} km` : '—'}</span></div>
              <div><span className="block text-[10.5px] uppercase tracking-wider text-ink-muted">Status</span><span className="text-ink">{String(t.status).replace('_', ' ').toLowerCase()}</span></div>
            </div>

            {/* map for this lorry */}
            {MAPS_KEY && query.data?.configured && routes.length > 0 && (
              <div className="runsheet-map mb-4">
                <FleetDayMap apiKey={MAPS_KEY} routes={routes} height={300} />
              </div>
            )}

            {/* ordered stops table */}
            {t.stops.length === 0 ? (
              <p className="text-[12.5px] text-ink-muted">No stops on this trip.</p>
            ) : (
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="border-b-2 border-border text-left text-[10.5px] uppercase tracking-wider text-ink-muted">
                    <th className="w-8 py-1.5 pr-2">#</th>
                    <th className="py-1.5 pr-2">Customer / Address</th>
                    <th className="py-1.5 pr-2">Phone</th>
                    <th className="py-1.5 pr-2">House / Window</th>
                    <th className="py-1.5 pr-2 text-right">ETA</th>
                  </tr>
                </thead>
                <tbody>
                  {t.stops.map((s) => {
                    const win = windowLabel(s.earliest_time, s.latest_time);
                    return (
                      <tr key={s.id} className="border-b border-border align-top">
                        <td className="py-2 pr-2">
                          <span
                            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
                            style={{ backgroundColor: color }}
                          >
                            {s.stop_no}
                          </span>
                        </td>
                        <td className="py-2 pr-2">
                          <span className="block font-semibold text-ink">{s.customer_name ?? '—'}</span>
                          <span className="block text-ink-secondary">{s.address ?? 'No address'}</span>
                          {s.stop_type !== 'DELIVERY' && (
                            <span className="block text-[10.5px] uppercase tracking-wider text-ink-muted">{s.stop_type.replace('_', ' ').toLowerCase()}</span>
                          )}
                          {s.access_note && <span className="block text-[11px] text-ink-muted">Note: {s.access_note}</span>}
                        </td>
                        <td className="py-2 pr-2 text-ink">{s.phone ?? '—'}</td>
                        <td className="py-2 pr-2 text-ink">
                          <span className="block">{s.house_type ?? '—'}</span>
                          {win && <span className="block text-ink-secondary">{win}</span>}
                        </td>
                        <td className="py-2 pr-2 text-right text-ink">
                          <span className="block font-semibold">{etaLabel(s.eta_offset_s)}</span>
                          <span className="block text-ink-secondary">{kmLabel(s.leg_distance_m)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {/* Print rules: one lorry per page, hide app chrome, keep tables intact. */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .fleet-runsheet { max-width: none; padding: 0; margin: 0; }
          .runsheet-page {
            border: none !important;
            padding: 0 !important;
            margin: 0 !important;
            page-break-after: always;
            break-after: page;
          }
          .runsheet-page:last-child { page-break-after: auto; break-after: auto; }
          .runsheet-page tr { page-break-inside: avoid; break-inside: avoid; }
          .runsheet-map { break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}
