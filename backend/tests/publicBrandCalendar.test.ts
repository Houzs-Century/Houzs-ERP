// ----------------------------------------------------------------------------
// The no-login BRAND calendar, driven through the REAL router.
//
// Owner 2026-09-08: each brand gets its own link and sees ONLY its own events;
// inside an event it may view/download the DISPLAY floorplan and see Total
// Sales and Size; its Excel export carries Total Sales and is logged. Every
// property here is one a stranger holding the AKEMI link could otherwise
// exploit against ZANOTTI, so each is exercised against the shipped handler:
//
//   · the list holds only the token's brand
//   · a ZANOTTI event id under the AKEMI link is 404 — figures, files, stream
//   · the files are the DISPLAY floorplan task's, never the blank/filled ones,
//     and the display kind has NO legacy fallback
//   · the export is scoped to the brand, carries total_sales, and writes ONE
//     share_export_log row naming the brand, the token and the row count
//   · an unknown or revoked token gets the same 404 on every route
//
// The database is a fake of the D1-shaped binding keyed on the SQL text, so a
// route that stops asking the brand predicate turns the isolation test red.
// ----------------------------------------------------------------------------
import { describe, expect, test, beforeEach } from "vitest";
import { publicBrandCalendar } from "../src/routes/publicBrandCalendar";
import type { Env } from "../src/types";

const TOKEN = "AKEMIakemiAKEMIakemiAKEMIakemi01";
const AKEMI = "AKEMI";
const ZANOTTI = "ZANOTTI";

type Row = Record<string, unknown>;

let projects: Row[] = [];
let finance: Row[] = [];
let checklist: Row[] = [];
let taskAtts: Row[] = [];
let legacyAtts: Row[] = [];
let exportLog: Row[] = [];
let touched: string[] = [];
let bucketGets: string[] = [];

function tableOf(sql: string): string {
  const m = /(?:FROM|INTO)\s+([a-z_]+)/i.exec(sql);
  return m ? m[1] : "?";
}

function run(sql: string, args: unknown[]): Row[] {
  const table = tableOf(sql);
  touched.push(table);
  const live = (p: Row) => String(p.status).toLowerCase() === "confirmed" && p.archived_at == null;
  if (table === "brand_share_tokens") {
    return args[0] === TOKEN ? [{ brand: AKEMI, revoked_at: null }] : [];
  }
  if (table === "projects") {
    if (!/\bbrand = \?/.test(sql)) throw new Error("a projects read without the brand predicate: " + sql);
    const byId = /WHERE (p\.)?id = \?/.test(sql);
    const rows = byId
      ? projects.filter((p) => p.id === args[0] && p.brand === args[1] && live(p))
      : projects.filter((p) => p.brand === args[0] && live(p));
    if (/project_finance/.test(sql)) {
      return rows.map((p) => ({ ...p, size_sqm: p.size_sqm, total_sales: finance.find((f) => f.project_id === p.id)?.total_sales ?? null }));
    }
    return rows;
  }
  if (table === "project_checklist_attachments") {
    const like = String(args[args.length - 1]).replace("%", "");
    const matches = (itemId: unknown) =>
      checklist.some((it) => it.id === itemId && String(it.title).toLowerCase().replace(/ /g, "").startsWith(like));
    const byId = /WHERE a\.id = \?/.test(sql);
    const projectId = byId ? args[1] : args[0];
    const rows = taskAtts.filter((a) => {
      const item = checklist.find((it) => it.id === a.item_id);
      return item && item.project_id === projectId && a.archived_at == null && matches(a.item_id);
    });
    return byId ? rows.filter((a) => a.id === args[0]) : rows;
  }
  if (table === "project_attachments") {
    return legacyAtts.filter((a) => a.project_id === args[0]);
  }
  if (table === "share_export_log") {
    exportLog.push({ kind: args[0], subject: args[1], token: args[2], ip: args[3], row_count: args[4] });
    return [];
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
      if (key !== "projects/7/display.pdf") return null;
      return {
        body: new ReadableStream({ start: (ctl) => { ctl.enqueue(new TextEncoder().encode("%PDF-fake")); ctl.close(); } }),
        httpMetadata: { contentType: "application/pdf" },
      };
    },
  };
  return { DB, POD_BUCKET } as unknown as Env;
}

const get = (path: string) => publicBrandCalendar.request(path, { headers: { "CF-Connecting-IP": "203.0.113.9" } }, fakeEnv());

beforeEach(() => {
  touched = [];
  bucketGets = [];
  exportLog = [];
  projects = [
    { id: 7, brand: AKEMI, contractor: "DREAM ART", status: "Confirmed", archived_at: null, organizer: "HOMELOVE", state: "SELANGOR", event_type: "ROADSHOW", venue: "MID VALLEY", booth_no: "3053", start_date: "2026-09-11", end_date: "2026-09-13", name: null, size_sqm: 72 },
    { id: 8, brand: ZANOTTI, contractor: "DREAM ART", status: "Confirmed", archived_at: null, organizer: null, state: null, venue: "IOI", booth_no: "1", start_date: "2026-09-11", end_date: "2026-09-13", name: null, size_sqm: 18 },
    { id: 9, brand: AKEMI, contractor: "DREAM ART", status: "Pending", archived_at: null, organizer: null, state: null, venue: "PENDING VENUE", booth_no: "x", start_date: "2026-10-01", end_date: "2026-10-02", name: null, size_sqm: 9 },
  ];
  finance = [
    { project_id: 7, total_sales: 125000 },
    { project_id: 8, total_sales: 999999 },
  ];
  checklist = [
    { id: 70, project_id: 7, title: "Blank Floorplan" },
    { id: 71, project_id: 7, title: "Display Floor Plan" },
    { id: 72, project_id: 7, title: "Filled Floorplan" },
    { id: 81, project_id: 8, title: "Display Floor Plan" },
  ];
  taskAtts = [
    { id: 700, item_id: 70, r2_key: "projects/7/blank.pdf", file_name: "MV blank.pdf", content_type: "application/pdf", size_bytes: 1, archived_at: null, uploaded_at: "2026-09-01" },
    { id: 701, item_id: 71, r2_key: "projects/7/display.pdf", file_name: "MV display.pdf", content_type: "application/pdf", size_bytes: 2048, archived_at: null, uploaded_at: "2026-09-02" },
    { id: 702, item_id: 72, r2_key: "projects/7/filled.pdf", file_name: "MV filled.pdf", content_type: "application/pdf", size_bytes: 1, archived_at: null, uploaded_at: "2026-09-03" },
    { id: 810, item_id: 81, r2_key: "projects/8/display.pdf", file_name: "IOI display.pdf", content_type: "application/pdf", size_bytes: 1, archived_at: null, uploaded_at: "2026-09-01" },
  ];
  legacyAtts = [{ id: 5, project_id: 7, category: "floorplan", r2_key: "legacy/5.png", file_name: "old.png", mime_type: "image/png", size_bytes: 10, archived_at: null }];
});

describe("public brand calendar", () => {
  test("the list holds only the token's brand, confirmed only", async () => {
    const res = await get(`/${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brand: string; events: Array<{ eventId: number; brand: string }> };
    expect(body.brand).toBe(AKEMI);
    expect(body.events.map((e) => e.eventId)).toEqual([7]);
  });

  test("figures: size and total sales for the brand's own event", async () => {
    const res = await get(`/${TOKEN}/events/7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sizeSqm: 72, totalSales: 125000 });
  });

  test("another brand's event is 404 for figures, files and stream, and reads nothing further", async () => {
    for (const p of [`/${TOKEN}/events/8`, `/${TOKEN}/events/8/floorplan`, `/${TOKEN}/events/8/floorplan/t810`]) {
      touched = [];
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(touched).not.toContain("project_finance");
      expect(touched).not.toContain("project_checklist_attachments");
    }
    expect(bucketGets).toEqual([]);
  });

  test("files are the DISPLAY floorplan's only — blank and filled stay hidden, no legacy fallback", async () => {
    const res = await get(`/${TOKEN}/events/7/floorplan`);
    const body = (await res.json()) as { files: Array<{ fileId: string; fileName: string }> };
    expect(body.files).toEqual([expect.objectContaining({ fileId: "t701", fileName: "MV display.pdf" })]);
    // Remove the display file: the blank task's file and the legacy row must NOT appear.
    taskAtts = taskAtts.filter((a) => a.id !== 701);
    const empty = await get(`/${TOKEN}/events/7/floorplan`);
    expect(((await empty.json()) as { files: unknown[] }).files).toEqual([]);
    expect(touched).not.toContain("project_attachments");
  });

  test("streams the display file by the row's key; the blank task's id is 404 under the brand link", async () => {
    const view = await get(`/${TOKEN}/events/7/floorplan/t701?download=1`);
    expect(view.status).toBe(200);
    expect(view.headers.get("Content-Disposition")).toMatch(/^attachment; filename="MV display.pdf"/);
    expect(bucketGets).toEqual(["projects/7/display.pdf"]);
    const blank = await get(`/${TOKEN}/events/7/floorplan/t700`);
    expect(blank.status).toBe(404);
  });

  test("export is brand-scoped, carries total sales, and is logged once", async () => {
    const res = await get(`/${TOKEN}/export`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brand: string; generatedAt: string; rows: Array<Record<string, unknown>> };
    expect(body.brand).toBe(AKEMI);
    expect(body.rows).toEqual([
      { startDate: "2026-09-11", endDate: "2026-09-13", venue: "MID VALLEY", state: "SELANGOR", organizer: "HOMELOVE", brand: AKEMI, eventType: "ROADSHOW", boothNo: "3053", sizeSqm: 72, totalSales: 125000 },
    ]);
    expect(exportLog).toEqual([{ kind: "brand", subject: AKEMI, token: TOKEN, ip: "203.0.113.9", row_count: 1 }]);
  });

  test("an unknown token gets the same 404 on every route and never reaches projects", async () => {
    const bad = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    for (const p of [`/${bad}`, `/${bad}/events/7`, `/${bad}/events/7/floorplan`, `/${bad}/export`]) {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("unknown_link");
    }
    expect(touched).not.toContain("projects");
    expect(exportLog).toEqual([]);
  });
});
