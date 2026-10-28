// ----------------------------------------------------------------------------
// Lorry Live Map (DEV-42) — where every tracked lorry is now. Positions come from
// the Velocity (Kinesis) trackers, stored every 5 min by the backend cron
// (scm/lib/velocity-poll.ts), not from driver phones, so it works without trips.
// Reuses the trip map component; one pin per lorry, amber when the fix is old.
// ----------------------------------------------------------------------------

import { fmtTime } from '@2990s/shared';
import { Link } from 'react-router-dom';
import { fmtSen } from '../../vendor/shared/format';
import { PageHeader } from '../../components/Layout';
import { LiveTripMap, type LiveMarker } from '../../vendor/scm/components/LiveTripMap';
import { useLorryKmCost, useLorryPositions, type LorryKmCost, type LorryPosition } from '../../vendor/scm/lib/lorries-queries';

/* Three missed polls = stale. */
const STALE_MS = 15 * 60_000;

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
}

const isStale = (p: LorryPosition) => Date.now() - Date.parse(p.recorded_at) > STALE_MS;

/* Km from today's Velocity fixes (Malaysia day) x the lorry's RM/km. No rate =
   no cost shown: unknown is not zero. The rate is set on the Fleet page. */
function KmCostCells({ kc }: { kc: LorryKmCost | undefined }) {
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums">{kc ? `${kc.km.toFixed(1)} km` : '—'}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {kc?.cost_sen != null ? fmtSen(kc.cost_sen) : kc ? (
          <Link className="text-accent underline-offset-2 hover:underline" to="/scm/fleet">set RM/km</Link>
        ) : '—'}
      </td>
    </>
  );
}

export function LorryLiveMap() {
  const q = useLorryPositions();
  const positions = q.data ?? [];
  const kmCost = new Map((useLorryKmCost().data ?? []).map((k) => [k.lorry_id, k]));
  const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

  const markers: LiveMarker[] = positions.map((p) => ({
    location: {
      tripId: p.lorry_id,
      driverId: null,
      lat: p.lat,
      lng: p.lng,
      accuracyM: null,
      recordedAt: p.recorded_at,
      receivedAt: p.received_at,
    },
    label: p.plate,
    stale: isStale(p),
  }));

  return (
    <div>
      <PageHeader
        dense
        eyebrow="Delivery · TMS"
        title="Lorry Live Map"
        description="Velocity trackers, updated every 5 min. Lorries with no tracker, or no position in 24 h, are not shown."
      />
      <div className="space-y-4 p-4">
        {q.isLoading ? (
          <p className="text-[13px] text-ink-muted">Loading positions…</p>
        ) : q.isError ? (
          <p className="text-[13px] text-red-600">Could not load positions. Refresh to try again.</p>
        ) : positions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface-dim px-4 py-6 text-center text-[13px] text-ink-muted">
            No lorry positions in the last 24 hours.
          </p>
        ) : (
          <>
            {mapsKey ? (
              <LiveTripMap apiKey={mapsKey} markers={markers} height={420} />
            ) : (
              <p className="text-[12px] text-ink-muted">Map key not configured; the table below still lists every position.</p>
            )}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-[13px]">
                <thead className="bg-surface-dim text-left text-[11px] uppercase tracking-wide text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">Lorry</th>
                    <th className="px-3 py-2">Last seen</th>
                    <th className="px-3 py-2">Speed</th>
                    <th className="px-3 py-2">Engine</th>
                    <th className="px-3 py-2">Where</th>
                    <th className="px-3 py-2 text-right">Km today</th>
                    <th className="px-3 py-2 text-right">Cost today</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.lorry_id} className="border-t border-border">
                      <td className="px-3 py-2 font-semibold text-ink">{p.plate}</td>
                      <td className={isStale(p) ? 'px-3 py-2 text-amber-600' : 'px-3 py-2 text-ink-secondary'}>
                        {ago(p.recorded_at)}
                        <span className="ml-1 text-ink-muted">({fmtTime(p.recorded_at)})</span>
                      </td>
                      <td className="px-3 py-2">{p.speed_kmh == null ? '—' : `${Math.round(p.speed_kmh)} km/h`}</td>
                      <td className="px-3 py-2">{p.ignition == null ? '—' : p.ignition ? 'On' : 'Off'}</td>
                      <td className="px-3 py-2">
                        <a
                          className="text-accent underline-offset-2 hover:underline"
                          href={`https://www.google.com/maps?q=${p.lat},${p.lng}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {p.street || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}
                        </a>
                      </td>
                      <KmCostCells kc={kmCost.get(p.lorry_id)} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
