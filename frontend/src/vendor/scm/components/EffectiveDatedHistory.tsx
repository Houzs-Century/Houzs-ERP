// ----------------------------------------------------------------------------
// EffectiveDatedHistory — REUSABLE effective-dated history list (A4).
//
// Ported from HOOKKA's effective-dated history pattern. Any append-only,
// effective-dated record (sofa combo prices, fabric-tier surcharges, delivery
// fees, …) shares ONE history dialog body: a list of rows newest-first, each
// tagged with where it sits on the effective-date timeline —
//
//   · Active      — the row whose effectiveFrom is the LATEST date that is
//                   <= today. This is the row a NEW order would pick up now.
//   · Pending·Nd  — effectiveFrom is in the FUTURE; shows a day countdown
//                   ("Pending · 3d" = effective in 3 days; "·" when today but
//                   computed Active wins, so 1d is the minimum future value).
//   · Past        — a superseded older row (its effectiveFrom is <= today but a
//                   newer row also <= today supersedes it).
//   · Deleted     — soft-deleted rows are tagged separately (orthogonal to the
//                   timeline state) so a removed row never reads as "Active".
//
// Plus a one-line reassurance banner that explains the append-only model in
// plain language for the operator.
//
// GENERIC by design: the caller supplies the rows, a key extractor, the
// effective-date extractor, and how to render each row's BODY (prices, notes,
// whatever). This component owns only the timeline math, the status badge, the
// banner, and the row chrome — never the row's domain content.
//
// No Tailwind — design tokens only (var(--…)), matching SofaComboTab's inline
// CSSProperties + the StatusPill tone palette (lib/status-pill.ts).
// ----------------------------------------------------------------------------

import { type CSSProperties, type ReactNode } from 'react';
import { STATUS_TONES } from '../lib/status-pill';
import { todayMyt } from '../lib/dates';

// ─── Timeline status ──────────────────────────────────────────────────

export type EffectiveTimelineState = 'active' | 'pending' | 'past';

export type EffectiveStatus = {
  state: EffectiveTimelineState;
  /** Whole-day countdown until this row goes live. Only set when pending and
   *  >= 1; null otherwise. "Pending · {daysUntil}d". */
  daysUntil: number | null;
};

/** Parse a `YYYY-MM-DD` date to a UTC-midnight epoch (ms). Returns NaN for a
 *  malformed value so callers can treat it as "no usable date". We anchor on
 *  UTC midnight so the day-difference is a clean integer regardless of the
 *  browser's own timezone — the same trick `todayMyt` uses. */
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

  // Unparseable own date → can't sit on the timeline; show as past.
  if (Number.isNaN(mineMs) || Number.isNaN(todayMs)) {
    return { state: 'past', daysUntil: null };
  }

  // Future → pending, with a ceil'd day countdown (so "later today" still
  // reads as 1d rather than 0d, and a row exactly = today is never pending).
  if (mineMs > todayMs) {
    const daysUntil = Math.max(1, Math.ceil((mineMs - todayMs) / DAY_MS));
    return { state: 'pending', daysUntil };
  }

  // <= today. The single Active row is the one with the GREATEST date that is
  // still <= today. Everything else <= today is Past.
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

// ─── Badge ────────────────────────────────────────────────────────────

// Reuse the canonical StatusPill tone palette so these badges match every
// other pill in the ERP: Active = success (green), Pending = pending (amber),
// Past = neutral (grey). Deleted = danger (red).
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

// ─── Reassurance banner ───────────────────────────────────────────────

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

// ─── The list ─────────────────────────────────────────────────────────

export type EffectiveDatedHistoryProps<Row> = {
  /** The effective-dated rows. Order doesn't matter — the component sorts
   *  newest-first by effective date for display. */
  rows: readonly Row[];
  /** Stable React key for a row. */
  rowKey: (row: Row) => string;
  /** The row's effective date as `YYYY-MM-DD`. */
  effectiveFrom: (row: Row) => string;
  /** Optional soft-delete flag → renders a Deleted badge. */
  isDeleted?: (row: Row) => boolean;
  /** Render this row's BODY (domain content: prices, notes, …). The header
   *  line (effective date + badges) is supplied by this component; renderRow
   *  only owns what sits beneath it. */
  renderRow: (row: Row, status: EffectiveStatus) => ReactNode;
  /** Today's calendar date (`YYYY-MM-DD`); defaults to Malaysia today. Pass
   *  through when the caller already has a pinned "today" for consistency. */
  today?: string;
  /** Loading flag — renders a quiet "Loading…" line. */
  loading?: boolean;
  /** Override the reassurance banner copy, or pass null to hide it. */
  bannerText?: string | null;
  /** Empty-state line when there are no rows (and not loading). */
  emptyLabel?: ReactNode;
  /** Optional summary/subtitle line above the banner (e.g. the combo label). */
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
  // All effective dates feed the "which row is Active" decision.
  const allDates = rows.map(effectiveFrom);

  // Newest-first by effective date (string compare is correct for ISO
  // `YYYY-MM-DD`). A stable sort keeps insertion order among equal dates.
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
                  // Subtle de-emphasis for superseded / removed rows so the eye
                  // lands on the Active + Pending rows first.
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

// dd/mm/yyyy display, matching SofaComboTab's fmtDate. Kept local so the
// component is self-contained; falls back to the raw string when not ISO.
function fmtEffDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
