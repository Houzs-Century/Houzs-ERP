// ----------------------------------------------------------------------------
// publicBrandCalendar — a BRAND's confirmed event schedule, reachable WITHOUT A
// LOGIN (owner 2026-09-08: "each brand gets a separate link — a brand only
// sees its OWN events; can view and download the display floorplan, and see
// Total Sales and Size; export to Excel with Total Sales").
//
//   GET /api/public/brand-calendar/:token
//   GET /api/public/brand-calendar/:token/events/:eventId
//   GET /api/public/brand-calendar/:token/events/:eventId/floorplan
//   GET /api/public/brand-calendar/:token/events/:eventId/floorplan/:fileId
//   GET /api/public/brand-calendar/:token/export?month=YYYY-MM
//
// Sibling of routes/publicContractorCalendar.ts over the same service
// (services/shareCalendar.ts). The unguessable token IS the credential
// (services/brandShare.ts); the brand is read off the TOKEN ROW, never the
// request, and every read re-applies `projects.brand = <that brand>` — so the
// AKEMI link answers 404 for a ZANOTTI event id and its export can only ever
// hold AKEMI rows. Money (total_sales) is read ONLY here, never on the
// contractor sibling, and every export writes a share_export_log row.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { resolveBrandShareToken } from "../services/brandShare";
import {
  MONTH_RE,
  TOKEN_RE,
  listPlanFiles,
  listShareEvents,
  listShareExportRows,
  logShareExport,
  readShareEventFigures,
  resolveShareEvent,
  streamPlanFile,
  type ShareScope,
} from "../services/shareCalendar";

export const publicBrandCalendar = new Hono<{ Bindings: Env }>();

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

/** Token shape gate, then the limiter, then the token row. */
async function gate(c: Ctx): Promise<{ token: string; scope: ShareScope } | Response> {
  const token = (c.req.param("token") ?? "").trim();
  if (!TOKEN_RE.test(token)) return unknownLink(c);
  const limited = await checkRateLimit(c, "brand_share_read", clientIp(c), READ_MAX, WINDOW_SEC);
  if (limited) return limited;
  const brand = await resolveBrandShareToken(c.env, token);
  if (!brand) return unknownLink(c);
  return { token, scope: { column: "brand", value: brand } };
}

async function gateEvent(c: Ctx): Promise<{ scope: ShareScope; projectId: number } | Response> {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const projectId = await resolveShareEvent(c.env, g.scope, c.req.param("eventId") ?? "");
  if (projectId === null) return unknownEvent(c);
  return { scope: g.scope, projectId };
}

publicBrandCalendar.get("/:token", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const events = await listShareEvents(c.env, g.scope);
  return c.json({ brand: g.scope.value, events });
});

// Size and total sales for one event — the brand's own figures.
publicBrandCalendar.get("/:token/events/:eventId", async (c) => {
  const g = await gateEvent(c);
  if (g instanceof Response) return g;
  const figures = await readShareEventFigures(c.env, g.scope, g.projectId);
  if (!figures) return unknownEvent(c);
  return c.json(figures);
});

// The DISPLAY floorplan files for one event (never the blank or filled ones).
publicBrandCalendar.get("/:token/events/:eventId/floorplan", async (c) => {
  const g = await gateEvent(c);
  if (g instanceof Response) return g;
  const files = await listPlanFiles(c.env, g.projectId, "display");
  return c.json({ files });
});

publicBrandCalendar.get("/:token/events/:eventId/floorplan/:fileId", async (c) => {
  const g = await gateEvent(c);
  if (g instanceof Response) return g;
  const res = await streamPlanFile(c.env, g.projectId, c.req.param("fileId") ?? "", "display", c.req.query("download") === "1");
  return res ?? c.json({ error: "not_found" }, 404);
});

// Export rows, WITH total sales, scoped server-side to the token's brand AND to
// the one month asked for (owner 2026-09-09: the export follows the month on
// screen); the browser builds the .xlsx. Every call is logged for accountability.
publicBrandCalendar.get("/:token/export", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const month = (c.req.query("month") ?? "").trim();
  if (!MONTH_RE.test(month)) return c.json({ error: "month_required", message: "Pick a month first." }, 400);
  const rows = await listShareExportRows(c.env, g.scope, true, month);
  await logShareExport(c.env, "brand", g.scope.value, g.token, clientIp(c), rows.length);
  return c.json({ brand: g.scope.value, generatedAt: new Date().toISOString(), rows });
});
