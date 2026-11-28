import { fmtDateTime } from '../../../../../shared/src/vendor/shared/format';
import { fmtScanTime } from '../lib/packing-list-model';
import { scanPartsLine, type PackingScanStatus } from '../lib/packing-list-queries';

/** One Prepared / Loaded cell on the Packing Lists tab: the scan time, a muted dash, or, for a
 *  sheet printed in parts (over 60 DOs), how many parts have been scanned so far. */
export function ScanTimeCell({ times, date, what, expectedParts }: {
  times: PackingScanStatus | null;
  date: string;
  what: 'prepared' | 'loaded';
  expectedParts: number;
}) {
  const iso = what === 'loaded' ? times?.loaded_at ?? null : times?.prepared_at ?? null;
  if (!iso) {
    const parts = scanPartsLine(times, what, expectedParts);
    if (parts) {
      return (
        <span className="whitespace-normal text-[11px] text-ink-muted" title={`This packing list prints in parts of up to 60 delivery orders, each with its own QR. The time shows once every part is scanned as ${what}.`}>
          {parts}
        </span>
      );
    }
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
