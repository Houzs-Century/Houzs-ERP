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
  startDate: string | null;
  endDate: string | null;
};

/** The showroom a rep is parked under (scm.staff.showroom_warehouse_id). */
export type ShowroomCandidate = {
  warehouseId: string;
  warehouseName: string;
  venueName: string | null;
};

export type VenueBinding = {
  venueName: string | null;
  projectId: number | null;
  projectName: string | null;
  source: VenueSource | null;
  showroomWarehouseId: string | null;
};

const NOTHING: VenueBinding = {
  venueName: null,
  projectId: null,
  projectName: null,
  source: null,
  showroomWarehouseId: null,
};

function clean(v: string | null | undefined): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

function periodContains(c: PmsCandidate, date: string): boolean {
  if (!c.startDate) return false;
  if (c.startDate > date) return false;
  if (c.endDate && c.endDate < date) return false;
  return true;
}

function compareCandidates(a: PmsCandidate, b: PmsCandidate): number {
  if (a.startDate !== b.startDate) return (a.startDate ?? '') > (b.startDate ?? '') ? -1 : 1;
  const aOpen = !a.endDate;
  const bOpen = !b.endDate;
  if (aOpen !== bOpen) return aOpen ? 1 : -1;
  if (!aOpen && !bOpen && a.endDate !== b.endDate) {
    return (a.endDate as string) < (b.endDate as string) ? -1 : 1;
  }
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
  userId: number;
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
    const rows = await db
      .prepare(
        /* ARCHIVED AND CANCELLED PROJECTS ARE NOT A VENUE (owner 2026-09-19).
           This query had NEITHER guard — the loosest read of `projects` in the
           system — so a fair the office had withdrawn from, or cancelled
           outright, could still be stamped onto a new sales order AUTOMATICALLY,
           with nobody clicking anything. That is worse than the dropdown fault
           it was found beside (project 359, archived six weeks before its event,
           offered under "Running now"): a wrong default is silent, and venue
           feeds exhibition P&L and commission, so it is paid to a real person.
           The module's own rule is that a failure here must yield NOTHING
           rather than a guess — an archived project is a guess. */
        `SELECT p.id AS id, p.name AS projectname, p.venue AS venue,
                p.start_date AS startdate, p.end_date AS enddate
           FROM projects p
          WHERE p.venue IS NOT NULL AND p.venue <> ''
            AND p.archived_at IS NULL
            AND lower(coalesce(p.status, '')) <> 'cancelled'
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
        startDate: ((r.startdate ?? r.startDate ?? r.start_date) as string | null) ?? null,
        endDate: ((r.enddate ?? r.endDate ?? r.end_date) as string | null) ?? null,
      }))
      .filter((c) => Number.isFinite(c.projectId));
  } catch {
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
 * What a half-written venue pair implies, or `unresolved` when the answer could
 * not be established.
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
 * THREE OUTCOMES, NOT TWO, and the third is the reason this returns an object.
 * `unresolved` means the venue master could not be read — NOT that the venue has
 * no name. Collapsing those onto one `null` hands the caller a blank it will
 * write, which is the very deletion this function exists to stop: a five-second
 * database blip would wipe the venue off whatever was being saved at the time.
 * On `unresolved` the caller must leave the stored venue alone.
 *
 * Clearing a venue stays possible and stays easy — send BOTH empty. That is what
 * "this order has no venue" looks like, and it is a legitimate answer; it never
 * reaches here, because `notApplicable` is what an empty id produces.
 */
export type HalfWrittenVenue =
  | { kind: 'notApplicable' }
  | { kind: 'resolved'; name: string }
  | { kind: 'unresolved' };

type VenueNameReader = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

export async function venueNameForHalfWrittenPair(
  sb: VenueNameReader,
  venue: unknown,
  venueId: unknown,
): Promise<HalfWrittenVenue> {
  const nameEmpty = typeof venue === 'string' && !venue.trim();
  const idGiven = typeof venueId === 'string' && !!venueId.trim();
  if (!nameEmpty || !idGiven) return { kind: 'notApplicable' };
  const { data, error } = await sb.from('venues').select('name').eq('id', venueId).maybeSingle();
  if (error) return { kind: 'unresolved' };
  const name = (data as { name?: string } | null)?.name ?? null;
  return name && name.trim() ? { kind: 'resolved', name } : { kind: 'unresolved' };
}
