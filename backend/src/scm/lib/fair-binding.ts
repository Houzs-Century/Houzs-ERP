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
  lookbackWindow,
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
    eventType: str(r, 'eventtype', 'eventType', 'event_type'),
  };
}

/* Cancelled fairs are excluded in SQL as well as in the pure filter. Not
   redundant: it keeps the row set small on a table with 924 Houzs Century
   projects, and `isPickableFair` stays the single authority on the decision. */
const FAIR_COLUMNS =
  'p.id AS id, p.venue AS venue, p.organizer AS organizer, p.brand AS brand, ' +
  'p.start_date AS startdate, p.end_date AS enddate, p.status AS status, ' +
  /* The event type decides the picker LABEL only (a solo roadshow reads "SOLO"). */
  '(SELECT et.slug FROM project_event_types et WHERE et.id = p.event_type_id) AS eventtype';

/* ARCHIVED IS NOT PICKABLE (owner 2026-09-19).
   An archived project is one the office has withdrawn — pulled out of the fair,
   or a duplicate row someone closed. Every OTHER reader of `projects` in this
   system already drops them: the projects list, the Projects calendar, the
   brand/contractor share calendars, project P&L, inbox, search, finance and
   delivery planning all carry `archived_at IS NULL`. This module and
   venue-binding.ts were the only two that did not, and the bill arrived as
   `PAVILION BUKIT JALIL — MEGAHOME` sitting under "Running now" on the New
   Sales Order form while the calendar showed nothing: project 359, archived
   2026-08-03, six weeks before the event it describes was due to open.
   Measured the same day (probe-fair-picker-vs-calendar, run 35432690927):
   2 of the 7 rows the picker called "Running now" were archived, and 155 of
   Houzs Century's 924 projects are archived. An archived fair must never take
   a new sale — its revenue lands in a project the P&L excludes by definition,
   so the money silently disappears from exhibition reporting. */
const LIVE_FAIR = `p.venue IS NOT NULL AND trim(p.venue) <> ''
     AND p.start_date IS NOT NULL
     AND p.archived_at IS NULL
     AND lower(coalesce(p.status, '')) <> 'cancelled'`;

/* The window itself is a RULE, so it lives in the pure module beside the one
   that groups the rows — importing it keeps the SQL and the grouping working
   from one definition instead of two that can drift apart. */

/**
 * Every fair that could appear in the picker for one order date: anything that
 * OVERLAPS the lookback window, which ends at the order date itself.
 *
 * The overlap is the whole predicate — a fair qualifies when it started on or
 * before the window's end and had not finished before its start. `p.start_date
 * <= end` is also what keeps FUTURE fairs out, so "no fairs that have not
 * happened yet" needs no second rule to forget.
 *
 * `coalesce(p.end_date, p.start_date)` reads a blank end date as a ONE-DAY
 * event, which is what `GET /api/projects/calendar/events` has always done
 * (routes/projects.ts). The picker used to read it as "never ends" and so kept
 * such a fair under "Running now" for ever while the calendar drew nothing —
 * the same two-surfaces-two-answers fault as the archived one above. Houzs
 * Century has 0 such rows today (probe run 35432690927), so this closes a trap
 * rather than changing a number.
 *
 * @param companySql A ready-to-interpolate ` AND p.company_id = N` fragment from
 *   `activeCompanySql(c, 'p.company_id')`. It is the ENTIRE tenant boundary here
 *   — the fair list names other companies' venues and organizers, which is
 *   exactly the leak the 2026-08-20 venue sweep closed.
 */
export async function loadFairsInWindow(
  db: FairDb,
  companySql: string,
  soDate: string,
): Promise<FairProjectRow[]> {
  const { start, end } = lookbackWindow(soDate);
  const rows = await db
    .prepare(
      `SELECT ${FAIR_COLUMNS}
         FROM projects p
        WHERE ${LIVE_FAIR}
          AND p.start_date <= ?
          AND coalesce(p.end_date, p.start_date) >= ?${companySql}`,
    )
    .bind(end, start)
    .all<Record<string, unknown>>();
  return ((rows.results ?? []) as Array<Record<string, unknown>>)
    .map(toFairRow)
    .filter((r) => Number.isFinite(r.projectId));
}

/**
 * Every fair at ONE venue inside the lookback window. The venue match is
 * case/space-insensitive because the picker writes the master's spelling but
 * historical rows and PMS rows were typed by hand.
 *
 * This is the VENUE-ONLY path: the operator came through "Others" and named a
 * place but no event, or the nightly reconcile is retrying an order that has
 * only a place recorded. It used to demand that the fair's period CONTAIN the
 * order date, which made every order written after its fair closed permanently
 * unresolvable — by this path, by the reconcile that retries it, and by the
 * person trying to settle it by hand. The window is the same one the dropdown
 * offers, so what a person can see is what the server can resolve.
 *
 * When the operator DID pick an event, use `loadFairsForEvent` — their answer
 * is more precise than anything re-derived from a date.
 */
export async function loadFairsAtVenue(
  db: FairDb,
  companySql: string,
  venue: string,
  soDate: string,
): Promise<FairProjectRow[]> {
  const { start, end } = lookbackWindow(soDate);
  const rows = await db
    .prepare(
      `SELECT ${FAIR_COLUMNS}
         FROM projects p
        WHERE ${LIVE_FAIR}
          AND lower(trim(p.venue)) = lower(trim(?))
          AND p.start_date <= ?
          AND coalesce(p.end_date, p.start_date) >= ?${companySql}`,
    )
    .bind(venue, end, start)
    .all<Record<string, unknown>>();
  return ((rows.results ?? []) as Array<Record<string, unknown>>)
    .map(toFairRow)
    .filter((r) => Number.isFinite(r.projectId));
}

/**
 * The booths of ONE event, addressed exactly as the operator picked it: venue,
 * organizer and period. Every brand booth at that event comes back; which one
 * the order belongs to is still decided from the order's own lines.
 *
 * ── WHY THIS EXISTS (owner 2026-09-19) ──────────────────────────────────────
 * *"我在 10 号开单，然后我需要点 1 号的 event… 基本上你就可以记录到它是那个 event
 * 的 sales 了，这样子不能吗?"* — and it could not, because the server threw the
 * answer away. The dropdown row carries venue + organizer + period, the client
 * sent only the first two, and the server then re-derived the event from
 * (venue, organizer, TODAY). A fair that had closed matched nothing, so a
 * deliberate, correct human pick was recorded as PENDING and no later pass
 * could recover it.
 *
 * THE PICK IS THE ANSWER, NOT A HINT. This module's sibling already states the
 * rule for the venue default — *"The picker's choice is a human decision and
 * always wins"* (venue-binding.ts) — and the fair half simply did not honour
 * it. The period travels with the pick and is matched, not re-inferred.
 *
 * STILL NEVER TRUSTS A PROJECT ID FROM THE CLIENT. The identity matched here is
 * the four things a person can SEE on the row and verify; the company predicate
 * is applied on top, which is the whole reason a client-supplied id was refused
 * in the first place. `project_id` carries no company predicate of its own.
 */
export async function loadFairsForEvent(
  db: FairDb,
  companySql: string,
  event: { venue: string; organizer: string; startDate: string; endDate: string | null },
): Promise<FairProjectRow[]> {
  const rows = await db
    .prepare(
      `SELECT ${FAIR_COLUMNS}
         FROM projects p
        WHERE ${LIVE_FAIR}
          AND lower(trim(p.venue)) = lower(trim(?))
          AND lower(trim(coalesce(p.organizer, ''))) = lower(trim(?))
          AND p.start_date = ?
          AND coalesce(p.end_date, '') = coalesce(?, '')${companySql}`,
    )
    .bind(event.venue, event.organizer, event.startDate, event.endDate)
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
  /** The PICKED row's period. Present whenever the operator chose an EVENT from
   *  the dropdown, absent when they came through "Others" and named a place
   *  only, or when the nightly reconcile is retrying a place-only order.
   *  REQUIRED rather than optional on purpose: its absence changes which path
   *  resolves the order, and an optional argument whose absence changes the
   *  answer is the bug class this repo keeps paying for. Pass null explicitly. */
  picked: { startDate: string; endDate: string | null } | null;
  soDate: string;
  brand: string | null;
}): Promise<FairResolution> {
  const venue = (args.venue ?? '').trim();
  if (!venue) return { projectId: null, match: 'PENDING', candidateIds: [] };
  const organizer = (args.organizer ?? '').trim();
  try {
    /* An EVENT was picked: match it exactly. A PLACE only: fall back to the
       window at that venue, where the date is all there is to go on. */
    const candidates =
      args.picked && organizer
        ? await loadFairsForEvent(args.db, args.companySql, {
            venue,
            organizer,
            startDate: args.picked.startDate,
            endDate: args.picked.endDate,
          })
        : await loadFairsAtVenue(args.db, args.companySql, venue, args.soDate);
    return resolveFair({
      candidates,
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
