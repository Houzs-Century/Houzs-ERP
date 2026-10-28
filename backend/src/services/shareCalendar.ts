// ----------------------------------------------------------------------------
// shareCalendar — the reads behind the public, no-login calendar share links
// (routes/publicContractorCalendar.ts and routes/publicBrandCalendar.ts).
//
// Both links show ONE party's confirmed events. The party is a SCOPE: a column
// of `projects` (`contractor` or `brand`) and the value the token row resolved
// to. Every read here takes that scope and re-applies it — the list, the
// single-event resolve, the floorplan files, the export rows — because RLS is
// off prod-wide and the WHERE clause IS the boundary. The value comes off the
// token row, never the request; the column is a two-member union, never a
// string, so it cannot be injected.
//
// MINIMISATION. Whitelisted columns only; no `SELECT *`, no row spread. What
// each party may see is decided by the ROUTE that calls these (a contractor
// gets the blank floorplan and no money; a brand gets the display floorplan,
// its own size and total sales), never by a flag the browser sends.
// ----------------------------------------------------------------------------
import type { Env } from "../types";

export type ShareScope = { column: "contractor" | "brand"; value: string };

// A share token is 24 random bytes as URL-safe base64 (32 chars). Nothing else
// can exist, so a junk probe costs a regex, never a database round trip.
export const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;

// File ids are namespaced by the table they came from — `t<id>` for a
// checklist-task attachment, `l<id>` for a legacy project-level one — so the
// stream route knows which row to read the R2 key from. The key itself never
// travels to the browser.
export const FILE_ID_RE = /^[tl][1-9][0-9]{0,11}$/;
const EVENT_ID_RE = /^[1-9][0-9]{0,11}$/;

/** The ONLY event shape a link holder receives. */
export type ShareEvent = {
  eventId: number;
  brand: string | null;
  organizer: string | null;
  state: string | null;
  venue: string | null;
  boothNo: string | null;
  startDate: string | null;
  endDate: string | null;
  name: string | null;
};

type EventRow = {
  id: number;
  brand: string | null;
  organizer: string | null;
  state: string | null;
  venue: string | null;
  booth_no: string | null;
  start_date: string | null;
  end_date: string | null;
  name: string | null;
};

/** One floorplan file, as the link holder sees it. No key, no uploader. */
export type ShareFile = {
  fileId: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number | null;
};

type FileRow = {
  id: number;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
};

type KeyRow = { r2_key: string; file_name: string | null; content_type: string | null };

/** Which checklist task's files a link may see. `blank` = the UNFILLED
 *  floorplan (contractor); `display` = the Display Floor Plan (brand). */
export type PlanKind = "blank" | "display";

// Titles carry owner-added suffixes and both "Floor Plan" / "Floorplan"
// spellings, so the match strips spaces first — the same rule the mobile Floor
// Plans card uses (MobilePMS.tsx `taskPlanAtts(/^blank\s*floor\s*plan/i)`).
const PLAN_TITLE_LIKE: Record<PlanKind, string> = {
  blank: "blankfloorplan%",
  display: "displayfloorplan%",
};

const LIVE = `lower(status) = 'confirmed' AND archived_at IS NULL`;

/** The party's confirmed, live events, oldest first. */
export async function listShareEvents(env: Env, scope: ShareScope): Promise<ShareEvent[]> {
  // company-scope: intentionally cross-company — a pre-auth public route has no
  // session and no companyContext; the tenant boundary is the token's party
  // (`scope`), and only confirmed, non-archived, whitelisted columns leave.
  const rows = await env.DB.prepare(
    `SELECT id, brand, organizer, state, venue, booth_no, start_date, end_date, name
       FROM projects
      WHERE ${scope.column} = ?
        AND ${LIVE}
      ORDER BY start_date`
  )
    .bind(scope.value)
    .all<EventRow>();
  return rows.results.map((r) => ({
    eventId: r.id,
    brand: r.brand,
    organizer: r.organizer,
    state: r.state,
    venue: r.venue,
    boothNo: r.booth_no,
    startDate: r.start_date,
    endDate: r.end_date,
    name: r.name,
  }));
}

/** The event must be ON THIS PARTY'S confirmed schedule — the list predicate,
 *  narrowed to one id. Anyone else's, unconfirmed or archived: null. */
export async function resolveShareEvent(env: Env, scope: ShareScope, rawId: string): Promise<number | null> {
  if (!EVENT_ID_RE.test(rawId)) return null;
  // company-scope: intentionally cross-company — see listShareEvents.
  const row = await env.DB.prepare(
    `SELECT id
       FROM projects
      WHERE id = ?
        AND ${scope.column} = ?
        AND ${LIVE}`
  )
    .bind(Number(rawId), scope.value)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** Size and total sales for ONE event on the party's schedule. Only the brand
 *  route calls this — a contractor link never reads money. */
/** Size only — what a CONTRACTOR may see of an event's figures (owner
 *  2026-09-09, on the panel: "size not in here. please add also"). Reads
 *  projects alone; project_finance is never touched on the contractor side. */
export async function readShareEventSize(env: Env, scope: ShareScope, projectId: number): Promise<{ sizeSqm: number | null } | null> {
  // company-scope: intentionally cross-company — see listShareEvents.
  const row = await env.DB.prepare(
    `SELECT size_sqm
       FROM projects
      WHERE id = ?
        AND ${scope.column} = ?
        AND ${LIVE}`
  )
    .bind(projectId, scope.value)
    .first<{ size_sqm: number | null }>();
  return row ? { sizeSqm: row.size_sqm } : null;
}

export async function readShareEventFigures(
  env: Env,
  scope: ShareScope,
  projectId: number,
): Promise<{ sizeSqm: number | null; totalSales: number | null } | null> {
  // company-scope: intentionally cross-company — see listShareEvents.
  const row = await env.DB.prepare(
    `SELECT p.size_sqm, pf.total_sales
       FROM projects p
       LEFT JOIN project_finance pf ON pf.project_id = p.id
      WHERE p.id = ?
        AND p.${scope.column} = ?
        AND lower(p.status) = 'confirmed' AND p.archived_at IS NULL`
  )
    .bind(projectId, scope.value)
    .first<{ size_sqm: number | null; total_sales: number | null }>();
  if (!row) return null;
  return { sizeSqm: row.size_sqm, totalSales: row.total_sales };
}

const toFile = (prefix: "t" | "l") => (r: FileRow): ShareFile => ({
  fileId: `${prefix}${r.id}`,
  fileName: r.file_name || "floorplan",
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
});

/**
 * The files on the named floorplan task (mig 050 moved uploads per task). The
 * BLANK kind falls back to the legacy project-level floorplan-category
 * attachment for pre-050 projects — the mobile Unfilled tile's rule
 * (`legacyItem(plans[0])`). The display kind has no legacy home.
 */
export async function listPlanFiles(env: Env, projectId: number, kind: PlanKind): Promise<ShareFile[]> {
  // company-scope: intentionally cross-company — `projectId` was resolved under
  // the token's party by resolveShareEvent; every statement joins to it.
  const task = await env.DB.prepare(
    `SELECT a.id, a.file_name, a.content_type, a.size_bytes
       FROM project_checklist_attachments a
       JOIN project_checklist pc ON pc.id = a.item_id
      WHERE pc.project_id = ?
        AND a.archived_at IS NULL
        AND lower(replace(pc.title, ' ', '')) LIKE ?
      ORDER BY a.uploaded_at DESC, a.id DESC`
  )
    .bind(projectId, PLAN_TITLE_LIKE[kind])
    .all<FileRow>();
  if (task.results.length) return task.results.map(toFile("t"));
  if (kind !== "blank") return [];
  const legacy = await env.DB.prepare(
    `SELECT id, file_name, mime_type AS content_type, size_bytes
       FROM project_attachments
      WHERE project_id = ?
        AND lower(category) = 'floorplan'
        AND archived_at IS NULL
      ORDER BY id ASC
      LIMIT 1`
  )
    .bind(projectId)
    .all<FileRow>();
  return legacy.results.map(toFile("l"));
}

/** The R2 key for ONE file id, joined back to the project AND the task kind, so
 *  an id from another project's task — or from this project's other floorplan
 *  task — can never be streamed under this link. */
async function planFileKey(env: Env, projectId: number, fileId: string, kind: PlanKind): Promise<KeyRow | null> {
  if (!FILE_ID_RE.test(fileId)) return null;
  const id = Number(fileId.slice(1));
  if (fileId.startsWith("t")) {
    // company-scope: intentionally cross-company — see listPlanFiles.
    return env.DB.prepare(
      `SELECT a.r2_key, a.file_name, a.content_type
         FROM project_checklist_attachments a
         JOIN project_checklist pc ON pc.id = a.item_id
        WHERE a.id = ?
          AND pc.project_id = ?
          AND a.archived_at IS NULL
          AND lower(replace(pc.title, ' ', '')) LIKE ?`
    )
      .bind(id, projectId, PLAN_TITLE_LIKE[kind])
      .first<KeyRow>();
  }
  if (kind !== "blank") return null;
  // company-scope: intentionally cross-company — see listPlanFiles.
  return env.DB.prepare(
    `SELECT r2_key, file_name, mime_type AS content_type
       FROM project_attachments
      WHERE id = ?
        AND project_id = ?
        AND lower(category) = 'floorplan'
        AND archived_at IS NULL`
  )
    .bind(id, projectId)
    .first<KeyRow>();
}

/** RFC 6266 disposition with an ASCII fallback, so a Chinese or quoted file
 *  name neither breaks the header nor is lost. */
export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "floorplan";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Stream one floorplan file, or null when the id is not one this link may
 *  see. `download` answers as an attachment so the browser saves it. */
export async function streamPlanFile(
  env: Env,
  projectId: number,
  fileId: string,
  kind: PlanKind,
  download: boolean,
): Promise<Response | null> {
  const att = await planFileKey(env, projectId, fileId, kind);
  if (!att) return null;
  const obj = await env.POD_BUCKET.get(att.r2_key);
  if (!obj) return null;
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": att.content_type || obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": contentDisposition(download ? "attachment" : "inline", att.file_name || "floorplan"),
      // Block MIME-sniffing the server-derived content-type back into
      // html/svg (parity with the authenticated attachment stream).
      "X-Content-Type-Options": "nosniff",
      // Token-gated: never let a shared cache hold it.
      "Cache-Control": "private, max-age=300",
    },
  });
}

/** One row of the Excel export. `totalSales` is present ONLY when the caller
 *  asked for it (the brand route); the contractor route's rows never carry the
 *  key at all, so nothing downstream can leak it by accident. */
export type ShareExportRow = {
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  state: string | null;
  organizer: string | null;
  brand: string | null;
  eventType: string | null;
  boothNo: string | null;
  sizeSqm: number | null;
  totalSales?: number | null;
};

type ExportRowDb = {
  start_date: string | null;
  end_date: string | null;
  venue: string | null;
  state: string | null;
  brand: string | null;
  event_type: string | null;
  organizer: string | null;
  booth_no: string | null;
  size_sqm: number | null;
  total_sales?: number | null;
};

/** `YYYY-MM` — the one month an export covers (owner 2026-09-09: "when chose
 *  september then click export will export event on september only"). */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `YYYY` — the whole year, for the contractors whose master row says so. */
export const YEAR_RE = /^\d{4}$/;

/** The days an export covers, inclusive, as 'YYYY-MM-DD'. */
export type ExportWindow = { first: string; last: string };

/** First and last calendar day of a `YYYY-MM` month. */
export function monthBounds(month: string): ExportWindow {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/** 1 Jan to 31 Dec of a `YYYY` year. */
export function yearBounds(year: string): ExportWindow {
  return { first: `${year}-01-01`, last: `${year}-12-31` };
}

/** The window a request asked for: `?month=YYYY-MM`, `?year=YYYY`, or neither
 *  (the whole schedule — what a page loaded before the month rule shipped still
 *  sends until it reloads, docs/bugs/0743). Both at once, or a malformed value,
 *  is a bad request — never silently the whole schedule. */
export function exportWindowFromQuery(month: string | undefined, year: string | undefined): { window: ExportWindow | null } | { error: string } {
  const m = (month ?? "").trim();
  const y = (year ?? "").trim();
  if (m && y) return { error: "Send month or year, not both." };
  if (m) return MONTH_RE.test(m) ? { window: monthBounds(m) } : { error: "Month must look like 2026-09." };
  if (y) return YEAR_RE.test(y) ? { window: yearBounds(y) } : { error: "Year must look like 2026." };
  return { window: null };
}

/** What a contractor's link exports on one press: the month on screen, or the
 *  whole year (owner 2026-09-09: YEN CREATIVE, BAND OF GORILLA, JH CONTRACTOR
 *  export the year; the rest, and every brand, the month). A per-row setting on
 *  the contractor picker table, flipped from Project Maintenance. */
export type ContractorExportScope = "month" | "year";

export async function readContractorExportScope(env: Env, contractor: string): Promise<ContractorExportScope> {
  // company-scope: intentionally cross-company — the contractor picker is a
  // global lookup table, read by the party's own name (see listShareEvents).
  const row = await env.DB.prepare(
    `SELECT share_export_scope FROM project_contractors WHERE lower(name) = lower(?) ORDER BY id LIMIT 1`
  )
    .bind(contractor)
    .first<{ share_export_scope: string | null }>();
  return row?.share_export_scope === "year" ? "year" : "month";
}

/** The party's confirmed events that touch `month`, as export rows. An event
 *  counts when any of its days fall in the month (a 30 Aug – 2 Sep show is in
 *  both months' exports). `month: null` means the whole schedule — what a page
 *  loaded BEFORE 2026-09-09's deploy still asks for; a tab that is open across
 *  a deploy keeps its old JavaScript until it reloads, and refusing it made the
 *  export fail for the owner within minutes of shipping. The money column is
 *  only SELECTed when `withSales` —
 *  a contractor export never reads project_finance. Owner 2026-09-09 ("tambah
 *  state brand type"): State, Brand and the event TYPE (project_event_types.name,
 *  the project's own type picker) ride along. */
export async function listShareExportRows(env: Env, scope: ShareScope, withSales: boolean, win: ExportWindow | null): Promise<ShareExportRow[]> {
  // company-scope: intentionally cross-company — see listShareEvents.
  const cols = `p.start_date, p.end_date, p.venue, p.state, p.organizer, p.brand, et.name AS event_type, p.booth_no, p.size_sqm`;
  // Dates are 'YYYY-MM-DD[...]' text; the first ten characters compare as days.
  const inMonth = win
    ? `substr(p.start_date, 1, 10) <= ? AND substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?`
    : `1 = 1`;
  const window = win ? [win.last, win.first] : [];
  const sql = withSales
    ? `SELECT ${cols}, pf.total_sales
         FROM projects p
         LEFT JOIN project_event_types et ON et.id = p.event_type_id
         LEFT JOIN project_finance pf ON pf.project_id = p.id
        WHERE p.${scope.column} = ?
          AND lower(p.status) = 'confirmed' AND p.archived_at IS NULL
          AND ${inMonth}
        ORDER BY p.start_date`
    : `SELECT ${cols}
         FROM projects p
         LEFT JOIN project_event_types et ON et.id = p.event_type_id
        WHERE p.${scope.column} = ?
          AND lower(p.status) = 'confirmed' AND p.archived_at IS NULL
          AND ${inMonth}
        ORDER BY p.start_date`;
  const rows = await env.DB.prepare(sql).bind(scope.value, ...window).all<ExportRowDb>();
  return rows.results.map((r) => {
    const out: ShareExportRow = {
      startDate: r.start_date,
      endDate: r.end_date,
      venue: r.venue,
      state: r.state,
      organizer: r.organizer,
      brand: r.brand,
      eventType: r.event_type,
      boothNo: r.booth_no,
      sizeSqm: r.size_sqm,
    };
    if (withSales) out.totalSales = r.total_sales ?? null;
    return out;
  });
}

/** One event's DISPLAY floorplan files, for the brand link's "Display Floorplan
 *  (PDF)" export — the browser walks this and fetches each file by id. */
export type SharePlanEvent = {
  eventId: number;
  name: string | null;
  venue: string | null;
  boothNo: string | null;
  startDate: string | null;
  endDate: string | null;
  files: ShareFile[];
};

type PlanManifestRow = {
  id: number;
  name: string | null;
  venue: string | null;
  booth_no: string | null;
  start_date: string | null;
  end_date: string | null;
  file_id: number;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
};

/** The display floorplans of the party's confirmed events touching `month`
 *  (null = the whole schedule), in ONE statement, oldest event first, newest
 *  upload first within an event. An event with no display floorplan is simply
 *  absent (owner 2026-09-09: "skip events with no display floorplan uploaded").
 *  Display plans have no legacy home, so no project_attachments fallback. */
export async function listDisplayPlanManifest(env: Env, scope: ShareScope, win: ExportWindow | null): Promise<SharePlanEvent[]> {
  // company-scope: intentionally cross-company — see listShareEvents.
  const inMonth = win
    ? `substr(p.start_date, 1, 10) <= ? AND substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?`
    : `1 = 1`;
  const window = win ? [win.last, win.first] : [];
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.venue, p.booth_no, p.start_date, p.end_date,
            a.id AS file_id, a.file_name, a.content_type, a.size_bytes
       FROM projects p
       JOIN project_checklist pc ON pc.project_id = p.id
       JOIN project_checklist_attachments a ON a.item_id = pc.id
      WHERE p.${scope.column} = ?
        AND lower(p.status) = 'confirmed' AND p.archived_at IS NULL
        AND lower(replace(pc.title, ' ', '')) LIKE ?
        AND a.archived_at IS NULL
        AND ${inMonth}
      ORDER BY p.start_date, p.id, a.uploaded_at DESC, a.id DESC`
  )
    .bind(scope.value, PLAN_TITLE_LIKE.display, ...window)
    .all<PlanManifestRow>();
  const out: SharePlanEvent[] = [];
  for (const r of rows.results) {
    let ev = out.length ? out[out.length - 1] : null;
    if (!ev || ev.eventId !== r.id) {
      ev = { eventId: r.id, name: r.name, venue: r.venue, boothNo: r.booth_no, startDate: r.start_date, endDate: r.end_date, files: [] };
      out.push(ev);
    }
    ev.files.push({ fileId: `t${r.file_id}`, fileName: r.file_name ?? `file-${r.file_id}`, contentType: r.content_type, sizeBytes: r.size_bytes });
  }
  return out;
}

/** What a share_export_log row says was exported: a party's Excel, or the brand
 *  link's display-floorplan PDF (whose row_count is the number of EVENTS). */
export type ShareExportKind = ShareScope["column"] | "brand_floorplans";

/** Append-only accountability row: who (which link, which party) exported,
 *  from where, how many rows, when. Never on a request path that reads it. */
export async function logShareExport(
  env: Env,
  kind: ShareExportKind,
  subject: string,
  token: string,
  ip: string,
  rowCount: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO share_export_log (kind, subject, token, ip, row_count)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(kind, subject, token, ip, rowCount)
    .run();
}
