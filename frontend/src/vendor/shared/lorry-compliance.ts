
import { todayMY } from './format';

export const EXPIRY_RED_DAYS = 14;
export const EXPIRY_AMBER_DAYS = 45;

export type ComplianceTone = 'expired' | 'critical' | 'warning' | 'ok' | 'none';

export type ComplianceKind = 'roadTax' | 'insurance' | 'puspakom';

export const COMPLIANCE_LABEL: Record<ComplianceKind, string> = {
  roadTax: 'Road tax',
  insurance: 'Insurance',
  puspakom: 'Puspakom',
};

/** Shown on the tile. See the header: a label, never an input to a date sum. */
export const COMPLIANCE_CADENCE: Record<ComplianceKind, string> = {
  roadTax: 'Renews yearly',
  insurance: 'Renews yearly',
  puspakom: 'Every 6 months',
};

/** The lorry columns each tile reads (mig 0121). */
export const COMPLIANCE_COLUMN: Record<ComplianceKind, string> = {
  roadTax: 'road_tax_expiry',
  insurance: 'insurance_expiry',
  puspakom: 'puspakom_expiry',
};

export const COMPLIANCE_KINDS: ComplianceKind[] = ['roadTax', 'insurance', 'puspakom'];

/** Today as YYYY-MM-DD on the MALAYSIAN calendar. These are calendar dates on
 *  Malaysian documents: UTC would roll the day over at 8am MYT, and the
 *  viewer's own zone moved it for a laptop or phone set to another one. */
export function todayIso(): string {
  return todayMY();
}

/** Whole days from `today` to `iso` (negative = already past). Both are anchored
 *  at UTC midnight purely so the subtraction is a clean day count — no offset or
 *  DST can leak in, because neither side carries a time. */
export function daysUntil(iso: string | null | undefined, today: string = todayIso()): number | null {
  if (!iso) return null;
  const a = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

export function toneForDays(days: number | null): ComplianceTone {
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= EXPIRY_RED_DAYS) return 'critical';
  if (days <= EXPIRY_AMBER_DAYS) return 'warning';
  return 'ok';
}

export type ExpiryStatus = {
  tone: ComplianceTone;
  days: number | null;
  date: string | null;
};

export function expiryStatus(iso: string | null | undefined, today: string = todayIso()): ExpiryStatus {
  const days = daysUntil(iso, today);
  return { tone: toneForDays(days), days, date: iso ? String(iso).slice(0, 10) : null };
}

/** Human countdown for a tile. Deliberately plain: "Expired 12 days ago" beats
 *  "-12 days", which reads as a bug. */
export function expiryPhrase(s: ExpiryStatus): string {
  if (s.days === null) return 'Not recorded';
  if (s.days < 0) return `Expired ${Math.abs(s.days)} ${Math.abs(s.days) === 1 ? 'day' : 'days'} ago`;
  if (s.days === 0) return 'Expires today';
  return `${s.days} ${s.days === 1 ? 'day' : 'days'} left`;
}


export type ServiceRecordLike = {
  service_date: string;
  odometer_km?: number | null;
  next_service_date?: string | null;
  next_service_km?: number | null;
};

export type NextServiceView = {
  tone: ComplianceTone;
  dueDate: string | null;
  daysToDue: number | null;
  targetKm: number | null;
  readingKm: number | null;
  readingDate: string | null;
  readingAgeDays: number | null;
  kmAfterReading: number | null;
};

/** Build the Next Service view from a lorry's service history.
 *
 *  Reads the MOST RECENT record that actually set a target rather than simply
 *  the newest record: a small interim repair that set no next-service target
 *  must not blank a target the previous full service did set. The odometer
 *  reading is taken from that SAME record so the target and the reading it is
 *  relative to can never come from two different visits. */
export function nextServiceView(
  records: ServiceRecordLike[],
  today: string = todayIso(),
): NextServiceView {
  const sorted = [...records].sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)));
  const withTarget = sorted.find((r) => r.next_service_date || (r.next_service_km ?? null) !== null) ?? null;

  const dueDate = withTarget?.next_service_date ? String(withTarget.next_service_date).slice(0, 10) : null;
  const daysToDue = daysUntil(dueDate, today);
  const targetKm = withTarget?.next_service_km ?? null;
  const readingKm = withTarget?.odometer_km ?? null;
  const readingDate = withTarget ? String(withTarget.service_date).slice(0, 10) : null;
  const readingAge = readingDate ? daysUntil(readingDate, today) : null;

  return {
    tone: toneForDays(daysToDue),
    dueDate,
    daysToDue,
    targetKm,
    readingKm,
    readingDate,
    readingAgeDays: readingAge === null ? null : Math.abs(readingAge),
    kmAfterReading: targetKm !== null && readingKm !== null ? targetKm - readingKm : null,
  };
}

/** The km line for the Next Service tile — the honest phrasing, in one place so
 *  no screen can reword it into a countdown. Returns null when there is no km
 *  target to talk about. */
export function nextServiceKmPhrase(v: NextServiceView): string | null {
  if (v.targetKm === null) return null;
  const target = v.targetKm.toLocaleString();
  if (v.readingKm === null) return `Due at ${target} km`;
  return `Due at ${target} km — last read ${v.readingKm.toLocaleString()} km`;
}

/** The staleness caveat. Non-null whenever a km target exists and we know how
 *  old the reading is — the UI must render it next to the km line. */
export function odometerStalenessNote(v: NextServiceView): string | null {
  if (v.targetKm === null || v.readingAgeDays === null) return null;
  if (v.readingAgeDays === 0) return 'Odometer read today';
  return `Odometer last read ${v.readingAgeDays} ${v.readingAgeDays === 1 ? 'day' : 'days'} ago — current mileage is not tracked`;
}
