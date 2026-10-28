// ----------------------------------------------------------------------------
// lorry-compliance — expiry thresholds, renewal cadence, and the "next service"
// rules for the Fleet lorry detail. ONE module, imported by desktop and mobile
// (the single-logic-layer rule), so a threshold can never mean 30 days on one
// screen and 45 on the other.
//
// ── THE THRESHOLDS (chosen here, not handed down — see the report) ───────────
// Uniform across all four tiles: EXPIRED or <=14 days = red, <=45 days = amber,
// otherwise neutral. One rule for four dates because the operator's question is
// always the same ("is this about to bite me?"), and four different threshold
// pairs would be four things to remember for no gain. 45 days is the amber
// because a road-tax or insurance renewal in Malaysia is an errand you want a
// month-and-a-bit of warning on; 14 is the red because inside two weeks it has
// stopped being a reminder and become a problem.
//
// ── THE CADENCE IS A LABEL, NOT A CALCULATION, AND THAT IS DELIBERATE ────────
// Malaysian in-house goods vehicles: road tax and insurance renew ANNUALLY, and
// a Puspakom inspection for a commercial goods vehicle is due EVERY 6 MONTHS.
// That matches the owner's statement of the rule and this module follows it.
// But the cadence is surfaced as TEXT on each tile and is never used to compute
// the next expiry: the authoritative date is the one printed on the disc / cover
// note / inspection report, which the operator types in. A computed "+12 months"
// would silently disagree with the document after any early or late renewal, and
// a compliance date that is confidently wrong is worse than one nobody filled in
// — you would stop checking the real one. Encoding the cadence where it is
// visible (the tile) rather than buried (a date formula) is the whole point.
//
// ── THE ODOMETER IS AS STALE AS THE LAST SERVICE, AND THE UI MUST SAY SO ─────
// Odometer readings are entered on the SERVICE RECORD (owner option A), so the
// only mileage figure the system has is the one written down at the last visit.
// It follows that the system CANNOT know current mileage, and therefore cannot
// honestly render "due in 3,000 km" — that number would silently assume the
// lorry has not moved since the last service, which is the one thing it has
// certainly not done.
//
// So: `tone` is driven by the DATE alone. The km target is reported as three
// separate facts the reader can judge — the workshop's target, the reading it
// was set against, and how old that reading is — and never as a countdown. This
// module exposes `kmAfterReading` (target - reading) and NOT `kmRemaining`; the
// name is load-bearing. If a future change adds a per-trip odometer (owner
// option B), `readingAgeDays` becomes ~0 and a real countdown becomes possible;
// until then, do not add one.
//
// This is the same class of bug as the costing card that reported a green 100%
// margin off an empty cost table (see costing-enabled.ts): a confident number
// computed from data that was never there.
// ----------------------------------------------------------------------------

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

/** Today as YYYY-MM-DD in the VIEWER's local zone. These are calendar dates on
 *  Malaysian documents read by a user in Malaysia — using UTC would roll the
 *  day over at 8am MYT and make a tile flip a day early every morning. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
  /** null when nothing has been recorded — the tile shows "Not recorded", which
   *  is a real state and must not be dressed up as "ok". */
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

// ── Next service ─────────────────────────────────────────────────────────────

export type ServiceRecordLike = {
  service_date: string;
  odometer_km?: number | null;
  next_service_date?: string | null;
  next_service_km?: number | null;
};

export type NextServiceView = {
  /** Date-driven, and the ONLY thing that carries a colour. */
  tone: ComplianceTone;
  dueDate: string | null;
  daysToDue: number | null;
  /** The workshop's km target, verbatim off the last record. */
  targetKm: number | null;
  /** The odometer the target was set against, and when it was taken. Both are
   *  rendered next to the target so the reader can see what it is relative to. */
  readingKm: number | null;
  readingDate: string | null;
  /** How stale the reading is, in days. The UI shows this whenever a km target
   *  exists — it is the difference between "3,000 km after a reading taken
   *  yesterday" and "…taken 8 months ago", and the system cannot tell which. */
  readingAgeDays: number | null;
  /** target - reading: km to run AFTER that reading. NOT km remaining. Named so
   *  a caller cannot mistake it for a countdown. Null unless BOTH are present. */
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
    // No due DATE means no colour, even when a km target exists — see header.
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
