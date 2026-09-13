// ----------------------------------------------------------------------------
// fair-options.ts — THE fair picker's rule. Pure: no I/O, no clock, no DB.
//
// WHY THIS EXISTS
// Until now an SO recorded its exhibition as a free-text VENUE and nothing else.
// Measured on production 2026-09-13: Houzs Century had 2,946 sales orders, of
// which 0 carried `project_id` — so no order in the account book could say which
// FAIR it was written at, and exhibition P&L had to be reconciled by hand. The
// venue text alone cannot answer it either: on 13 Sep four different fairs were
// running at MID VALLEY on the same three days (projects 340/341/342/2250), one
// per brand.
//
// ── THE OWNER'S RULE (2026-09-13) ───────────────────────────────────────────
// A dropdown row is a PLACE plus an ORGANIZER, and nothing else:
//
//     MID VALLEY                    REX
//     THE COMMUNE KULAI             INHOME
//
// *"我觉得不需要日期啦，因为确实是不会再撞同一个日期，所以只需要选 event 和
// organizer 就好了"* — and he is right about the frequency: across all of 2026
// only THREE days had two different organizers at one venue at the same time.
// The BRAND half he never has to pick, because it is already derived from the
// SKU (`derive-line-branding.ts`), and venue + organizer + date + brand is what
// identifies one fair.
//
// *"dont let them write in manual, third option just pick others"* — there is no
// free-text venue anywhere in this flow. The escape hatch is a second PICK from
// the company's 92-row venue master. Free text is what produced the mess this
// module replaces.
//
// ── THE ONE CASE THAT STILL NEEDS A DATE ────────────────────────────────────
// Same month, same venue, SAME organizer, twice — e.g. MVEC SOUTHKEY / REX ran
// 8-10 Aug and 14-16 Aug 2026. Four occurrences in seven months. Those two rows
// would be identical on screen, so THOSE rows (only) carry their dates. Every
// other row stays clean, which is what the owner asked for.
// ----------------------------------------------------------------------------

/** One PMS project row, as the loader reads it. A project is one BRAND's booth
 *  at one organizer's event: the fair the owner talks about is several of these. */
export type FairProjectRow = {
  projectId: number;
  /** `public.projects.venue` — free text historically, now always a master name. */
  venue: string | null;
  organizer: string | null;
  /** `public.projects.brand` — AKEMI / ZANOTTI / ERGOTEX / DUNLOPILLO / … */
  brand: string | null;
  /** `YYYY-MM-DD`, MYT calendar date. A project with no start has no period. */
  startDate: string | null;
  /** `YYYY-MM-DD`, MYT, INCLUSIVE. NULL = open-ended. */
  endDate: string | null;
  status: string | null;
};

/** One row in the dropdown. `key` is what the client sends back on save. */
export type FairOption = {
  /** Stable identity of the EVENT: venue + organizer + period. Not a project id —
   *  one row covers every brand booth at that event, and which brand applies is
   *  decided from the order's own lines, not by the person picking. */
  key: string;
  venue: string;
  organizer: string;
  startDate: string;
  endDate: string | null;
  /** TRUE only when another row in the same list would otherwise read identically
   *  (same venue, same organizer, same month). The label then shows the dates. */
  showDates: boolean;
  /** The project ids this row covers, one per brand. For display/debug only —
   *  the server re-resolves on save and never trusts an id from the client. */
  projectIds: number[];
};

export type FairOptionGroups = {
  /** Fairs whose period CONTAINS the order date. Normally where the rep is. */
  running: FairOption[];
  /** Everything else in the same calendar month, newest event first. */
  month: FairOption[];
};

const clean = (v: string | null | undefined): string =>
  typeof v === 'string' ? v.trim() : '';

/** Case/space-insensitive compare key. `MALL MGMT` and `mall  mgmt` are one. */
export function fairKeyPart(v: string | null | undefined): string {
  return clean(v).toLowerCase().replace(/\s+/g, ' ');
}

/** Does `date` fall inside the project's period? Same contract as
 *  venue-binding.ts::periodContains — plain lexicographic MYT date compare, no
 *  `Date` objects, because `new Date('2026-07-19')` is 08:00 MYT and the
 *  arithmetic from there re-introduces the midnight off-by-one that attributes
 *  an order to the wrong exhibition. `end_date` is INCLUSIVE (the last day of a
 *  fair is a trading day); a NULL start has no period and contains nothing. */
export function periodContains(
  row: Pick<FairProjectRow, 'startDate' | 'endDate'>,
  date: string,
): boolean {
  if (!row.startDate) return false;
  if (row.startDate > date) return false;
  if (row.endDate && row.endDate < date) return false;
  return true;
}

/** A project is pickable when it is not cancelled and names both a place and an
 *  organizer. A row missing either cannot be told apart from another on screen,
 *  so offering it would be offering a guess. */
export function isPickableFair(row: FairProjectRow): boolean {
  if (clean(row.status).toLowerCase() === 'cancelled') return false;
  if (!clean(row.venue)) return false;
  if (!clean(row.organizer)) return false;
  if (!row.startDate) return false;
  return true;
}

function optionKey(venue: string, organizer: string, start: string, end: string | null): string {
  return [fairKeyPart(venue), fairKeyPart(organizer), start, end ?? ''].join('|');
}

/**
 * Build the two dropdown groups for one order date.
 *
 * @param rows    Every non-cancelled project for the CALLER'S COMPANY in the
 *                relevant window. Scoping is the loader's job; this function
 *                never sees a company id and must not invent one.
 * @param soDate  The ORDER's date (`YYYY-MM-DD`, MYT) — not today's. A backdated
 *                slip must offer the fair that was running the day it was
 *                written, or last week's orders point at this week's exhibition.
 */
export function buildFairOptions(rows: FairProjectRow[], soDate: string): FairOptionGroups {
  const date = clean(soDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { running: [], month: [] };
  const month = date.slice(0, 7);

  const byKey = new Map<string, FairOption>();
  for (const row of rows) {
    if (!isPickableFair(row)) continue;
    const venue = clean(row.venue);
    const organizer = clean(row.organizer);
    const start = row.startDate as string;
    const end = row.endDate ? clean(row.endDate) : null;

    /* In scope: the order's own month, plus anything still running on the order
       date even if it started last month (a fair can straddle a month end). */
    const inMonth = start.slice(0, 7) === month || (end ?? start).slice(0, 7) === month;
    if (!inMonth && !periodContains(row, date)) continue;

    const key = optionKey(venue, organizer, start, end);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.projectIds.includes(row.projectId)) existing.projectIds.push(row.projectId);
      continue;
    }
    byKey.set(key, {
      key, venue, organizer, startDate: start, endDate: end,
      showDates: false,
      projectIds: [row.projectId],
    });
  }

  const all = [...byKey.values()];
  for (const o of all) o.projectIds.sort((a, b) => a - b);

  /* The date exception. Two rows sharing venue+organizer inside one month would
     read identically, so BOTH get their dates — and only those. Owner: no dates
     otherwise. */
  const sameLabel = new Map<string, FairOption[]>();
  for (const o of all) {
    const k = `${fairKeyPart(o.venue)}|${fairKeyPart(o.organizer)}`;
    const list = sameLabel.get(k);
    if (list) list.push(o); else sameLabel.set(k, [o]);
  }
  for (const list of sameLabel.values()) {
    if (list.length > 1) for (const o of list) o.showDates = true;
  }

  const running: FairOption[] = [];
  const rest: FairOption[] = [];
  for (const o of all) {
    if (periodContains({ startDate: o.startDate, endDate: o.endDate }, date)) running.push(o);
    else rest.push(o);
  }

  running.sort((a, b) => a.venue.localeCompare(b.venue) || a.organizer.localeCompare(b.organizer));
  rest.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      a.venue.localeCompare(b.venue) ||
      a.organizer.localeCompare(b.organizer),
  );

  return { running, month: rest };
}

// ── Resolution: from a PICKED row back to one project ────────────────────────

/** How an order's fair link was decided. Persisted in
 *  `scm.mfg_sales_orders.fair_match` so a report can tell a real answer from a
 *  blank, which a NULL `project_id` on its own cannot. */
export type FairMatch =
  /** One project matched — `projectId` is set. */
  | 'PICKED'
  /** No fair exists at that venue on that date yet. The venue is still recorded
   *  and the nightly reconcile will try again once the fair is created. This is
   *  the 23% of fairs that reach the system within a week of opening, 13 of them
   *  after they had already started (measured 2026-09-13, Jun-Sep). */
  | 'PENDING'
  /** A fair exists but more than one brand booth fits and the order's own lines
   *  do not say which. A person decides; the system does not guess. */
  | 'AMBIGUOUS'
  /** A fair exists and the order's brand is not one of its booths — e.g. a
   *  DUNLOPILLO sale written at an AKEMI-only event. Recorded, not resolved. */
  | 'UNMATCHED';

export type FairResolution = {
  projectId: number | null;
  match: FairMatch;
  /** Every project that survived the venue/organizer/date filter. Lets the
   *  pending screen show a person exactly what it was choosing between. */
  candidateIds: number[];
};

/**
 * Resolve the picked row (plus the order's own brand) to ONE project.
 *
 * @param candidates Non-cancelled projects at the PICKED VENUE for this company.
 *   The caller filters by venue in SQL; everything else is decided here so the
 *   rule is testable without a database.
 * @param soDate     The order's date, `YYYY-MM-DD` MYT.
 * @param brand      The order's header branding, already derived from the SKU
 *   (`deriveHeaderBrandingFromLines`). NULL is normal and means "the catalogue
 *   does not know" — 104 of Houzs Century's main products carried no brand on
 *   2026-09-13 — so a null brand must NEVER be read as "no match", only as "this
 *   cannot narrow it".
 * @param organizer  The organizer on the picked row, or NULL when the operator
 *   came through "Others" and picked a place only.
 */
export function resolveFair(input: {
  candidates: FairProjectRow[];
  soDate: string;
  brand: string | null;
  organizer: string | null;
}): FairResolution {
  const date = clean(input.soDate).slice(0, 10);
  const wantOrg = fairKeyPart(input.organizer);
  const wantBrand = fairKeyPart(input.brand);

  const inPeriod = input.candidates
    .filter(isPickableFair)
    .filter((r) => periodContains(r, date))
    .filter((r) => (wantOrg ? fairKeyPart(r.organizer) === wantOrg : true));

  const candidateIds = [...new Set(inPeriod.map((r) => r.projectId))].sort((a, b) => a - b);
  if (inPeriod.length === 0) return { projectId: null, match: 'PENDING', candidateIds };

  if (wantBrand) {
    const onBrand = inPeriod.filter((r) => fairKeyPart(r.brand) === wantBrand);
    if (onBrand.length === 0) return { projectId: null, match: 'UNMATCHED', candidateIds };
    return oneBoothOrNothing(onBrand, candidateIds);
  }

  /* No brand to narrow with. One booth is still an answer; several is not. */
  return oneBoothOrNothing(inPeriod, candidateIds);
}

/** A BOOTH is one organizer's stand for one brand. Two project rows that agree
 *  on both are duplicate records of the same booth — the data-gaps report's
 *  first clean run (2026-09-13) found 66 such groups across all years, 9 of them
 *  inside Jun-Dec 2026 — and collapsing them to the lowest id is a documented,
 *  stable arbiter (the same choice `venue-binding.ts` makes between
 *  indistinguishable projects): an auditable tie-break beats a planner-order
 *  coin flip, and beats refusing to link an order that has exactly one real
 *  answer. `report-fair-data-gaps.mjs` lists the duplicates so they get merged.
 *
 *  Two rows that differ on organizer or brand are DIFFERENT FAIRS with different
 *  P&L, and the lowest id there would be a guess wearing a rule's clothes —
 *  MID VALLEY on 2026-03-20 had MLE and REX side by side. That case answers
 *  AMBIGUOUS and a person decides. */
function oneBoothOrNothing(rows: FairProjectRow[], candidateIds: number[]): FairResolution {
  const booths = new Set(rows.map((r) => `${fairKeyPart(r.organizer)}|${fairKeyPart(r.brand)}`));
  if (booths.size > 1) return { projectId: null, match: 'AMBIGUOUS', candidateIds };
  const pick = rows.reduce((lo, r) => (r.projectId < lo.projectId ? r : lo));
  return { projectId: pick.projectId, match: 'PICKED', candidateIds };
}

/** Human label for one row, used by the picker and by the pending screen so the
 *  two can never describe the same event differently. */
export function fairOptionLabel(o: Pick<FairOption, 'venue' | 'organizer' | 'startDate' | 'endDate' | 'showDates'>): string {
  const base = `${o.venue} — ${o.organizer}`;
  if (!o.showDates) return base;
  const end = o.endDate && o.endDate !== o.startDate ? ` ~ ${o.endDate}` : '';
  return `${base} (${o.startDate}${end})`;
}
