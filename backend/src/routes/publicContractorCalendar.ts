// ----------------------------------------------------------------------------
// publicContractorCalendar — a contractor's confirmed event schedule, reachable
// WITHOUT A LOGIN.
//
//   GET /api/public/contractor-calendar/:token
//
// The unguessable token IS the credential (pattern: routes/publicDoScan.ts and
// mig 0126's kill switch). The contractor the link belongs to is read off the
// TOKEN ROW, never from the request, so a token can only ever see the one
// contractor's schedule it was minted for.
//
// MINIMISATION. Only the confirmed schedule leaves this route — brand, organizer,
// state, venue, booth, dates. No finance, no sales, no cost, no checklist, no
// notes, no ids that could open a detail page. The SELECT names its columns; it
// must never grow to `SELECT *` or spread a row. RLS is disabled prod-wide, so
// the WHERE clause IS the boundary: the read goes through `c.env.DB` (the
// d1-compat shim over Postgres via the connection-string role, not the anon
// PostgREST path), exactly like the authenticated project reads.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { resolveShareToken } from "../services/contractorShare";

export const publicContractorCalendar = new Hono<{ Bindings: Env }>();

// A share token is 24 random bytes as URL-safe base64 (32 chars). Nothing else
// can exist, so a junk probe costs a regex, never a database round trip.
const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;

const READ_MAX = 300;
const WINDOW_SEC = 900;

// The ONLY shape a contractor holding the link ever receives.
type ShareEvent = {
  brand: string | null;
  organizer: string | null;
  state: string | null;
  venue: string | null;
  boothNo: string | null;
  startDate: string | null;
  endDate: string | null;
  name: string | null;
};

type Row = {
  brand: string | null;
  organizer: string | null;
  state: string | null;
  venue: string | null;
  booth_no: string | null;
  start_date: string | null;
  end_date: string | null;
  name: string | null;
};

// One sentence for "no such token" AND "this token was killed": telling the
// holder of a leaked link that it USED to work is the single fact the kill
// switch exists to withhold, so both collapse to the same 404.
function unknownLink(c: Context<{ Bindings: Env }>) {
  return c.json(
    { error: "unknown_link", message: "This link is not valid. Please ask Houzs for a current link." },
    404
  );
}

publicContractorCalendar.get("/:token", async (c) => {
  const token = (c.req.param("token") ?? "").trim();
  // Shape gate first — before the limiter and any query.
  if (!TOKEN_RE.test(token)) return unknownLink(c);

  const limited = await checkRateLimit(c, "contractor_share_read", clientIp(c), READ_MAX, WINDOW_SEC);
  if (limited) return limited;

  const contractor = await resolveShareToken(c.env, token);
  if (!contractor) return unknownLink(c);

  // The contractor comes from the token, never the request. Confirmed + live
  // rows only. Whitelisted columns only.
  // company-scope: intentionally cross-company — a pre-auth public route has no session
  // and no companyContext, so there is no company value to scope by; the tenant boundary
  // is the unguessable token resolving to ONE contractor name (filtered below), and
  // only confirmed, non-archived, whitelisted columns leave the route. Verified 2026-09-04.
  const rows = await c.env.DB.prepare(
    `SELECT brand, organizer, state, venue, booth_no, start_date, end_date, name
       FROM projects
      WHERE contractor = ?
        AND lower(status) = 'confirmed'
        AND archived_at IS NULL
      ORDER BY start_date`
  )
    .bind(contractor)
    .all<Row>();

  const events: ShareEvent[] = rows.results.map((r) => ({
    brand: r.brand,
    organizer: r.organizer,
    state: r.state,
    venue: r.venue,
    boothNo: r.booth_no,
    startDate: r.start_date,
    endDate: r.end_date,
    name: r.name,
  }));

  return c.json({ contractor, events });
});
