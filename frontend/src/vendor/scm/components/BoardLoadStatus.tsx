/* One line under a board's header: when its data was last loaded ("Updated
   14:32", Malaysia time) and, while date bands are still arriving, which one is
   loading; a band that failed says so and offers Retry. Shared by Delivery
   Planning, Last Mile and Logistic Overview (desktop and the phone shell). */
import { fmtDateTime } from '../../shared/format';
import type { BandedBoard } from '../lib/delivery-board-bands';

type BandStatus = Pick<BandedBoard, 'loading' | 'failed'>;

export function boardUpdatedLabel(updatedAt: number): string | null {
  if (!updatedAt) return null;
  return `Updated ${fmtDateTime(new Date(updatedAt).toISOString()).slice(-5)}`;
}

/** The empty-table message while bands are still on their way (search and filters see only loaded rows). */
export function stillLoadingMessage(bands: BandStatus, fallback: string): string {
  if (bands.loading) return `No match in what has loaded - still loading older orders (${bands.loading.label}).`;
  if (bands.failed) return `No match in what has loaded - orders ${bands.failed.label} could not load.`;
  return fallback;
}

export function BoardLoadStatus({ updatedAt, bands }: { updatedAt: number; bands: BandStatus }) {
  const updated = boardUpdatedLabel(updatedAt);
  if (!updated && !bands.loading && !bands.failed) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1 text-[12px] text-ink-muted">
      {updated && <span>{updated}</span>}
      {bands.loading && <span>Loading orders {bands.loading.label}...</span>}
      {bands.failed && (
        <span className="text-err">
          Could not load orders {bands.failed.label}.{' '}
          <button type="button" className="underline" onClick={bands.failed.retry}>Retry</button>
        </span>
      )}
    </div>
  );
}
