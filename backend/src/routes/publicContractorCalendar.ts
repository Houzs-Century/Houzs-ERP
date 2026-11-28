import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
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

function unknownLink(c: Ctx) {
  return c.json(
    { error: "unknown_link", message: "This link is not valid. Please ask Houzs for a current link." },
    404
  );
}

function unknownEvent(c: Ctx) {
  return c.json({ error: "unknown_event", message: "This event is not on your schedule." }, 404);
}

async function gate(c: Ctx): Promise<{ token: string; scope: ShareScope } | Response> {
  const token = (c.req.param("token") ?? "").trim();
  if (!TOKEN_RE.test(token)) return unknownLink(c);

  const limited = await checkRateLimit(c, "contractor_share_read", clientIp(c), READ_MAX, WINDOW_SEC);
  if (limited) return limited;

  const contractor = await resolveShareToken(c.env, token);
  if (!contractor) return unknownLink(c);
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

publicContractorCalendar.get("/:token/events/:eventId", async (c) => {
  const g = await gateEvent(c);
  if (g instanceof Response) return g;
  const size = await readShareEventSize(c.env, g.scope, g.projectId);
  if (!size) return unknownEvent(c);
  return c.json(size);
});

publicContractorCalendar.get("/:token/events/:eventId/floorplan", async (c) => {
  const g = await gateEvent(c);
  if (g instanceof Response) return g;
  const files = await listPlanFiles(c.env, g.projectId, "blank");
  return c.json({ files });
});

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
  const w = exportWindowFromQuery(c.req.query("month"), c.req.query("year"));
  if ("error" in w) return c.json({ error: "bad_window", message: w.error }, 400);
  const rows = await listShareExportRows(c.env, g.scope, false, w.window);
  await logShareExport(c.env, "contractor", g.scope.value, g.token, clientIp(c), rows.length);
  return c.json({ contractor: g.scope.value, generatedAt: new Date().toISOString(), rows });
});
