
import { type CSSProperties, type ReactNode } from 'react';
import { STATUS_TONES } from '../../../../../shared/src/vendor/scm/lib/status-pill';
import { todayMyt } from '../lib/dates';


export type EffectiveTimelineState = 'active' | 'pending' | 'past';

export type EffectiveStatus = {
  state: EffectiveTimelineState;
  daysUntil: number | null;
};

function isoToUtcMidnight(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return Number.NaN;
  return Date.parse(`${iso}T00:00:00Z`);
}

const DAY_MS = 86_400_000;

/**
 * Classify ONE effective date against the set of all effective dates and today.
 *
 * @param effectiveFrom  this row's effective date (`YYYY-MM-DD`).
 * @param allDates       every row's effective date (used to find the single
 *                       row that is "Active" = the latest date <= today).
 * @param today          today's calendar date (`YYYY-MM-DD`); defaults to MYT.
 *
 * Rules:
 *   · future date          → pending (+ day countdown, min 1d).
 *   · latest date <= today → active.
 *   · any other <= today   → past.
 * A malformed date is treated as past (never claims Active/Pending).
 */
export function effectiveStatus(
  effectiveFrom: string,
  allDates: readonly string[],
  today: string = todayMyt(),
): EffectiveStatus {
  const todayMs = isoToUtcMidnight(today);
  const mineMs = isoToUtcMidnight(effectiveFrom);

  if (Number.isNaN(mineMs) || Number.isNaN(todayMs)) {
    return { state: 'past', daysUntil: null };
  }

  if (mineMs > todayMs) {
    const daysUntil = Math.max(1, Math.ceil((mineMs - todayMs) / DAY_MS));
    return { state: 'pending', daysUntil };
  }

  let latestPastOrTodayMs = Number.NEGATIVE_INFINITY;
  for (const d of allDates) {
    const ms = isoToUtcMidnight(d);
    if (Number.isNaN(ms) || ms > todayMs) continue;
    if (ms > latestPastOrTodayMs) latestPastOrTodayMs = ms;
  }
  return mineMs === latestPastOrTodayMs
    ? { state: 'active', daysUntil: null }
    : { state: 'past', daysUntil: null };
}

/** Short human label for a computed status, e.g. "Active", "Pending · 3d",
 *  "Past". Kept separate from the badge so non-visual callers (search/filter
 *  text) can reuse it. */
export function effectiveStatusLabel(s: EffectiveStatus): string {
  if (s.state === 'pending') {
    return s.daysUntil != null ? `Pending · ${s.daysUntil}d` : 'Pending';
  }
  return s.state === 'active' ? 'Active' : 'Past';
}


const badgeBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 'var(--radius-pill, 999px)',
  whiteSpace: 'nowrap',
};

function toneStyle(tone: keyof typeof STATUS_TONES): CSSProperties {
  const { bg, fg } = STATUS_TONES[tone];
  return { ...badgeBase, background: bg, color: fg };
}

/** The Active / Pending·Nd / Past badge for one computed status. */
export function EffectiveStatusBadge({ status }: { status: EffectiveStatus }) {
  const tone =
    status.state === 'active' ? 'success'
    : status.state === 'pending' ? 'pending'
    : 'neutral';
  const title =
    status.state === 'active' ? 'In effect for new orders from now'
    : status.state === 'pending'
      ? `Takes effect in ${status.daysUntil ?? '—'} day${status.daysUntil === 1 ? '' : 's'}`
      : 'Superseded by a newer effective row';
  return (
    <span style={toneStyle(tone as keyof typeof STATUS_TONES)} title={title}>
      {effectiveStatusLabel(status)}
    </span>
  );
}

/** A standalone "Deleted" badge (orthogonal to the timeline state) for
 *  soft-deleted rows. */
export function DeletedBadge() {
  return (
    <span style={toneStyle('danger')} title="Soft-deleted — kept for history">
      Deleted
    </span>
  );
}


const BANNER_TEXT =
  'Older orders keep the price/spec they were saved with — a new effective row only applies to NEW orders from its date.';

/** One-line reassurance banner. Shown above the row list so the operator knows
 *  editing prices never rewrites a placed order. */
export function EffectiveHistoryBanner({ text = BANNER_TEXT }: { text?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '8px 12px',
        background: 'var(--c-cream)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-sm)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-12)',
        color: 'var(--fg-soft)',
        lineHeight: 1.4,
      }}
    >
      <span aria-hidden style={{ flexShrink: 0, fontWeight: 700, color: 'var(--c-burnt, #A6471E)' }}>
        ℹ
      </span>
      <span>{text}</span>
    </div>
  );
}


export type EffectiveDatedHistoryProps<Row> = {
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  effectiveFrom: (row: Row) => string;
  isDeleted?: (row: Row) => boolean;
  renderRow: (row: Row, status: EffectiveStatus) => ReactNode;
  today?: string;
  loading?: boolean;
  bannerText?: string | null;
  emptyLabel?: ReactNode;
  header?: ReactNode;
};

/**
 * Generic effective-dated history list. Owns the timeline math, the per-row
 * header (effective date + Active/Pending·Nd/Past + Deleted badges), the
 * reassurance banner and the empty/loading states. The caller owns each row's
 * body via `renderRow`.
 */
export function EffectiveDatedHistory<Row>({
  rows,
  rowKey,
  effectiveFrom,
  isDeleted,
  renderRow,
  today = todayMyt(),
  loading = false,
  bannerText,
  emptyLabel = 'No history rows.',
  header,
}: EffectiveDatedHistoryProps<Row>) {
  const allDates = rows.map(effectiveFrom);

  const sorted = [...rows].sort((a, b) => {
    const da = effectiveFrom(a);
    const db = effectiveFrom(b);
    return da < db ? 1 : da > db ? -1 : 0;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {header != null && (
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--fg-soft)' }}>
          {header}
        </div>
      )}

      {bannerText !== null && <EffectiveHistoryBanner {...(bannerText ? { text: bannerText } : {})} />}

      {loading ? (
        <p style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)' }}>
          Loading…
        </p>
      ) : sorted.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)' }}>
          {emptyLabel}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sorted.map((row) => {
            const status = effectiveStatus(effectiveFrom(row), allDates, today);
            const deleted = isDeleted?.(row) ?? false;
            return (
              <div
                key={rowKey(row)}
                style={{
                  padding: 10,
                  background: 'var(--c-cream)',
                  borderRadius: 'var(--radius-sm)',
                  border:
                    status.state === 'active' && !deleted
                      ? '1px solid var(--c-secondary-a, #2F5D4F)'
                      : '1px solid var(--line)',
                  opacity: deleted || status.state === 'past' ? 0.78 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)' }}>
                    Effective {fmtEffDate(effectiveFrom(row))}
                  </strong>
                  <EffectiveStatusBadge status={status} />
                  {deleted && <DeletedBadge />}
                </div>
                {renderRow(row, status)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtEffDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
