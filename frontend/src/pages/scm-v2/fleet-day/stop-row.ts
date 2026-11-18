// ----------------------------------------------------------------------------
// fleet-day/stop-row — what ONE stop row on a lorry card shows, for every job
// type (owner-approved redesign 2026-11-18): the type tag and its colour family,
// the reference line, the address line, the number-circle look, the single
// status pill and the one-line meta. PURE, so the rules are tested without a
// browser (stop-row.test.ts); LorryCard only lays them out.
// ----------------------------------------------------------------------------
import type { PlanningOrder } from '../../../vendor/scm/lib/delivery-planning-queries';
import { windowEndMinutes } from '../../../vendor/scm/lib/delivery-stop-status';
import { condenseWindow } from '../../../vendor/scm/lib/fleet-day-cards';
import { clockMY, fmtMinutes, type DocRowVM } from './vm';

export type StopFamily = 'delivery' | 'service' | 'setup' | 'supplier' | 'transfer' | 'lorry';

export const FAMILY_STYLE: Record<StopFamily, { bg: string; fg: string }> = {
  delivery: { bg: '#eef0ec', fg: '#4d5247' },
  service: { bg: '#e7eef9', fg: '#1f4a8a' },
  setup: { bg: '#f3e8fb', fg: '#6a2c91' },
  supplier: { bg: '#fdf0dc', fg: '#7a4a0c' },
  transfer: { bg: '#e2f1ea', fg: '#145c42' },
  lorry: { bg: '#ececec', fg: '#3a3a3a' },
};

const ASSR_TAG: Record<string, string> = {
  customer_pickup: 'SERVICE PICKUP', inspection: 'INSPECTION', delivery: 'SERVICE BACK',
};
const JOB_TAG: Record<string, { label: string; family: StopFamily }> = {
  SETUP: { label: 'SETUP', family: 'setup' },
  DISMANTLE: { label: 'DISMANTLE', family: 'setup' },
  SUPPLIER_PICKUP: { label: 'SUPPLIER PICKUP', family: 'supplier' },
  TRANSFER: { label: 'TRANSFER', family: 'transfer' },
  LORRY_SERVICE: { label: 'LORRY SERVICE', family: 'lorry' },
  DELIVERY: { label: 'DELIVERY', family: 'delivery' },
  PICKUP: { label: 'PICKUP', family: 'service' },
  SERVICE: { label: 'SERVICE', family: 'service' },
};

type TagRow = Pick<PlanningOrder, 'row_type' | 'job_kind' | 'dp_job_type'>;

/** The type tag on line 1 and its colour family. */
export function stopTagOf(o: TagRow): { label: string; family: StopFamily } {
  if (o.row_type === 'so') return { label: 'DELIVERY', family: 'delivery' };
  if (o.row_type === 'assr') return { label: ASSR_TAG[o.job_kind ?? ''] ?? 'SERVICE', family: 'service' };
  const t = (o.dp_job_type ?? '').toUpperCase();
  return JOB_TAG[t] ?? { label: t.replace(/_/g, ' ') || 'JOB', family: 'delivery' };
}

const isTransfer = (o: TagRow) => o.row_type !== 'so' && o.row_type !== 'assr' && (o.dp_job_type ?? '').toUpperCase() === 'TRANSFER';

/** Line 1's name: the customer / venue / party; a transfer reads "From → To"
 *  when its origin was recorded. */
export function stopTitleOf(d: DocRowVM): string {
  const to = d.customer || '—';
  if (isTransfer(d.order) && d.order.dp_from_name) return `${d.order.dp_from_name} → ${to}`;
  return to;
}

/** Line 2: the documents and what the stop is about, by job type. */
export function stopRefLineOf(d: DocRowVM): string {
  const o = d.order;
  const remark = (o.dp_remark ?? '').trim() || null;
  if (o.row_type === 'so') return [d.soDocNo, d.doNumber, d.ref].filter(Boolean).join(' · ');
  if (o.row_type === 'assr') {
    const dos = (o.related_do_nos ?? []).filter(Boolean);
    return [o.ref, remark, dos.length ? dos.join(', ') : null].filter(Boolean).join(' · ');
  }
  if (o.row_type === 'project') return [o.ref, o.branding, remark].filter(Boolean).join(' · ');
  return [o.dp_no ?? o.ref, remark].filter(Boolean).join(' · ');
}

/** Line 3: the address on one line, with its postcode when the text lacks it. */
export function stopAddressOf(d: DocRowVM): string {
  const a = (d.address ?? '').trim();
  const pc = (d.order.postcode ?? '').trim();
  if (!a) return pc;
  return pc && !a.includes(pc) ? `${a}, ${pc}` : a;
}

/** The slot pill text: AM / PM / a condensed window; long free text is cut. */
export function slotPillOf(label: string): string {
  const c = condenseWindow(label);
  return c.length > 14 ? `${c.slice(0, 13)}…` : c;
}

export type RowState = 'scheduled' | 'active' | 'arrived' | 'done' | 'overdue';

export function rowStateOf(d: Pick<DocRowVM, 'status' | 'arrivedAt'>): RowState {
  if (d.status === 'done') return 'done';
  if (d.status === 'active') return d.arrivedAt ? 'arrived' : 'active';
  if (d.status === 'overdue') return 'overdue';
  return 'scheduled';
}

/** The ONE status pill in the right column. */
export function statusPillOf(d: Pick<DocRowVM, 'status' | 'arrivedAt' | 'deliveredAt'>): { label: string; state: RowState } {
  const state = rowStateOf(d);
  switch (state) {
    case 'done': { const t = clockMY(d.deliveredAt); return { label: t ? `Done ${t}` : 'Done', state }; }
    case 'arrived': { const t = clockMY(d.arrivedAt); return { label: t ? `Arrived ${t}` : 'Arrived', state }; }
    case 'active': return { label: 'On the way', state };
    case 'overdue': return { label: 'Late', state };
    default: return { label: 'Not started', state };
  }
}

/** Where the map put the stop: exact, approximate (postcode area) or nowhere;
 *  'unknown' while the map has not looked (it locates only when open). */
export type StopLocation = 'exact' | 'approx' | 'none' | 'unknown';

export type CircleLook = 'open-blue' | 'solid-blue' | 'solid-green' | 'open-red' | 'dashed-grey';

export function circleLookOf(state: RowState, loc: StopLocation): CircleLook {
  if (state === 'done') return 'solid-green';
  if (state === 'active' || state === 'arrived') return 'solid-blue';
  if (state === 'overdue') return 'open-red';
  if (loc === 'approx' || loc === 'none') return 'dashed-grey';
  return 'open-blue';
}

export type MetaBit = { text: string; tone: 'muted' | 'err' };

const minutesSince = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const m = Math.round((now.getTime() - t) / 60_000);
  return m >= 0 ? m : null;
};

const clockOfMinutes = (m: number): string => {
  const hh = Math.floor(m / 60) % 24;
  const ap = hh >= 12 ? 'PM' : 'AM';
  return `${((hh + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${ap}`;
};

/** Line 4's state-specific bits after the slot and the Google leg. */
export function stopMetaExtras(
  d: DocRowVM,
  ctx: { now: Date; day: string; today: string; plannedDepartAt: string | null; siteMin: number | null; location: StopLocation },
): MetaBit[] {
  const out: MetaBit[] = [];
  const state = rowStateOf(d);
  if (state === 'active') {
    const offset = d.order.trip_eta_offset_s;
    const planned = ctx.plannedDepartAt ? Date.parse(ctx.plannedDepartAt) : NaN;
    const eta = offset != null && !Number.isNaN(planned) ? clockMY(new Date(planned + offset * 1000).toISOString()) : null;
    if (eta) out.push({ text: `ETA ${eta}`, tone: 'muted' });
    else if (d.departedAt) out.push({ text: `Left ${clockMY(d.departedAt)}`, tone: 'muted' });
  } else if (state === 'arrived') {
    const m = minutesSince(d.arrivedAt, ctx.now);
    if (m != null) out.push({ text: `on site ${fmtMinutes(m)}`, tone: 'muted' });
  } else if (state === 'done') {
    if (ctx.siteMin != null) out.push({ text: `on site ${fmtMinutes(ctx.siteMin)}`, tone: 'muted' });
    if (d.podPhotoCount != null) {
      if (d.podPhotoCount > 0) out.push({ text: `${d.podPhotoCount} POD photo${d.podPhotoCount === 1 ? '' : 's'}`, tone: 'muted' });
    } else if (d.hasPod) out.push({ text: 'POD photo', tone: 'muted' });
  } else if (state === 'overdue') {
    const end = windowEndMinutes(d.order.time_range);
    if (ctx.day === ctx.today && end != null) out.push({ text: `Slot ended ${clockOfMinutes(end)}`, tone: 'err' });
    else if (d.lateReason) out.push({ text: d.lateReason, tone: 'err' });
  }
  if (state !== 'done') {
    if (ctx.location === 'approx') out.push({ text: 'approx. location', tone: 'muted' });
    else if (ctx.location === 'none') out.push({ text: 'cannot be located', tone: 'err' });
  }
  return out;
}
