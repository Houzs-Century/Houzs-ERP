// ----------------------------------------------------------------------------
// publicContractorCalendar — a contractor's confirmed event schedule, reachable
// WITHOUT A LOGIN.
//
//   GET /api/public/contractor-calendar/:token
//   GET /api/public/contractor-calendar/:token/events/:eventId/floorplan
//   GET /api/public/contractor-calendar/:token/events/:eventId/floorplan/:fileId
//
// The unguessable token IS the credential (pattern: routes/publicDoScan.ts and
// mig 0126's kill switch). The contractor the link belongs to is read off the
// TOKEN ROW, never from the request, so a token can only ever see the one
// contractor's schedule it was minted for.
//
// MINIMISATION. Only the confirmed schedule leaves this route — brand, organizer,
// state, venue, booth, dates — plus, per event, the UNFILLED floorplan (owner
// 2026-09-08: "only appear unfilled floorplan inside, others hide from
// contractor, and allowed them to view and download"). No finance, no sales,
// no cost, no checklist, no notes, no other file. The SELECTs name their
// columns; they must never grow to `SELECT *` or spread a row. RLS is disabled
// prod-wide, so the WHERE clause IS the boundary: the reads go through
// `c.env.DB` (the d1-compat shim over Postgres via the connection-string role,
// not the anon PostgREST path), exactly like the authenticated project reads.
//
// The `eventId` in the list is the project id. It opens nothing on its own: the
// two per-event routes re-check `id = ? AND contractor = <token's contractor>`
// on every call, so an id from another contractor's project answers 404 here
// and every authenticated project route still sits behind `auth`.
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
// File ids are namespaced by the table they came from — `t<id>` for a
// checklist-task attachment, `l<id>` for a legacy project-level one — so the
// stream route knows which row to read the R2 key from. The key itself never
// travels to the browser.
const FILE_ID_RE = /^[tl][1-9][0-9]{0,11}$/;

const READ_MAX = 300;
const WINDOW_SEC = 900;

type Ctx = Context<{ Bindings: Env }>;

// The ONLY shape a contractor holding the link ever receives.
type ShareEvent = {
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

type Row = {
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

/** One unfilled-floorplan file, as the contractor sees it. No key, no uploader. */
type ShareFile = {
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
async function gate(c: Ctx): Promise<{ contractor: string } | Response> {
  const token = (c.req.param("token") ?? "").trim();
  // Shape gate first — before the limiter and any query.
  if (!TOKEN_RE.test(token)) return unknownLink(c);

  const limited = await checkRateLimit(c, "contractor_share_read", clientIp(c), READ_MAX, WINDOW_SEC);
  if (limited) return limited;

  const contractor = await resolveShareToken(c.env, token);
  if (!contractor) return unknownLink(c);
  return { contractor };
}

/** The event must be ON THIS CONTRACTOR'S confirmed schedule — the same
 *  predicate the list uses, narrowed to one id. A project id that belongs to
 *  someone else, is unconfirmed or is archived does not exist here. */
async function resolveEvent(c: Ctx, contractor: string): Promise<number | Response> {
  const raw = c.req.param("eventId") ?? "";
  if (!/^[1-9][0-9]{0,11}$/.test(raw)) return unknownEvent(c);
  const id = Number(raw);
  // company-scope: intentionally cross-company — see the list route below; the
  // boundary is the token's contractor name, re-applied here on the single row.
  const row = await c.env.DB.prepare(
    `SELECT id
       FROM projects
      WHERE id = ?
        AND contractor = ?
        AND lower(status) = 'confirmed'
        AND archived_at IS NULL`
  )
    .bind(id, contractor)
    .first<{ id: number }>();
  if (!row) return unknownEvent(c);
  return row.id;
}

// The UNFILLED floorplan is what is attached to the "Blank Floorplan" checklist
// task (mig 050 moved uploads per task); pre-050 projects fall back to the
// project-level floorplan-category attachment. This mirrors the mobile Floor
// Plans card's "Unfilled" tile (MobilePMS.tsx `taskPlanAtts(/^blank\s*floor\s*plan/i)`
// then `legacyItem(plans[0])`) so the contractor sees the same file staff do.
// The Display Floor Plan and the Filled Floorplan are deliberately NOT here.
const TASK_FILES_SQL = `SELECT a.id, a.file_name, a.content_type, a.size_bytes
       FROM project_checklist_attachments a
       JOIN project_checklist pc ON pc.id = a.item_id
      WHERE pc.project_id = ?
        AND a.archived_at IS NULL
        AND lower(replace(pc.title, ' ', '')) LIKE 'blankfloorplan%'
      ORDER BY a.uploaded_at DESC, a.id DESC`;

const LEGACY_FILES_SQL = `SELECT id, file_name, mime_type AS content_type, size_bytes
       FROM project_attachments
      WHERE project_id = ?
        AND lower(category) = 'floorplan'
        AND archived_at IS NULL
      ORDER BY id ASC
      LIMIT 1`;

async function listUnfilledFloorplans(env: Env, projectId: number): Promise<ShareFile[]> {
  // company-scope: intentionally cross-company — `projectId` was resolved under
  // the token's contractor by resolveEvent; both statements join to it.
  const task = await env.DB.prepare(TASK_FILES_SQL).bind(projectId).all<FileRow>();
  const toFile = (prefix: "t" | "l") => (r: FileRow): ShareFile => ({
    fileId: `${prefix}${r.id}`,
    fileName: r.file_name || "floorplan",
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
  });
  if (task.results.length) return task.results.map(toFile("t"));
  const legacy = await env.DB.prepare(LEGACY_FILES_SQL).bind(projectId).all<FileRow>();
  return legacy.results.map(toFile("l"));
}

/** Read the R2 key for ONE file id, joined back to the project so an id from
 *  another project's task can never be streamed under this token. */
async function fileKey(
  env: Env,
  projectId: number,
  fileId: string,
): Promise<{ r2_key: string; file_name: string | null; content_type: string | null } | null> {
  const id = Number(fileId.slice(1));
  if (fileId.startsWith("t")) {
    // company-scope: intentionally cross-company — pre-auth public route; the
    // boundary is the token's contractor, already applied to `projectId` by
    // resolveEvent, and this read is joined back to that project id.
    return env.DB.prepare(
      `SELECT a.r2_key, a.file_name, a.content_type
         FROM project_checklist_attachments a
         JOIN project_checklist pc ON pc.id = a.item_id
        WHERE a.id = ?
          AND pc.project_id = ?
          AND a.archived_at IS NULL
          AND lower(replace(pc.title, ' ', '')) LIKE 'blankfloorplan%'`
    )
      .bind(id, projectId)
      .first<{ r2_key: string; file_name: string | null; content_type: string | null }>();
  }
  // company-scope: intentionally cross-company — same boundary as above.
  return env.DB.prepare(
    `SELECT r2_key, file_name, mime_type AS content_type
       FROM project_attachments
      WHERE id = ?
        AND project_id = ?
        AND lower(category) = 'floorplan'
        AND archived_at IS NULL`
  )
    .bind(id, projectId)
    .first<{ r2_key: string; file_name: string | null; content_type: string | null }>();
}

/** RFC 6266 disposition with an ASCII fallback, so a Chinese or quoted file
 *  name neither breaks the header nor is lost. */
function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "floorplan";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

publicContractorCalendar.get("/:token", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { contractor } = g;

  // The contractor comes from the token, never the request. Confirmed + live
  // rows only. Whitelisted columns only.
  // company-scope: intentionally cross-company — a pre-auth public route has no session
  // and no companyContext, so there is no company value to scope by; the tenant boundary
  // is the unguessable token resolving to ONE contractor name (filtered below), and
  // only confirmed, non-archived, whitelisted columns leave the route. Verified 2026-09-04.
  const rows = await c.env.DB.prepare(
    `SELECT id, brand, organizer, state, venue, booth_no, start_date, end_date, name
       FROM projects
      WHERE contractor = ?
        AND lower(status) = 'confirmed'
        AND archived_at IS NULL
      ORDER BY start_date`
  )
    .bind(contractor)
    .all<Row>();

  const events: ShareEvent[] = rows.results.map((r) => ({
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

  return c.json({ contractor, events });
});

// The unfilled floorplan files for one event on this contractor's schedule.
publicContractorCalendar.get("/:token/events/:eventId/floorplan", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const projectId = await resolveEvent(c, g.contractor);
  if (projectId instanceof Response) return projectId;

  const files = await listUnfilledFloorplans(c.env, projectId);
  return c.json({ files });
});

// Stream one of those files. `?download=1` answers as an attachment so the
// browser saves it; otherwise inline so an image or PDF opens in the tab.
publicContractorCalendar.get("/:token/events/:eventId/floorplan/:fileId", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const projectId = await resolveEvent(c, g.contractor);
  if (projectId instanceof Response) return projectId;

  const fileId = c.req.param("fileId") ?? "";
  if (!FILE_ID_RE.test(fileId)) return c.json({ error: "not_found" }, 404);
  const att = await fileKey(c.env, projectId, fileId);
  if (!att) return c.json({ error: "not_found" }, 404);

  const obj = await c.env.POD_BUCKET.get(att.r2_key);
  if (!obj) return c.json({ error: "not_found" }, 404);

  const download = c.req.query("download") === "1";
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
});
