import { fmtDateTime } from '../../../../../shared/src/vendor/shared/format';
import { fmtScanTime } from '../lib/packing-list-model';
import { PACKING_QR_MAX_DOS } from '../lib/packing-list-queries';

/** One Prepared / Loaded cell on the Packing Lists tab: the scan time, a muted dash, or,
 *  for a sheet over the QR cap, why it cannot be scanned. */
export function ScanTimeCell({ iso, date, what, doCount }: {
  iso: string | null;
  date: string;
  what: 'prepared' | 'loaded';
  doCount: number;
}) {
  if (!iso && doCount > PACKING_QR_MAX_DOS) {
    return (
      <span className="whitespace-normal text-[11px] text-ink-muted" title={`A packing list QR covers up to ${PACKING_QR_MAX_DOS} delivery orders, so this sheet prints without one.`}>
        No QR (over {PACKING_QR_MAX_DOS} DOs)
      </span>
    );
  }
  if (!iso) {
    return <span className="text-ink-muted" title={`Not scanned as ${what} yet`}>—</span>;
  }
  return (
    <span
      className={`tabular-nums font-semibold ${what === 'loaded' ? 'text-synced' : 'text-ink'}`}
      title={`${what === 'loaded' ? 'Loaded' : 'Prepared'} at ${fmtDateTime(iso)}`}
    >
      {fmtScanTime(iso, date)}
    </span>
  );
}
