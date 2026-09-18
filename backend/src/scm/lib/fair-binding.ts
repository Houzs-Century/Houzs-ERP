// ----------------------------------------------------------------------------
// fair-binding.ts — the SQL half of the fair picker. Thin and impure BY DESIGN:
// it only FETCHES. Every decision lives in the pure `fair-options.ts` beside it,
// so the rule that decides which exhibition a sale is attributed to is testable
// without a database. Same split as venue-binding.ts, and for the same reason:
// the last time this decision lived inside SQL, `ORDER BY start_date DESC LIMIT
// 1` hid a missing end_date check for a month.
//
// Reads the PUBLIC schema (projects, project_venues) via `env.DB` — the scm
// supabase client cannot reach public.
// ----------------------------------------------------------------------------

import {
  resolveFair,
  type FairProjectRow,
  type FairResolution,
} from './fair-options';
import {
  loadVenueBindingInputs,
  resolveVenueBinding,
  type VenueBindingDb,
  type VenueBindingSb,
  type VenueSource,
} from './venue-binding';

/** The `DB` binding surface these loaders need (structural, so tests can fake
 *  it without a Worker runtime). */
export type FairDb = {
  prepare(sql: string): {
    bind(...vals: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
  };
};

/** One venue-master row, for the "Others" pick. */
export type VenueMasterRow = { id: string; name: string };

/* The pg driver camelCases result columns and the D1 mirror does not. Reading
   only one of the two is the single most recurring bug in this tree, so every
   row mapper here is dual-read. */
function str(r: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v);
  }
  return null;
}

function toFairRow(r: Record<string, unknown>): FairProjectRow {
  return {
    projectId: Number(r.id),
    venue: str(r, 'venue'),
    organizer: str(r, 'organizer'),
    brand: str(r, 'brand'),
    startDate: str(r, 'startdate', 'startDate', 'start_date'),
    endDate: str(r, 'enddate', 'endDate', 'end_date'),
    status: str(r, 'status'),
  };
}

/* Cancelled fairs are excluded in SQL as well as in the pure filter. Not
   redundant: it keeps the row set small on a table with 924 Houzs Century
   projects, and `isPickableFair` stays the single authority on the decision. */
const FAIR_COLUMNS =
  'p.id AS id, p.venue AS venue, p.organizer AS organizer, p.brand AS brand, ' +
  'p.start_date AS startdate, p.end_date AS enddate, p.status AS status';

const LIVE_FAIR = `p.venue IS NOT NULL AND trim(p.venue) <> ''
     AND p.start_date IS NOT NULL
     AND lower(coalesce(p.status, '')) <> 'cancelled'`;

/** First and last day of `date`'s calendar month, as MYT date strings. Pure
 *  string arithmetic — never `Date`, which is UTC midnight = 08:00 MYT and
 *  re-introduces the off-by-one this codebase has already paid for twice. */
export function monthBounds(date: string): { start: string; end: string } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Every fair that could appear in the picker for one order date: the order's own
 * calendar month, plus anything still RUNNING on that date even if it started
 * last month. Bounded on both halves so this never degenerates into a full scan.
 *
 * @param companySql A ready-to-interpolate ` AND p.company_id = N` fragment from
 *   `activeCompanySql(c, 'p.company_id')`. It is the ENTIRE tenant boundary here
 *   — the fair list names other companies' venues and organizers, which is
 *   exactly the leak the 2026-08-20 venue sweep closed.
 */
export async function loadFairsForMonth(
  db: FairDb,
  companySql: string,
  soDate: string,
): Promise<FairProjectRow[]> {
  const { start, end } = monthBounds(soDate);
  const rows = await db
    .prepare(
      `SELECT ${FAIR_COLUMNS}
         FROM projects p
        WHERE ${LIVE_FAIR}
          AND (
            (p.start_date >= ? AND p.start_date <= ?)
            OR (p.start_date <= ? AND (p.end_date IS NULL OR p.end_date >= ?))
          )${companySql}`,
    )
    .bind(start, end, soDate, soDate)
    .all<Record<string, unknown>>();
  return ((rows.results ?? []) as Array<Record<string, unknown>>)
    .map(toFairRow)
    .filter((r) => Number.isFinite(r.projectId));
}

/** Every fair at ONE venue whose period contains the order date. The venue match
 *  is case/space-insensitive because the picker writes the master's spelling but
 *  historical rows and PMS rows were typed by hand. */
export async function loadFairsAtVenue(
  db: FairDb,
  companySql: string,
  venue: string,
  soDate: string,
): Promise<FairProjectRow[]> {
  const rows = await db
    .prepare(
      `SELECT ${FAIR_COLUMNS}
         FROM projects p
        WHERE ${LIVE_FAIR}
          AND lower(trim(p.venue)) = lower(trim(?))
          AND p.start_date <= ?
          AND (p.end_date IS NULL OR p.end_date >= ?)${companySql}`,
    )
    .bind(venue, soDate, soDate)
    .all<Record<string, unknown>>();
  return ((rows.results ?? []) as Array<Record<string, unknown>>)
    .map(toFairRow)
    .filter((r) => Number.isFinite(r.projectId));
}

/** The company's venue master — the list behind "Others". Owner 2026-09-13:
 *  *"dont let them write in manual, third option just pick others"*. Measured
 *  the same day: 92 rows for Houzs Century, covering every venue any 2026 fair
 *  uses, so this list is complete and nobody ever needs to type. */
export async function loadVenueMaster(
  db: FairDb,
  companySql: string,
): Promise<VenueMasterRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, name FROM project_venues
        WHERE active = 1 AND name IS NOT NULL AND trim(name) <> ''${companySql}
        ORDER BY name`,
    )
    .bind()
    .all<Record<string, unknown>>();
  return ((rows.results ?? []) as Array<Record<string, unknown>>)
    .map((r) => ({ id: String(r.id), name: String(r.name ?? '').trim() }))
    .filter((r) => r.id && r.name);
}

/**
 * Resolve a picked venue (+ optional organizer) and the order's own brand to ONE
 * project id, for the create / patch / reconcile paths.
 *
 * NEVER trusts a project id from the client. The picker sends a venue and an
 * organizer — what a person can see and verify — and the server re-derives which
 * BOOTH that is from the order's lines. A client-supplied project id would let a
 * stale dropdown attribute a sale to another company's fair, and `project_id`
 * has no company predicate of its own.
 *
 * Best-effort by contract: a lookup failure returns PENDING with no project,
 * never an exception. No fair-link problem may ever block a sale.
 */
export async function resolveFairForSave(args: {
  db: FairDb;
  companySql: string;
  venue: string | null;
  organizer: string | null;
  soDate: string;
  brand: string | null;
}): Promise<FairResolution> {
  const venue = (args.venue ?? '').trim();
  if (!venue) return { projectId: null, match: 'PENDING', candidateIds: [] };
  try {
    const candidates = await loadFairsAtVenue(args.db, args.companySql, venue, args.soDate);
    return resolveFair({
      candidates,
      soDate: args.soDate,
      brand: args.brand,
      organizer: args.organizer,
    });
  } catch {
    /* An unreadable projects table is NOT "there is no fair". PENDING says
       "unresolved, try again", which is what the reconcile job acts on; a
       silent UNMATCHED would be a verdict this never computed. */
    return { projectId: null, match: 'PENDING', candidateIds: [] };
  }
}

/**
 * The AUTOMATIC venue default at create time — the rule that predates the fair
 * picker and still runs underneath it: PMS assignment first, then the rep's
 * showroom, then nothing. Lifted verbatim out of `POST /mfg-sales-orders` (it
 * was 34 lines of inline block in a router that is already over its file-size
 * ceiling) so the create path and any future caller share one copy.
 *
 * It only ever OFFERS a venue: `venueName` is used when the request named none.
 * The picker's choice is a human decision and always wins — same rule as
 * `canAutoResolveVenue`, and the reason a picked venue is stamped MANUAL.
 *
 * Non-fatal by contract. Every failure path yields NOTHING, never a guess: venue
 * feeds exhibition P&L and commission, so a wrong venue is a wrong profit figure
 * paid to a real person. Empty is visibly incomplete; wrong is not.
 */
export async function bindVenueOnCreate(args: {
  db: VenueBindingDb;
  sb: VenueBindingSb;
  /** `public.users.id` of the salesperson the order is attributed to. */
  userId: number;
  /** `scm.staff.id` of that same person — the SALESPERSON, not necessarily the
   *  caller: an admin keying an order in for a showroom rep must stamp the
   *  REP's showroom. Null skips the showroom half. */
  staffId: string | null;
  /** The ORDER's date (`YYYY-MM-DD`, MYT), not today's — a backdated slip must
   *  resolve against the fair that was running the day it was written. */
  soDate: string;
}): Promise<{ projectId: number | null; venueName: string | null; source: VenueSource | null }> {
  if (!Number.isFinite(args.userId)) return { projectId: null, venueName: null, source: null };
  try {
    const { pmsCandidates, showroom } = await loadVenueBindingInputs({
      db: args.db, sb: args.sb, userId: args.userId, staffId: args.staffId,
    });
    const binding = resolveVenueBinding({ soDate: args.soDate, pmsCandidates, showroom });
    return {
      projectId: binding.projectId,
      venueName: binding.venueName,
      source: binding.source,
    };
  } catch {
    return { projectId: null, venueName: null, source: null };
  }
}
