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
// ── WHAT THE OWNER CHANGED ON 2026-09-19 ────────────────────────────────────
// The rule above was written for a list of ONE CALENDAR MONTH, where at most one
// fair per venue+organizer was ever live and a date was noise. That list could
// not do the job he actually has:
//
//   *"我可能是下个星期，才开给上个星期 event 的 sales order"*
//
// An order keyed on 2 Oct for a fair that ran 18-20 Sep fell outside the month
// AND outside "running today", so it appeared nowhere and the sale could not be
// attributed at all. Three things follow, and they replace the paragraph above
// rather than sitting beside it:
//
//   1. THE WINDOW IS 28 DAYS BACK from the order date, never forward —
//      *"应该是当个日期的往前推四个星期…跟着 week 来算"*, and
//      *"日期还没到，还没开单，不可能嘛"*. See `lookbackWindow`.
//   2. EVERY ROW CARRIES ITS DATES, which reverses the "不需要日期" ruling above.
//      He reversed it himself, describing the task: *"今天是 10 号…我需要点 1 号
//      的 event…它是一号到三号的，我就点那个"*. A four-week list is mostly CLOSED
//      fairs and several can share a venue and an organizer, so the label has to
//      say which occurrence. He asked for the YEAR dropped — *"日期不需要年份"* —
//      which the window makes safe: nothing in 28 days needs a year to tell it
//      apart. He was offered `Aug 13 - 17` and chose `13/08 - 17/08`, keeping the
//      system-wide date shape rather than opening a second one. The formatter is
//      `fmtDayMonthRange` in shared/format.ts, beside the rule it varies.
//      DO NOT re-spell it here: `check-date-formatting.mjs` fails the build on a
//      month name, and that gate exists because this tree grew five date formats.
//   3. THE PERIOD IS PART OF THE PICK, not decoration. It travels to the server,
//      which matches that exact occurrence instead of re-deriving one from the
//      order date — the order date being the day it was KEYED, since neither
//      create form has a date field at all.
//
// An ARCHIVED project is never offered (`fair-binding.ts`): it is one the office
// withdrew from, and its revenue lands in a project the P&L excludes.
// ----------------------------------------------------------------------------

import { fmtDayMonthRange } from '../shared/format';

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
  /** `project_event_types.slug` — "exhibition" / "solo". Optional: only the
   *  picker's LABEL reads it, so a loader that resolves a fair need not carry it. */
  eventType?: string | null;
};

/** One row in the dropdown. `key` is what the client sends back on save. */
export type FairOption = {
  /** Stable identity of the EVENT: venue + organizer + period. Not a project id —
   *  one row covers every brand booth at that event, and which brand applies is
   *  decided from the order's own lines, not by the person picking. */
  key: string;
  venue: string;
  organizer: string;
  /** TRUE for a solo roadshow. The label then reads "SOLO" in the organizer's
   *  place (owner 2026-09-18: a solo roadshow has no organizer to name, the mall
   *  management is only who the space was rented from). `organizer` itself is
   *  untouched — it is still what the save path resolves the project from. */
  solo: boolean;
  /** The event's period. It travels with the pick and is what the save path
   *  matches the event on — see `loadFairsForEvent`. Not decoration: it is half
   *  the row's identity, and dropping it is what made a fair that had already
   *  closed impossible to attribute a sale to. */
  startDate: string;
  endDate: string | null;
  /** The project ids this row covers, one per brand. For display/debug only —
   *  the server re-resolves on save and never trusts an id from the client. */
  projectIds: number[];
};

export type FairOptionGroups = {
  /** Fairs whose period CONTAINS the order date. Normally where the rep is. */
  running: FairOption[];
  /** The rest of the lookback window — fairs that have already CLOSED, newest
   *  first. Never anything in the future: the window ends at the order date.
   *  Was `month` until 2026-09-19, when the window stopped being a calendar
   *  month; the name changed with it so it cannot quietly describe the wrong
   *  thing. */
  earlier: FairOption[];
};

const clean = (v: string | null | undefined): string =>
  typeof v === 'string' ? v.trim() : '';

/** Case/space-insensitive compare key. `MALL MGMT` and `mall  mgmt` are one. */
export function fairKeyPart(v: string | null | undefined): string {
  return clean(v).toLowerCase().replace(/\s+/g, ' ');
}

/** How far back the picker looks. Owner 2026-09-19: *"应该是当个日期的往前推四个
 *  星期… 跟着 week 来算"*. */
export const FAIR_LOOKBACK_DAYS = 28;

/**
 * The picker's window: `days` back from the ORDER DATE, inclusive, and never
 * forward.
 *
 * REPLACED THE CALENDAR MONTH (owner 2026-09-19). The old window was the order
 * date's whole calendar month, which was wrong in both directions:
 *
 *   TOO NARROW — an order written on 2 Oct for a fair that ran 18-20 Sep saw
 *   nothing. September is not October's month and the fair was not running on
 *   2 Oct, so it appeared in neither group and the sale could not be attributed
 *   at all. The owner writes these routinely: *"我可能是下个星期，才开给上个星期
 *   event 的 sales order"*.
 *
 *   TOO WIDE, in the useless direction — on the 10th it also offered fairs
 *   starting on the 20th. Nobody keys an order before the event happens:
 *   *"日期还没到，还没开单，不可能嘛"*. Offering one is a wrong pick waiting to be
 *   made, so the window ENDS at the order date and the future is simply absent.
 *
 * Day arithmetic goes through `Date.UTC` on the PARTS and comes straight back
 * out as a date string, so no value is ever an instant in a zone and the MYT
 * calendar date survives. Everything downstream compares plain strings, which
 * is an exact MYT-to-MYT comparison.
 */
export function lookbackWindow(
  date: string,
  days: number = FAIR_LOOKBACK_DAYS,
): { start: string; end: string } {
  const end = clean(date).slice(0, 10);
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(5, 7));
  const d = Number(end.slice(8, 10));
  const start = new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
  return { start, end };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The picked row's period as it arrives on a create/patch body, or null when
 * the caller picked a PLACE rather than an event ("Others"), or is an older
 * client that does not send one yet.
 *
 * Validated rather than trusted: a malformed date must degrade to "no event
 * picked", which falls back to the venue window, never to a lookup that matches
 * nothing and reports PENDING for a reason nobody can see. A missing END is
 * legitimate and distinct from a missing start — it is a one-day fair.
 */
export function fairPickedPeriod(body: {
  fairStart?: unknown;
  fairEnd?: unknown;
}): { startDate: string; endDate: string | null } | null {
  const start = typeof body.fairStart === 'string' ? body.fairStart.slice(0, 10) : '';
  if (!ISO_DATE.test(start)) return null;
  const end = typeof body.fairEnd === 'string' ? body.fairEnd.slice(0, 10) : '';
  return { startDate: start, endDate: ISO_DATE.test(end) ? end : null };
}

/** Does `date` fall inside the project's period? Plain lexicographic MYT date
 *  compare, no `Date` objects, because `new Date('2026-07-19')` is 08:00 MYT and
 *  the arithmetic from there re-introduces the midnight off-by-one that
 *  attributes an order to the wrong exhibition. `end_date` is INCLUSIVE (the
 *  last day of a fair is a trading day); a NULL start has no period and contains
 *  nothing.
 *
 *  A NULL END IS ONE DAY, NOT FOREVER (changed 2026-09-19). It used to mean
 *  open-ended, so a fair that started in March and never declared an end stayed
 *  under "Running now" in September — while `GET /api/projects/calendar/events`
 *  read the same blank as `COALESCE(end_date, start_date)` and drew a one-day
 *  bar back in March. Two screens, one column, opposite answers; this side was
 *  the wrong one, because a fair the calendar says is over must not be offered
 *  as running. Houzs Century has 0 blank end dates today (probe run
 *  35432690927), so this shuts a trap rather than moving a number.
 *
 *  venue-binding.ts::periodContains keeps the open-ended reading DELIBERATELY —
 *  it resolves a rep's standing assignment, where an undated project is a
 *  background campaign that really does continue. Same name, different question;
 *  they are not a duplicated rule to unify. */
export function periodContains(
  row: Pick<FairProjectRow, 'startDate' | 'endDate'>,
  date: string,
): boolean {
  if (!row.startDate) return false;
  if (row.startDate > date) return false;
  if ((row.endDate ?? row.startDate) < date) return false;
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

function isSoloRow(row: FairProjectRow): boolean {
  return clean(row.eventType).toLowerCase() === 'solo';
}

/** The organizer half of the label. An EXHIBITION names its organizer — that is
 *  what tells two fairs at one venue apart. A SOLO roadshow reads "SOLO". */
function labelOrganizer(o: Pick<FairOption, 'organizer' | 'solo'>): string {
  return o.solo ? 'SOLO' : o.organizer;
}

function optionKey(venue: string, organizer: string, start: string, end: string | null): string {
  return [fairKeyPart(venue), fairKeyPart(organizer), start, end ?? ''].join('|');
}

/**
 * Build the two dropdown groups for one order date.
 *
 * @param rows    Every pickable project for the CALLER'S COMPANY that overlaps
 *                the lookback window. Scoping is the loader's job; this function
 *                never sees a company id and must not invent one.
 * @param soDate  The ORDER's date (`YYYY-MM-DD`, MYT). The window is measured
 *                back from THIS date, and it is also the line between the two
 *                groups: a fair still running on it, or one already closed.
 */
export function buildFairOptions(rows: FairProjectRow[], soDate: string): FairOptionGroups {
  const date = clean(soDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { running: [], earlier: [] };
  const { start: windowStart } = lookbackWindow(date);

  const byKey = new Map<string, FairOption>();
  for (const row of rows) {
    if (!isPickableFair(row)) continue;
    const venue = clean(row.venue);
    const organizer = clean(row.organizer);
    const start = row.startDate as string;
    const end = row.endDate ? clean(row.endDate) : null;

    /* Overlaps [windowStart, orderDate]. The upper bound is what keeps fairs
       that have not happened yet out of the list — there is no separate
       "no future" rule to forget. */
    if (start > date) continue;
    if ((end ?? start) < windowStart) continue;

    const key = optionKey(venue, organizer, start, end);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.projectIds.includes(row.projectId)) existing.projectIds.push(row.projectId);
      continue;
    }
    byKey.set(key, {
      key, venue, organizer, solo: isSoloRow(row), startDate: start, endDate: end,
      projectIds: [row.projectId],
    });
  }

  const all = [...byKey.values()];
  for (const o of all) o.projectIds.sort((a, b) => a - b);

  const running: FairOption[] = [];
  const earlier: FairOption[] = [];
  for (const o of all) {
    if (periodContains({ startDate: o.startDate, endDate: o.endDate }, date)) running.push(o);
    else earlier.push(o);
  }

  running.sort((a, b) => a.venue.localeCompare(b.venue) || a.organizer.localeCompare(b.organizer));
  /* NEWEST FIRST in the closed group. The window is four weeks of history and
     the fair that just ended is overwhelmingly the one being written up; the
     old ascending order put the oldest at the top, which is the least likely
     answer. */
  earlier.sort(
    (a, b) =>
      b.startDate.localeCompare(a.startDate) ||
      a.venue.localeCompare(b.venue) ||
      a.organizer.localeCompare(b.organizer),
  );

  return { running, earlier };
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
  brand: string | null;
  organizer: string | null;
}): FairResolution {
  const wantOrg = fairKeyPart(input.organizer);
  const wantBrand = fairKeyPart(input.brand);

  /* NO DATE FILTER HERE ANY MORE (2026-09-19). The caller has already narrowed
     the candidates — to the exact event the operator picked, or to the venue's
     fairs inside the lookback window — and re-checking "was it running on the
     order date" here would undo that. It is precisely what it used to do, and
     it is why an order written a week after its fair closed could not be
     attributed by any path in the system: the save refused it, the nightly
     reconcile refused it again, and the settle-by-hand screen refused it a
     third time, all from this one line. */
  const narrowed = input.candidates
    .filter(isPickableFair)
    .filter((r) => (wantOrg ? fairKeyPart(r.organizer) === wantOrg : true));

  const candidateIds = [...new Set(narrowed.map((r) => r.projectId))].sort((a, b) => a - b);
  if (narrowed.length === 0) return { projectId: null, match: 'PENDING', candidateIds };

  if (wantBrand) {
    const onBrand = narrowed.filter((r) => fairKeyPart(r.brand) === wantBrand);
    if (onBrand.length === 0) return { projectId: null, match: 'UNMATCHED', candidateIds };
    return oneBoothOrNothing(onBrand, candidateIds);
  }

  /* No brand to narrow with. One booth is still an answer; several is not. */
  return oneBoothOrNothing(narrowed, candidateIds);
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
  /* THE PERIOD IS PART OF THE BOOTH KEY (added 2026-09-19). Without it, REX /
     AKEMI at one venue twice inside the lookback window read as ONE booth and
     collapsed to the lower id — silently posting the second fair's sales to the
     first fair's P&L. That could not happen while the caller filtered to fairs
     running on the order date, because only one of them ever was; the window
     made two of them reachable at once, so the key has to carry what now tells
     them apart. Two rows that differ only by period are DIFFERENT FAIRS. */
  const booths = new Set(
    rows.map((r) => `${fairKeyPart(r.organizer)}|${fairKeyPart(r.brand)}|${r.startDate ?? ''}|${r.endDate ?? ''}`),
  );
  if (booths.size > 1) return { projectId: null, match: 'AMBIGUOUS', candidateIds };
  const pick = rows.reduce((lo, r) => (r.projectId < lo.projectId ? r : lo));
  return { projectId: pick.projectId, match: 'PICKED', candidateIds };
}

/**
 * Human label for one row, used by the picker and by the pending screen so the
 * two can never describe the same event differently.
 *
 * EVERY ROW CARRIES ITS DATES (owner 2026-09-19). This REVERSES his 2026-09-13
 * ruling — *"我觉得不需要日期啦…只需要选 event 和 organizer 就好了"* — and the
 * reversal is his, stated while describing what he needs to do:
 *
 *   *"今天是 10 号，我在 10 号的时候我开单，然后我需要点 1 号的 event。所以我一号
 *   看到是有那个 venue，有那个 organizer，然后它是一号到三号的，我就点那个"*
 *
 * The first ruling was correct FOR ITS LIST. That list was one calendar month
 * with at most one live fair per venue+organizer, so the dates were noise and
 * only the four collisions in seven months needed them. The list is now four
 * weeks of CLOSED fairs, several of which can share a venue and an organizer,
 * and the whole point of picking one is to say WHICH occurrence — a choice the
 * label has to show or the operator is guessing.
 *
 * So the narrow `showDates` exception is gone rather than widened: with every
 * row dated there is nothing left for it to decide. Do not reintroduce it, and
 * do not strip the dates back off as tidying — that is what happened to the
 * ORGANIZER on 2026-09-15 and it had to be put back the next morning.
 */
export function fairOptionLabel(o: Pick<FairOption, 'venue' | 'organizer' | 'solo' | 'startDate' | 'endDate'>): string {
  return `${o.venue} — ${labelOrganizer(o)} (${fmtDayMonthRange(o.startDate, o.endDate)})`;
}
