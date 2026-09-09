// ----------------------------------------------------------------------------
// The no-login contractor calendar's floorplan routes, driven through the REAL
// router.
//
// Owner 2026-09-08: a contractor may tap an event and see ONLY its unfilled
// floorplan, view it and download it. Every property here is one a stranger
// holding a link could otherwise exploit, so each is exercised against the
// shipped handler rather than asserted about its source:
//
//   · the list carries an eventId the panel can open
//   · an eventId belonging to ANOTHER contractor answers 404 and the attachment
//     tables are never touched — the token's contractor is re-applied per event
//   · the file list is the "Blank Floorplan" task's live attachments, falling
//     back to the legacy project-level floorplan (the mobile Unfilled tile rule)
//   · the stream reads the R2 key off the DATABASE ROW — the browser never
//     names a key — and `?download=1` flips the disposition to attachment
//   · a file id from another project's task is 404 even under a valid event
//
// The database is a fake of the D1-shaped binding keyed on the SQL text, so a
// route that stops asking the contractor predicate turns the isolation test red.
// ----------------------------------------------------------------------------
import { describe, expect, test, beforeEach } from "vitest";
import { publicContractorCalendar } from "../src/routes/publicContractorCalendar";
import type { Env } from "../src/types";

const TOKEN = "abcdefghijklmnopqrstuvwx012345_-";
const MINE = "DREAM ART (M) SDN BHD";
const THEIRS = "YEN CREATIVE SDN BHD";

type Row = Record<string, unknown>;

let projects: Row[] = [];
let checklist: Row[] = [];
let taskAtts: Row[] = [];
let legacyAtts: Row[] = [];
/** Every table a statement read, in order — the DB-touch tripwire. */
let touched: string[] = [];
let bucketGets: string[] = [];
let exportLog: Row[] = [];

function tableOf(sql: string): string {
  const m = /(?:FROM|INTO)\s+([a-z_]+)/i.exec(sql);
  return m ? m[1] : "?";
}

/** Answer a statement the way the real tables would, from the SQL's shape. */
function run(sql: string, args: unknown[]): Row[] {
  const table = tableOf(sql);
  touched.push(table);
  if (table === "contractor_share_tokens") {
    return args[0] === TOKEN ? [{ contractor: MINE, revoked_at: null }] : [];
  }
  if (table === "projects") {
    const byId = /WHERE id = \?/.test(sql);
    const live = (p: Row) => String(p.status).toLowerCase() === "confirmed" && p.archived_at == null;
    if (byId) {
      return projects.filter((p) => p.id === args[0] && p.contractor === args[1] && live(p));
    }
    const mine = projects.filter((p) => p.contractor === args[0] && live(p));
    // The export's month window: binds are [contractor, last day, first day].
    if (/substr\(p\.start_date, 1, 10\) <= \?/.test(sql)) {
      return mine.filter((p) => String(p.start_date).slice(0, 10) <= String(args[1]) && String(p.end_date ?? p.start_date).slice(0, 10) >= String(args[2]));
    }
    return mine;
  }
  if (table === "share_export_log") {
    exportLog.push({ kind: args[0], subject: args[1], token: args[2], ip: args[3], row_count: args[4] });
    return [];
  }
  if (table === "project_checklist_attachments") {
    // The task-title pattern is a bind now; the contractor route must ask for the BLANK task.
    const like = String(args[args.length - 1]);
    if (like !== "blankfloorplan%") throw new Error("contractor route asked for the wrong task: " + like);
    const blank = (itemId: unknown) =>
      checklist.some(
        (it) => it.id === itemId && /^blankfloorplan/.test(String(it.title).toLowerCase().replace(/ /g, "")),
      );
    const byId = /WHERE a\.id = \?/.test(sql);
    const projectId = byId ? args[1] : args[0];
    const rows = taskAtts.filter((a) => {
      const item = checklist.find((it) => it.id === a.item_id);
      return item && item.project_id === projectId && a.archived_at == null && blank(a.item_id);
    });
    return byId ? rows.filter((a) => a.id === args[0]) : rows;
  }
  if (table === "project_attachments") {
    const byId = /WHERE id = \?/.test(sql);
    const projectId = byId ? args[1] : args[0];
    const rows = legacyAtts
      .filter((a) => a.project_id === projectId && String(a.category).toLowerCase() === "floorplan" && a.archived_at == null)
      .map((a) => ({ ...a, content_type: a.mime_type }));
    return byId ? rows.filter((a) => a.id === args[0]) : rows.slice(0, 1);
  }
  throw new Error(`unexpected table ${table}`);
}

function fakeEnv(): Env {
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => run(sql, args)[0] ?? null,
        all: async () => ({ results: run(sql, args) }),
        run: async () => { run(sql, args); return { success: true }; },
      }),
    }),
  };
  const POD_BUCKET = {
    get: async (key: string) => {
      bucketGets.push(key);
      if (key !== "projects/7/blank.pdf") return null;
      return {
        body: new ReadableStream({ start: (ctl) => { ctl.enqueue(new TextEncoder().encode("%PDF-fake")); ctl.close(); } }),
        httpMetadata: { contentType: "application/pdf" },
      };
    },
  };
  return { DB, POD_BUCKET } as unknown as Env;
}

const get = (path: string) => publicContractorCalendar.request(path, {}, fakeEnv());

beforeEach(() => {
  touched = [];
  bucketGets = [];
  exportLog = [];
  projects = [
    { id: 7, contractor: MINE, status: "Confirmed", archived_at: null, brand: "AKEMI", organizer: "HOMELOVE", state: "SELANGOR", event_type: "ROADSHOW", venue: "MID VALLEY", booth_no: "3053", start_date: "2026-09-11", end_date: "2026-09-13", name: null, size_sqm: 72 },
    { id: 8, contractor: THEIRS, status: "Confirmed", archived_at: null, brand: "ZANOTTI", organizer: null, state: null, venue: "IOI", booth_no: "1", start_date: "2026-09-11", end_date: "2026-09-13", name: null },
  ];
  checklist = [
    { id: 70, project_id: 7, title: "Blank Floorplan" },
    { id: 71, project_id: 7, title: "Filled Floorplan" },
    { id: 80, project_id: 8, title: "Blank Floorplan" },
  ];
  taskAtts = [
    { id: 700, item_id: 70, r2_key: "projects/7/blank.pdf", file_name: "MV blank.pdf", content_type: "application/pdf", size_bytes: 1234, archived_at: null, uploaded_at: "2026-09-01" },
    { id: 701, item_id: 71, r2_key: "projects/7/filled.pdf", file_name: "MV filled.pdf", content_type: "application/pdf", size_bytes: 999, archived_at: null, uploaded_at: "2026-09-02" },
    { id: 800, item_id: 80, r2_key: "projects/8/blank.pdf", file_name: "IOI blank.pdf", content_type: "application/pdf", size_bytes: 1, archived_at: null, uploaded_at: "2026-09-01" },
  ];
  legacyAtts = [];
});

describe("public contractor calendar — unfilled floorplan", () => {
  test("the list carries the eventId the panel opens", async () => {
    const res = await get(`/${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ eventId: number; venue: string }> };
    expect(body.events).toEqual([expect.objectContaining({ eventId: 7, venue: "MID VALLEY" })]);
  });

  test("lists ONLY the Blank Floorplan task's files — the Filled one stays hidden", async () => {
    const res = await get(`/${TOKEN}/events/7/floorplan`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<Record<string, unknown>> };
    expect(body.files).toEqual([
      { fileId: "t700", fileName: "MV blank.pdf", contentType: "application/pdf", sizeBytes: 1234 },
    ]);
    // No key, no uploader, nothing that is not in the whitelisted shape.
    expect(Object.keys(body.files[0]).sort()).toEqual(["contentType", "fileId", "fileName", "sizeBytes"]);
  });

  test("another contractor's event is 404 and the attachment tables are never read", async () => {
    const res = await get(`/${TOKEN}/events/8/floorplan`);
    expect(res.status).toBe(404);
    expect(touched).not.toContain("project_checklist_attachments");
    expect(touched).not.toContain("project_attachments");
  });

  test("falls back to the legacy project-level floorplan when the task has no file", async () => {
    taskAtts = taskAtts.filter((a) => a.id !== 700);
    legacyAtts = [
      { id: 5, project_id: 7, category: "floorplan", r2_key: "legacy/5.png", file_name: "old.png", mime_type: "image/png", size_bytes: 10, archived_at: null },
    ];
    const res = await get(`/${TOKEN}/events/7/floorplan`);
    const body = (await res.json()) as { files: Array<{ fileId: string; fileName: string }> };
    expect(body.files).toEqual([expect.objectContaining({ fileId: "l5", fileName: "old.png" })]);
  });

  test("streams by the ROW's key, inline by default and as an attachment on ?download=1", async () => {
    const view = await get(`/${TOKEN}/events/7/floorplan/t700`);
    expect(view.status).toBe(200);
    expect(view.headers.get("Content-Type")).toBe("application/pdf");
    expect(view.headers.get("Content-Disposition")).toMatch(/^inline; filename="MV blank.pdf"/);
    expect(view.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(bucketGets).toEqual(["projects/7/blank.pdf"]);

    const dl = await get(`/${TOKEN}/events/7/floorplan/t700?download=1`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Disposition")).toMatch(/^attachment; filename="MV blank.pdf"/);
  });

  test("a file id from another project's Blank Floorplan task is 404 under my event", async () => {
    const res = await get(`/${TOKEN}/events/7/floorplan/t800`);
    expect(res.status).toBe(404);
    expect(bucketGets).toEqual([]);
  });

  test("the Filled Floorplan's own file id is 404 even though it is on my event", async () => {
    const res = await get(`/${TOKEN}/events/7/floorplan/t701`);
    expect(res.status).toBe(404);
    expect(bucketGets).toEqual([]);
  });

  test("export carries Date/Venue/State/Organizer/Brand/Type/Booth/Size, never sales, never reads project_finance, and is logged", async () => {
    const res = await get(`/${TOKEN}/export?month=2026-09`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contractor: string; rows: Array<Record<string, unknown>> };
    expect(body.contractor).toBe(MINE);
    expect(body.rows).toEqual([
      { startDate: "2026-09-11", endDate: "2026-09-13", venue: "MID VALLEY", state: "SELANGOR", organizer: "HOMELOVE", brand: "AKEMI", eventType: "ROADSHOW", boothNo: "3053", sizeSqm: 72 },
    ]);
    expect(Object.keys(body.rows[0])).not.toContain("totalSales");
    expect(touched).not.toContain("project_finance");
    expect(exportLog).toEqual([{ kind: "contractor", subject: MINE, token: TOKEN, ip: "unknown", row_count: 1 }]);
  });

  test("export covers ONLY the month asked for; no month = the whole schedule (an old tab); a malformed month is refused", async () => {
    // The September show is not an October export.
    const oct = await get(`/${TOKEN}/export?month=2026-10`);
    expect(oct.status).toBe(200);
    expect((await oct.json() as { rows: unknown[] }).rows).toEqual([]);
    expect(exportLog).toEqual([{ kind: "contractor", subject: MINE, token: TOKEN, ip: "unknown", row_count: 0 }]);
    // A show straddling the month end is in BOTH months.
    projects[0].start_date = "2026-08-30";
    projects[0].end_date = "2026-09-02";
    for (const m of ["2026-08", "2026-09"]) {
      const r = await get(`/${TOKEN}/export?month=${m}`);
      expect((await r.json() as { rows: unknown[] }).rows.length).toBe(1);
    }
    // No month at all: the page from before 2026-09-09 still asks this way until
    // it reloads, and it must keep getting the whole schedule.
    exportLog = [];
    const all = await get(`/${TOKEN}/export`);
    expect(all.status).toBe(200);
    expect((await all.json() as { rows: unknown[] }).rows.length).toBe(1);
    expect(exportLog).toEqual([{ kind: "contractor", subject: MINE, token: TOKEN, ip: "unknown", row_count: 1 }]);
    // A month that is present but malformed: refused, nothing logged.
    exportLog = [];
    for (const q of ["?month=2026", "?month=2026-13", "?month=all"]) {
      const r = await get(`/${TOKEN}/export${q}`);
      expect(r.status).toBe(400);
    }
    expect(exportLog).toEqual([]);
  });

  test("an unknown or revoked token gets the same 404 on every route", async () => {
    const bad = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    for (const p of [`/${bad}`, `/${bad}/events/7/floorplan`, `/${bad}/events/7/floorplan/t700`, `/${bad}/export`]) {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("unknown_link");
    }
    expect(touched).not.toContain("projects");
  });

  test("no display-floorplan manifest on a contractor link (owner: brand links only)", async () => {
    const res = await get(`/${TOKEN}/floorplans?month=2026-09`);
    expect(res.status).toBe(404);
    expect(exportLog).toEqual([]);
  });

  test("an event's size is readable, never its money, and only for my own event", async () => {
    const res = await get(`/${TOKEN}/events/7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sizeSqm: 72 });
    expect(touched).not.toContain("project_finance");
    expect((await get(`/${TOKEN}/events/8`)).status).toBe(404);
  });
});
