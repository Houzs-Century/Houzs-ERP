// ----------------------------------------------------------------------------
// venue-binding.ts — THE venue resolver. One pure function, one SQL loader.
//
// WHY THIS FILE EXISTS
// Before it, the SAME query was written out THREE times in
// routes/mfg-sales-orders.ts: the GET /active-venue endpoint (so the New-SO form
// can pre-select the venue), the create-time venue TEXT fallback, and the
// create-time project_id hard-link (#814). Three copies of a rule that decides
// which exhibition a sale is attributed to — and therefore which fair's P&L and
// whose commission it lands in. They had already begun to differ (the endpoint
// joins project_venues to return a master id; the other two do not), and a
// fourth caller (mobile) was next. Now there is one rule and three callers.
//
// Desktop and mobile share this layer by construction: both hit the same HTTP
// endpoints, which call resolveVenueBinding(). Neither client re-implements it.
//
// ── THE OWNER'S RULE (2026-07-19) ───────────────────────────────────────────
// A salesperson gets bound to a venue two ways, and both must coexist:
//   1. PMS / exhibition — picked as Sales Attending (or PIC) on a project. Their
//      orders during that project's PERIOD bind to that project's venue.
//   2. Showroom — "parked under" a Showroom on the Members page. Their orders
//      attribute to that showroom's venue.
//
// Resolution order: PMS first, showroom second, then NOTHING.
//
// Rule 3 is the important one. There is NO company default, NO first-venue
// fallback, NO `?? ''`. An unresolvable venue is EMPTY. This codebase has a
// documented history of `??` defaults turning "I don't know" into a confident
// wrong value (three money bugs in one day), and venue feeds exhibition P&L and
// commission — a guessed venue is a wrong profit figure attributed to a real
// person. Empty is honest and visibly incomplete; wrong is neither.
//
// The two bindings are deliberately NOT mutually exclusive. The owner considered
// forbidding a showroom-parked rep from being picked in PMS and chose the
// alternative: the binding is a DEFAULT, manual override always possible. A
// showroom salesperson sent to an exhibition is normal and frequent; mutual
// exclusion would make the venue wrong precisely DURING the exhibition, which is
// when it matters most.
// ----------------------------------------------------------------------------

/** How an SO's venue got there. Persisted in scm.mfg_sales_orders.venue_source. */
import { canonicalizeVenue } from './canonical-venue';

export type VenueSource = 'PMS' | 'SHOWROOM' | 'MANUAL';

/**
 * A project the rep is attached to (as PIC or Sales Attending), pre-filtered to
 * ones that have a non-empty venue. Dates are MYT calendar dates (`YYYY-MM-DD`)
 * exactly as public.projects stores them — see the MYT note on
 * `resolveVenueBinding`.
 */
export type PmsCandidate = {
  projectId: number;
  projectName: string | null;
  venue: string;
  /** `YYYY-MM-DD`, MYT. A project with no start date cannot contain a date. */
  startDate: string | null;
  /** `YYYY-MM-DD`, MYT, INCLUSIVE. NULL = open-ended (still running). */
  endDate: string | null;
};

/** The showroom a rep is parked under (scm.staff.showroom_warehouse_id). */
export type ShowroomCandidate = {
  warehouseId: string;
  warehouseName: string;
  /** scm.warehouses.venue_name. NULL/blank = the showroom has no venue yet. */
  venueName: string | null;
};

export type VenueBinding = {
  /** The venue TEXT to stamp, or null. NEVER a guess — null means null. */
  venueName: string | null;
  /** The fair this SO belongs to (mfg_sales_orders.project_id). PMS only. */
  projectId: number | null;
  projectName: string | null;
  /** Which rule fired. null when nothing resolved. */
  source: VenueSource | null;
  /** The showroom that supplied the venue, for the FE hint. SHOWROOM only. */
  showroomWarehouseId: string | null;
};

const NOTHING: VenueBinding = {
  venueName: null,
  projectId: null,
  projectName: null,
  source: null,
  showroomWarehouseId: null,
};

/** Trimmed non-empty string, or null. No empty-string-as-a-value anywhere. */
function clean(v: string | null | undefined): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

/**
 * Does `date` fall inside the project's period?
 *
 * ── MYT ─────────────────────────────────────────────────────────────────────
 * Every value here is a `YYYY-MM-DD` MALAYSIAN CALENDAR DATE, never an instant:
 * `projects.start_date`/`end_date` are TEXT dates entered in the Malaysian
 * office, and the order date is either the user-typed `soDate` or `todayMyt()`
 * (lib/my-time.ts, which shifts +8h BEFORE slicing precisely so a Worker running
 * in UTC does not read yesterday's date all morning). Comparing them as plain
 * lexicographic strings is therefore an exact MYT-to-MYT comparison — there is
 * no timezone left in the values to get wrong.
 *
 * This is why the comparison must NOT be done with `Date` objects: `new
 * Date('2026-07-19')` is UTC midnight, which is 08:00 MYT, and any arithmetic
 * from there re-introduces the off-by-one at midnight that would attribute an
 * order to the wrong exhibition. The CALLER's job is to hand this function MYT
 * date strings; the tests pin that contract at the 16:00Z/00:00-MYT boundary.
 *
 * `end_date` is INCLUSIVE (the last day of the fair is a trading day) and NULL
 * means open-ended — a project that has started and has no declared end is
 * still running. A NULL start_date cannot contain anything: an undated project
 * has no period, and treating it as "always" would make it swallow every order.
 */
function periodContains(c: PmsCandidate, date: string): boolean {
  if (!c.startDate) return false;
  if (c.startDate > date) return false;
  if (c.endDate && c.endDate < date) return false;
  return true;
}

/**
 * Deterministic ordering among projects that ALL contain the order's date.
 * Returns <0 if `a` should win.
 *
 * ── WHY NOT JUST `ORDER BY start_date DESC LIMIT 1` (the old rule) ──────────
 * That was arbitrary in two ways. It never checked `end_date`, so a fair that
 * ended in March still claimed every order in July — forever, for anyone who was
 * ever a Sales Attending rep on it. And among projects sharing a start_date it
 * picked whatever the planner returned, so the same rep on the same day could
 * get a different venue on two identical orders. Both are fixed here; the
 * end_date fix is the behaviour change worth calling out (an ENDED project no
 * longer resolves — which is what "during that project's period" means).
 *
 * The tie-break chain, most to least significant:
 *   1. LATEST start_date. Of two overlapping periods, the one that started more
 *      recently is the one the rep is at now; the older is the background
 *      campaign they were also assigned to.
 *   2. SHORTEST period. Same start, so specificity decides: a 3-day fair inside
 *      a 3-month regional campaign is where the rep physically is. An
 *      open-ended project (no end_date) is treated as infinitely long and so
 *      always loses this step — which also encodes "a bounded fair beats an
 *      open-ended campaign".
 *   3. LOWEST project id. Not meaningful, and not pretending to be — it is the
 *      final, stable arbiter so that two genuinely indistinguishable projects
 *      always produce the SAME answer rather than a planner-order coin flip. A
 *      documented arbitrary tie-break is auditable; a silent one is not.
 */
function compareCandidates(a: PmsCandidate, b: PmsCandidate): number {
  // 1. Latest start wins. (startDate is non-null — periodContains filtered.)
  if (a.startDate !== b.startDate) return (a.startDate ?? '') > (b.startDate ?? '') ? -1 : 1;
  // 2. Shortest period wins; open-ended (null end) sorts last.
  const aOpen = !a.endDate;
  const bOpen = !b.endDate;
  if (aOpen !== bOpen) return aOpen ? 1 : -1;
  if (!aOpen && !bOpen && a.endDate !== b.endDate) {
    return (a.endDate as string) < (b.endDate as string) ? -1 : 1;
  }
  // 3. Stable arbitrary: lowest id.
  return a.projectId - b.projectId;
}

/**
 * THE resolver. Pure — no I/O, no clock, no DB. Every input is passed in, so the
 * rule that decides commission attribution is testable without a database.
 *
 * @param soDate The ORDER's date (`YYYY-MM-DD`, MYT), NOT today's. A backdated
 *   order must resolve against the fair that was running on the day it was
 *   written, or last month's orders re-attribute to this month's exhibition.
 * @param pmsCandidates Every project the rep is PIC/Sales-Attending on. Filtered
 *   and ranked HERE, not in SQL, so the tie-break is covered by tests.
 * @param showroom The showroom the rep is parked under, or null.
 */
export function resolveVenueBinding(input: {
  soDate: string;
  pmsCandidates: PmsCandidate[];
  showroom: ShowroomCandidate | null;
}): VenueBinding {
  const soDate = clean(input.soDate);
  if (!soDate) return NOTHING;

  // ── Rule 1: PMS / exhibition ──────────────────────────────────────────────
  const inPeriod = input.pmsCandidates
    .filter((c) => clean(c.venue) && periodContains(c, soDate))
    .sort(compareCandidates);
  const winner = inPeriod[0];
  if (winner) {
    return {
      venueName: canonicalizeVenue(clean(winner.venue)),
      projectId: winner.projectId,
      projectName: clean(winner.projectName),
      source: 'PMS',
      showroomWarehouseId: null,
    };
  }

  // ── Rule 2: showroom ──────────────────────────────────────────────────────
  // A showroom with no venue_name resolves to NOTHING rather than falling
  // through to its warehouse NAME — a stock code is not a venue, and inventing
  // one here would put "KL-WH-02" into exhibition P&L.
  const showroomVenue = clean(input.showroom?.venueName);
  if (input.showroom && showroomVenue) {
    return {
      venueName: canonicalizeVenue(showroomVenue),
      projectId: null,
      projectName: null,
      source: 'SHOWROOM',
      showroomWarehouseId: input.showroom.warehouseId,
    };
  }

  // ── Rule 3: nothing ───────────────────────────────────────────────────────
  return NOTHING;
}

/**
 * May an automatic re-resolve overwrite this SO's venue?
 *
 * NO once a human has picked one. The binding is a DEFAULT, not a lock: the
 * resolver proposes, the user disposes, and their choice must survive anything
 * that later re-runs the resolver over an existing order (an amendment, a
 * backfill, a re-scan). Every automated writer must gate on this — the marker
 * only protects the user if the callers actually ask.
 *
 * A NULL source is legacy/unknown provenance, NOT a human choice, so it stays
 * eligible. Nothing re-resolves an existing SO today; this is the guard that has
 * to already be in place when something does.
 */
export function canAutoResolveVenue(venueSource: string | null | undefined): boolean {
  return venueSource !== 'MANUAL';
}

// ── SQL loader ───────────────────────────────────────────────────────────────
// Thin and impure by design: it only FETCHES: every decision lives in the pure
// function above. Reads the PUBLIC schema (projects, project_sales_attendees,
// sales_reps) via env.DB — the scm supabase client cannot reach public — and the
// scm schema (staff, warehouses) via the supabase client.

/** The `DB` binding surface this loader needs (structural, so tests can fake it). */
export type VenueBindingDb = {
  prepare(sql: string): {
    bind(...vals: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
  };
};

/** The supabase surface this loader needs (structural, same reason).
 *  `maybeSingle` is typed PromiseLike, not Promise: supabase-js returns a
 *  PostgrestBuilder (thenable, no .catch/.finally), so demanding a real Promise
 *  makes the live client structurally incompatible with its own shape. */
export type VenueBindingSb = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): { maybeSingle(): PromiseLike<{ data: unknown }> };
    };
  };
};

/**
 * Fetch both binding sources for one user. Best-effort on BOTH halves
 * independently: a failing showroom lookup must not cost the rep their
 * exhibition venue, and vice versa. A failure yields NO candidates, which
 * resolves to empty — never to a guess.
 */
export async function loadVenueBindingInputs(args: {
  db: VenueBindingDb;
  sb: VenueBindingSb | null;
  /** public.users.id of the salesperson the order is attributed to. */
  userId: number;
  /** scm.staff.id of that same person, when known. Null skips the showroom half. */
  staffId?: string | null;
}): Promise<{ pmsCandidates: PmsCandidate[]; showroom: ShowroomCandidate | null }> {
  const pmsCandidates = await loadPmsCandidates(args.db, args.userId);
  const showroom = args.sb && args.staffId
    ? await loadShowroom(args.sb, args.staffId)
    : null;
  return { pmsCandidates, showroom };
}

async function loadPmsCandidates(db: VenueBindingDb, userId: number): Promise<PmsCandidate[]> {
  try {
    /* NO date predicate and NO LIMIT: every project the rep is attached to comes
       back, and the pure resolver does the period test + tie-break. Pushing that
       into SQL is what made the old rule untestable and let `ORDER BY start_date
       DESC LIMIT 1` hide the missing end_date check for a month. The row count is
       bounded by "projects this one person is assigned to", which is small. */
    const rows = await db
      .prepare(
        `SELECT p.id AS id, p.name AS projectname, p.venue AS venue,
                p.start_date AS startdate, p.end_date AS enddate
           FROM projects p
          WHERE p.venue IS NOT NULL AND p.venue <> ''
            AND (
              p.pic_id = ?
              OR EXISTS (
                SELECT 1 FROM project_sales_attendees psa
                  JOIN sales_reps sr ON sr.id = psa.sales_rep_id
                 WHERE psa.project_id = p.id AND sr.user_id = ?
              )
            )`,
      )
      .bind(userId, userId)
      .all<Record<string, unknown>>();
    return ((rows.results ?? []) as Array<Record<string, unknown>>)
      .map((r) => ({
        projectId: Number(r.id),
        projectName: (r.projectname as string | null) ?? null,
        venue: String(r.venue ?? ''),
        /* Dual-read snake AND camel: the pg driver camelCases result columns,
           which is the single most recurring bug in this tree. The aliases above
           are already lower-cased for the D1 path; these cover the pg path. */
        startDate: ((r.startdate ?? r.startDate ?? r.start_date) as string | null) ?? null,
        endDate: ((r.enddate ?? r.endDate ?? r.end_date) as string | null) ?? null,
      }))
      .filter((c) => Number.isFinite(c.projectId));
  } catch {
    /* Non-fatal: no candidates -> the showroom rule gets its turn, then empty. */
    return [];
  }
}

async function loadShowroom(
  sb: VenueBindingSb,
  staffId: string,
): Promise<ShowroomCandidate | null> {
  try {
    const { data: staffRow } = await sb
      .from('staff')
      .select('showroom_warehouse_id')
      .eq('id', staffId)
      .maybeSingle();
    const whId =
      ((staffRow as Record<string, unknown> | null)?.showroomWarehouseId ??
        (staffRow as Record<string, unknown> | null)?.showroom_warehouse_id) as
        | string
        | null
        | undefined;
    if (!whId) return null;
    const { data: whRow } = await sb
      .from('warehouses')
      .select('id, name, venue_name, is_showroom')
      .eq('id', whId)
      .maybeSingle();
    const wh = whRow as Record<string, unknown> | null;
    if (!wh) return null;
    /* The flag is re-checked at RESOLVE time, not trusted from the parking row:
       un-flagging a warehouse as a showroom must immediately stop it supplying
       venues, without anyone having to unpark the staff parked under it. */
    const isShowroom = (wh.isShowroom ?? wh.is_showroom) as boolean | undefined;
    if (isShowroom !== true) return null;
    return {
      warehouseId: String(wh.id ?? whId),
      warehouseName: String(wh.name ?? ''),
      venueName: ((wh.venueName ?? wh.venue_name) as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The venue NAME a half-written pair implies, or null when there is nothing to
 * imply it from.
 *
 * A client that sends an empty `venue` beside a non-empty `venueId` has resolved
 * the id and not the name — it is not asking for the venue to be cleared. Taking
 * it literally wiped "2990s PJ" off a live order (`docs/bugs/0591-*`), and every
 * mirrored 2990 order was one save away from the same thing.
 *
 * HERE, BESIDE THE BINDING RULE, and not inline in the route: the CREATE path
 * already resolves a name from an id in exactly this situation, and two copies
 * of one rule is how the two paths start disagreeing. This is the shared one.
 *
 * Clearing a venue stays possible and stays easy — send BOTH empty. That is what
 * "this order has no venue" looks like, and it is a legitimate answer.
 */
export async function venueNameForHalfWrittenPair(
  sb: { from: (t: string) => { select: (c: string) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> } } } },
  venue: unknown,
  venueId: unknown,
): Promise<string | null> {
  const nameEmpty = typeof venue === 'string' && !venue.trim();
  const idGiven = typeof venueId === 'string' && !!venueId.trim();
  if (!nameEmpty || !idGiven) return null;
  const { data } = await sb.from('venues').select('name').eq('id', venueId).maybeSingle();
  const name = (data as { name?: string } | null)?.name ?? null;
  return name && name.trim() ? name : null;
}
