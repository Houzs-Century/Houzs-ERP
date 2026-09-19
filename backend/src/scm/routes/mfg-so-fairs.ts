// ----------------------------------------------------------------------------
// mfg-so-fairs — the SO fair picker's three endpoints.
//
// Mounted at /mfg-sales-orders BEFORE the main router so `/fair-options` is not
// swallowed by its `/:docNo`. It lives in its own file rather than in
// mfg-sales-orders.ts because that file is already OVER its recorded file-size
// ceiling, so anything that grows it is charged by the ratchet. Moving
// `/active-venue` here is what paid for the new endpoints.
//
// WHAT THIS IS FOR (owner, 2026-09-13). Until now a sales order recorded its
// exhibition as free text and nothing else, so none of Houzs Century's 2,946
// orders could say which FAIR it was written at. The picker replaces that field
// with a list of real events — one row per place + organizer — and the server
// re-derives the brand booth from the order's own lines. There is no free-text
// venue anywhere in the flow: *"dont let them write in manual, third option just
// pick others"*, and Others is a second PICK from the company's venue master.
//
//   GET  /fair-options          the dropdown, for one order date
//   GET  /fair-pending          orders whose fair link still needs a person
//   POST /:docNo/fair           a person settles one of them
//   GET  /active-venue          the rep's bound venue (moved here, unchanged)
//
// The RULE is in scm/lib/fair-options.ts (pure, tested); the SQL is in
// scm/lib/fair-binding.ts. This file only wires them to HTTP.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanySql, scopeToCompany, activeCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import {
  loadFairsInWindow,
  loadFairsAtVenue,
  loadVenueMaster,
  type FairDb,
} from '../lib/fair-binding';
import { buildFairOptions, isPickableFair } from '../lib/fair-options';
/* GET /active-venue moved here from mfg-sales-orders.ts on 2026-09-13. It is the
   same concern as the picker — which exhibition is this rep at — and that file
   is over its size ceiling, so the endpoint could not stay beside its new
   siblings AND leave room for them. Behaviour is unchanged; the mount order in
   scm/index.ts keeps it ahead of `/:docNo` exactly as before. */
import {
  resolveVenueBinding,
  loadVenueBindingInputs,
  type VenueBindingSb,
} from '../lib/venue-binding';
import { resolveCallerStaffId } from '../lib/salesScope';
import type { Env, Variables } from '../env';

export const mfgSoFairs = new Hono<{ Bindings: Env; Variables: Variables }>();

mfgSoFairs.use('*', supabaseAuth);

/** The order's own date when the form supplies one — a backdated slip must offer
 *  the fair that was running the day it was written — else today in MYT, never
 *  the UTC date, which is yesterday until 08:00 local. */
function orderDate(raw: string | undefined): string {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : todayMyt();
}

/**
 * GET /mfg-sales-orders/fair-options?date=YYYY-MM-DD
 *
 * `running` is where the rep almost certainly is; the client pre-selects the
 * first one. `month` is the rest of the same calendar month. `venues` is the
 * Others list.
 *
 * Answers 200 with empty lists on any failure rather than an error status. A
 * broken picker must degrade to "nothing to offer" — which the operator can
 * still get past via Others — and never to a screen that cannot take an order.
 */
mfgSoFairs.get('/fair-options', async (c) => {
  const soDate = orderDate(c.req.query('date'));
  const empty = { date: soDate, running: [], earlier: [], venues: [] };
  try {
    const db = c.env.DB as unknown as FairDb;
    /* Company scope is the ENTIRE tenant boundary on both reads: the fair list
       names other companies' venues and organizers, and the venue master is the
       same list the 2026-08-20 sweep found leaking across companies. */
    const [fairs, venues] = await Promise.all([
      loadFairsInWindow(db, activeCompanySql(c, 'p.company_id'), soDate),
      loadVenueMaster(db, activeCompanySql(c)),
    ]);
    const groups = buildFairOptions(fairs, soDate);
    return c.json({ date: soDate, running: groups.running, earlier: groups.earlier, venues });
  } catch {
    return c.json(empty);
  }
});

/* What the pending screen shows. Every value here is already on the order — this
   endpoint joins nothing and computes nothing, so it cannot disagree with the
   list view about an order's state. */
const PENDING_COLUMNS =
  'doc_no, so_date, venue, branding, project_id, fair_match, status, local_total_sen, salesperson_id';

const NEEDS_A_PERSON = ['PENDING', 'AMBIGUOUS', 'UNMATCHED'];

/**
 * GET /mfg-sales-orders/fair-pending?limit=200
 *
 * The orders the reconcile job could not settle on its own. Three different
 * reasons live here and the screen must keep them apart — see the `fair_match`
 * column comment (mig 20260913T1900):
 *
 *   PENDING    the fair is not in PMS yet. Usually resolves itself when it is.
 *   AMBIGUOUS  two booths fit. Only a person knows which.
 *   UNMATCHED  the order's brand has no booth at that event. Usually a missing
 *              brand on the SKU rather than a wrong venue.
 *
 * NULL `fair_match` is deliberately NOT in this list: those are the 2,946 orders
 * that predate the picker, and dumping them here would bury the handful that
 * actually need attention under three years of history.
 */
mfgSoFairs.get('/fair-pending', async (c) => {
  const sb = c.get('supabase');
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
  try {
    const { data, error } = await scopeToCompany(
      sb
        .from('mfg_sales_orders')
        .select(PENDING_COLUMNS)
        .in('fair_match', NEEDS_A_PERSON)
        .order('so_date', { ascending: false })
        .limit(limit),
      c,
    );
    if (error) return c.json({ error: 'fair_pending_read_failed', rows: [] }, 500);
    return c.json({ rows: data });
  } catch {
    return c.json({ error: 'fair_pending_read_failed', rows: [] }, 500);
  }
});

/**
 * POST /mfg-sales-orders/:docNo/fair   { projectId: number | null }
 *
 * A person settles one order. `projectId: null` clears the link and leaves the
 * order in the pending list — "I do not know either" is a legitimate answer and
 * must not be expressible only by picking a wrong fair.
 *
 * The id IS validated here even though a person chose it: it must belong to this
 * company and its period must contain the order's date. `project_id` carries no
 * company predicate of its own, so this check is the only thing standing between
 * a stale screen and a sale attributed to the other company's exhibition.
 */
mfgSoFairs.post('/:docNo/fair', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  let body: { projectId?: unknown };
  try {
    body = (await c.req.json()) as { projectId?: unknown };
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }

  const raw = body.projectId;
  const projectId = raw == null ? null : Number(raw);
  if (projectId != null && !Number.isInteger(projectId)) {
    return c.json({ error: 'bad_project_id' }, 400);
  }

  /* The order first — its own so_date is what the project's period is tested
     against, and reading it under the company predicate also answers "is this
     order mine" before anything is written. */
  const { data: so, error: soErr } = await scopeToCompany(
    sb.from('mfg_sales_orders').select('doc_no, so_date, venue').eq('doc_no', docNo),
    c,
  ).maybeSingle();
  if (soErr) return c.json({ error: 'so_read_failed' }, 500);
  if (!so) return c.json({ error: 'not_found' }, 404);

  const soDate = String((so as Record<string, unknown>).so_date ?? '').slice(0, 10) || todayMyt();

  if (projectId != null) {
    const rows = await c.env.DB.prepare(
      `SELECT p.id AS id, p.venue AS venue, p.organizer AS organizer, p.brand AS brand,
              p.start_date AS startdate, p.end_date AS enddate, p.status AS status
         FROM projects p
        WHERE p.id = ?${activeCompanySql(c, 'p.company_id')}`,
    )
      .bind(projectId)
      .all<Record<string, unknown>>();
    const row = rows.results[0] as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: 'fair_not_found' }, 404);
    const fair = {
      projectId,
      venue: (row.venue as string | null) ?? null,
      organizer: (row.organizer as string | null) ?? null,
      brand: (row.brand as string | null) ?? null,
      startDate: ((row.startdate ?? row.start_date) as string | null) ?? null,
      endDate: ((row.enddate ?? row.end_date) as string | null) ?? null,
      status: (row.status as string | null) ?? null,
    };
    if (!isPickableFair(fair)) return c.json({ error: 'fair_cancelled_or_incomplete' }, 409);
    /* THE "WAS IT RUNNING THAT DAY" REFUSAL IS GONE (owner 2026-09-19).
       It used to answer 409 `fair_not_running_on_so_date` here. The intent was
       right — an order attributed to a fair that was not on is invisible once
       written — but the rule was enforced against the wrong date. `so_date` is
       the day the order was KEYED, and the New Sales Order form has no date
       field at all, so it is always the day of keying. The owner writes orders
       up after the fact — *"我可能是下个星期，才开给上个星期 event 的 sales
       order"* — which made this screen refuse every one of them. A person
       settling a fair link BY HAND, on a screen that exists for nothing else,
       was told no because a date the form never let them set disagreed.
       The period is now part of the pick rather than a veto over it: the row
       names its event, and an order dated outside that event's run is still
       recorded against it. Such an order stays visible — `so_date` against the
       project's own start/end says so at any time, with no flag to keep in
       step — so a report can find them without this route having to guess. */
  }

  const { error: updErr } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .update({
        project_id: projectId,
        fair_match: projectId == null ? 'AMBIGUOUS' : 'PICKED',
      })
      .eq('doc_no', docNo),
    c,
  );
  if (updErr) return c.json({ error: 'fair_update_failed' }, 500);

  return c.json({ ok: true, docNo, projectId, companyId: activeCompanyId(c) ?? null });
});
// Houzs — resolve the venue the logged-in salesperson is BOUND to on a given
// date, so the New-SO / OCR form (desktop AND mobile) can pre-select it in the
// Venue dropdown. MUST be registered BEFORE "/:docNo" (single-segment static
// path, else Hono treats "active-venue" as a docNo).
//
// The rule itself lives in lib/venue-binding.ts and is shared with the SO create
// path — this endpoint only fetches, calls it, and maps the venue NAME onto the
// project_venues master id the dropdown compares against. The route name is
// kept as "active-venue" (rather than renamed to match the resolver) because the
// desktop form, the mobile form and the vendored SCM client all call this exact
// path; the concept it returns is now "the rep's bound venue", of which the
// active exhibition is one of two sources.
//
// ZERO PMS DATA IS THE NORMAL CASE: showroom parking is the primary binding, and
// a rep on no projects at all must still get their showroom's venue back here.
// Nothing on this path warns, errors or degrades because no project has a team.
//
// venueId is null when the resolved venue text isn't in the project_venues
// master — a KNOWN and tolerated gap (projects reference ~60 distinct venues,
// the master holds ~38). The form stamps the text anyway and hints that it is
// unmastered; it does NOT reject the order. Rejecting unmastered venues would
// block real sales to enforce a list nobody has finished filling in.
mfgSoFairs.get('/active-venue', async (c) => {
  const hu = c.get('houzsUser');
  const uid = hu?.id != null ? Number(hu.id) : NaN;
  const dateRaw = c.req.query('date');
  /* The ORDER's date when the form supplies one (a backdated slip must resolve
     against the fair that was running the day it was written), else today in
     MYT — never the UTC date, which is yesterday until 08:00 local. */
  const soDate =
    typeof dateRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateRaw)
      ? dateRaw.slice(0, 10)
      : todayMyt();
  const EMPTY = {
    venueId: null, venueName: null, projectName: null,
    source: null, projectId: null, showroomName: null,
  };
  if (!Number.isFinite(uid)) return c.json(EMPTY);
  try {
    const sb = c.get('supabase');
    const staffId = await resolveCallerStaffId(sb, uid);
    const { pmsCandidates, showroom } = await loadVenueBindingInputs({
      db: c.env.DB, sb: sb as unknown as VenueBindingSb, userId: uid, staffId,
    });
    const binding = resolveVenueBinding({ soDate, pmsCandidates, showroom });
    if (!binding.venueName) return c.json(EMPTY);

    /* Map the resolved venue TEXT onto the project_venues master id, so the
       dropdown can SELECT the row rather than only display the text. Lives here
       and not in the resolver because it is a presentation concern — the venue
       that gets stamped is the text either way. */
    let venueId: string | null = null;
    try {
      /* Company-scoped (mig 0093): venue NAMES are not unique across the two
         masters, so an unscoped match hands this company the OTHER company's
         venue id — and that id is what the SO stores. See projects-pms.md. */
      const row = await c.env.DB.prepare(
        `SELECT id FROM project_venues
          WHERE lower(trim(name)) = lower(trim(?)) AND active = 1${activeCompanySql(c)} LIMIT 1`,
      )
        .bind(binding.venueName)
        .first<{ id?: number | null }>();
      venueId = row?.id != null ? String(row.id) : null;
    } catch {
      venueId = null; // unmastered venue — the text still stands
    }
    return c.json({
      venueId,
      venueName: binding.venueName,
      projectName: binding.projectName,
      projectId: binding.projectId,
      source: binding.source,
      showroomName: showroom && binding.source === 'SHOWROOM' ? showroom.warehouseName : null,
    });
  } catch {
    return c.json(EMPTY);
  }
});


