import { Hono } from "hono";
import type { Env } from "../types";
import { requirePageAccess } from "../middleware/auth";
import { activeCompanySql } from "../scm/lib/companyScope";
import { calendarCrewScope } from "./lib/calendar-visibility";
import {
  CALENDAR_SEARCH_CAP,
  hasCalendarFilter,
  searchCalendarRows,
  type CalendarSearchRow,
} from "../services/calendarSearch";

/**
 * GET /api/projects/calendar/search?q=&brand=&status=&organizer=
 *
 * Every calendar event matching the calendar's search + filters, across ALL
 * dates, so the calendar can jump to the previous / next match and list them
 * (the month feed only returns the visible window).
 *
 * Same visibility as the month feed: projects.calendar page access, the active
 * company predicate, and the shared crew scoping (routes/lib/calendar-visibility).
 * Capped at CALENDAR_SEARCH_CAP rows; `total` and `truncated` tell the page so
 * it can say "showing first N" instead of cutting silently.
 *
 * Own router, mounted at the exact path BEFORE the projects router in index.ts
 * (whose `/:id` routes would otherwise see "calendar"), and kept out of the big
 * routes/projects.ts, which is at its size ceiling.
 */
const app = new Hono<{ Bindings: Env }>();

app.get("/", requirePageAccess("projects.calendar"), async (c) => {
  const filters = {
    q: (c.req.query("q") ?? "").slice(0, 200),
    brand: c.req.query("brand") ?? "",
    status: (c.req.query("status") ?? "").toLowerCase(),
    organizer: c.req.query("organizer") ?? "",
  };
  if (!hasCalendarFilter(filters)) {
    return c.json({ matches: [], total: 0, truncated: false, cap: CALENDAR_SEARCH_CAP });
  }

  const { scopeWhere, scopeBinds } = calendarCrewScope(c);
  const coSql = activeCompanySql(c, "p.company_id");
  // Text matching (incl. venue initials, "sccc") runs in JS on the narrow column
  // set below; brand / status / organizer are pushed into SQL to keep it small.
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filters.brand) {
    where.push(" AND p.brand = ?");
    binds.push(filters.brand);
  }
  if (filters.status) {
    where.push(" AND lower(COALESCE(p.status,'')) = ?");
    binds.push(filters.status);
  }
  if (filters.organizer) {
    where.push(" AND COALESCE(p.organizer,'') = ?");
    binds.push(filters.organizer);
  }
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.status, p.brand, p.organizer,
            p.start_date, p.end_date, p.venue, p.state,
            et.name AS event_type_name
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
      WHERE p.archived_at IS NULL
        AND p.start_date IS NOT NULL${where.join("")}${scopeWhere}${coSql}`
  )
    .bind(...binds, ...scopeBinds)
    .all<CalendarSearchRow>();

  const result = searchCalendarRows(rows.results, filters, CALENDAR_SEARCH_CAP);
  return c.json({ ...result, cap: CALENDAR_SEARCH_CAP });
});

export default app;
