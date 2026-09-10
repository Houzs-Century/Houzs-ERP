// ----------------------------------------------------------------------------
// publicContractorCalendar — a contractor's confirmed event schedule, reachable
// WITHOUT A LOGIN.
//
//   GET /api/public/contractor-calendar/:token
//   GET /api/public/contractor-calendar/:token/events/:eventId
//   GET /api/public/contractor-calendar/:token/events/:eventId/floorplan
//   GET /api/public/contractor-calendar/:token/events/:eventId/floorplan/:fileId
//   GET /api/public/contractor-calendar/:token/export?month=YYYY-MM   (or ?year=YYYY)
//
// The unguessable token IS the credential (pattern: routes/publicDoScan.ts and
// mig 0126's kill switch). The contractor the link belongs to is read off the
// TOKEN ROW, never from the request, so a token can only ever see the one
// contractor's schedule it was minted for. The reads live in
// services/shareCalendar.ts, shared with the brand sibling
// (routes/publicBrandCalendar.ts); every one re-applies the token's contractor.
//
// MINIMISATION. Only the confirmed schedule leaves this route — brand, organizer,
// state, venue, booth, dates — plus, per event, the UNFILLED floorplan (owner
// 2026-09-08: "only appear unfilled floorplan inside, others hide from
// contractor, and allowed them to view and download"), and an Excel export of
// Date / Venue / State / Organizer / Brand / Type / Booth / Size. No finance, no sales, no cost, no
// checklist, no notes, no other file: this route never reads project_finance.
// RLS is disabled prod-wide, so the WHERE clause IS the boundary.
//
// The `eventId` in the list is the project id. It opens nothing on its own: the
// per-event routes re-check `id = ? AND contractor = <token's contractor>` on
// every call, so an id from another contractor's project answers 404 here.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { bumpRateLimit, clientIp, rateLimitExceeded } from "../middleware/rateLimit";
import { resolveShareToken } from "../services/contractorShare";
import {
  TOKEN_RE,
  exportWindowFromQuery,
  listPlanFiles,
  listShareEvents,
  listShareExportRows,
  logShareExport,
  readContractorExportScope,
  readShareEventSize,
  resolveShareEvent,
  streamPlanFile,
  type ShareScope,
} from "../services/shareCalendar";

export const publicContractorCalendar = new Hono<{ Bindings: Env }>();

const READ_MAX = 300;
const WINDOW_SEC = 900;

type Ctx = Context<{ Bindings: Env }>;

// One sentence for "no such token" AND "this token was killed": telling the
// holder of a leaked link that it USED to work is the single fact the kill
// switch exists to withhold, so both collapse to the same 404.
function unknownLink(c: Ctx) {
  return c.json(
    { error: "unknown_link", message: "This link is not valid. Please ask Houzs for a current link." },
    404
  );
}

function unknownEvent(c: Ctx) {
  return c.json({ error: "unknown_event", message: "This event is not on your schedule." }, 404);
}

/** Token shape gate, then the limiter, then the token row. Every route here
 *  starts the same way; a Response means "stop and return this". */
async function gate(c: Ctx): Promise<{ token: string; scope: ShareScope } | Response> {
  const token = (c.req.param("token") ?? "").trim();
  // Shape gate first — before the limiter and any query.
  if (!TOKEN_RE.test(token)) return unknownLink(c);

  // The cap is a guess counter: a request that carries a VALID link never
  // counts, or an office's own polling tabs lock its links out (docs/bugs/0757).
  const ip = clientIp(c);
  const limited = await rateLimitExceeded(c, "contractor_share_read", ip, READ_MAX, WINDOW_SEC);
  if (limited) return limited;

  const contractor = await resolveShareToken(c.env, token);
  if (!contractor) {
    await bumpRateLimit(c, "contractor_share_read", ip, WINDOW_SEC);
    return unknownLink(c);
  }
  return { token, scope: { column: "contractor", value: contractor } };
}

async function gateEvent(c: Ctx): Promise<{ scope: ShareScope; projectId: number } | Response> {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const projectId = await resolveShareEvent(c.env, g.scope, c.req.param("eventId") ?? "");
  if (projectId === null) return unknownEvent(c);
  return { scope: g.scope, projectId };
}

// `exportScope` tells the page what one press of Export covers for THIS
// contractor — the month on screen, or the whole year (a Project Maintenance
// setting; owner 2026-09-09).
publicContractorCalendar.get("/:token", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const [events, exportScope] = await Promise.all([listShareEvents(c.env, g.scope), readContractorExportScope(c.env, g.scope.value)]);
  return c.json({ contractor: g.scope.value, exportScope, events });
});

// The event's SIZE, and nothing else — no money, ever, on this route (owner
// 2026-09-09: "size not in here. please add also").
publicContractorCalendar.get("/:token/events/:eventId", async (c) => {
  const g = await gateEvent(c);
  if (g instanceof Response) return g;
  const size = await readShareEventSize(c.env, g.scope, g.projectId);
  if (!size) return unknownEvent(c);
  return c.json(size);
});

// The UNFILLED floorplan files for one event on this contractor's schedule —
// the "Blank Floorplan" task's, with the legacy project-level fallback. The
// Display Floor Plan and the Filled Floorplan are deliberately NOT here.
publicContractorCalendar.get("/:token/events/:eventId/floorplan", async (c) => {
  const g = await gateEvent(c);
  if (g instanceof Response) return g;
  const files = await listPlanFiles(c.env, g.projectId, "blank");
  return c.json({ files });
});

// Stream one of those files. `?download=1` answers as an attachment so the
// browser saves it; otherwise inline so an image or PDF opens in the tab.
publicContractorCalendar.get("/:token/events/:eventId/floorplan/:fileId", async (c) => {
  const g = await gateEvent(c);
  if (g instanceof Response) return g;
  const res = await streamPlanFile(c.env, g.projectId, c.req.param("fileId") ?? "", "blank", c.req.query("download") === "1");
  return res ?? c.json({ error: "not_found" }, 404);
});

// Export rows — Date / Venue / State / Organizer / Brand / Type / Booth / Size,
// NEVER sales — scoped server-side to the token's contractor AND to the one
// month asked for (owner 2026-09-09: the export follows the month on screen);
// the browser builds the .xlsx. Logged like the brand export so the office can
// see who pulled what, when.
publicContractorCalendar.get("/:token/export", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  // ?month= (the month on screen) or ?year= (the whole year, for the contractors
  // whose master row says so); neither = the whole schedule, what a page loaded
  // before the month rule shipped still sends until it reloads.
  const w = exportWindowFromQuery(c.req.query("month"), c.req.query("year"));
  if ("error" in w) return c.json({ error: "bad_window", message: w.error }, 400);
  const rows = await listShareExportRows(c.env, g.scope, false, w.window);
  await logShareExport(c.env, "contractor", g.scope.value, g.token, clientIp(c), rows.length);
  return c.json({ contractor: g.scope.value, generatedAt: new Date().toISOString(), rows });
});
