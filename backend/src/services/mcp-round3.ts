// ---------------------------------------------------------------------------
// mcp-round3.ts — AI Connector round 3 (owner 2026-11-26): more quick answers
// (outlet_sales, pos_sales, after_sales_summary, attendance_today), the
// daily_brief, and export_excel. Registered from routes/mcp.ts.
//
// RBAC by construction: every read goes through the `read` the route hands in
// (routes/mcp.ts readValue — the in-process GET as the person, then the
// credential strip and redactMoney). Nothing here runs its own SQL or adds a
// permission rule. A read the person may not make (401 / 403) becomes "you
// don't have access to X"; the rest of the answer still comes back.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../types";
import { buildBrief, type BriefRead } from "./mcp-brief";
import { FAQ_INSTRUCTIONS, FAQ_TOOL_NAMES, FAQ_TOOLS, runFaqTool } from "./mcp-faq";
import { EXPORT_KEY_RE, EXPORT_PREFIX, EXPORT_TTL_MS, exportAlive } from "./mcp-actions";
import { myToday } from "./mcp-quick";
import { monthStartOf, pickPosEvents, summariseAfterSales, summariseAttendance, summariseOutletSales, summarisePosEvent, summarisePosSales } from "./mcp-quick2";
import { randomToken } from "./mcp-store";
import { buildXlsx, flattenRow, pickColumns } from "./mcp-xlsx";

type Obj = Record<string, unknown>;
export type R3Read =
  | { ok: true; status: number; value: unknown; removed: string[]; target: string }
  | { ok: false; status: number; message: string; note: string; target: string };
export type R3Ctx = {
  /** One ERP read as the person (routes/mcp.ts readValue with this call's company). */
  read: (path: string, query: Record<string, unknown> | undefined) => Promise<R3Read>;
  origin: string;
  userId: number;
  bucket: Env["POD_BUCKET"];
  now: number;
};
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type R3Outcome = { result: ToolResult; status: number; note: string; target: string };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const refused = (r: R3Read & { ok: false }, target: string, what: string): R3Outcome => ({
  result: text(r.status === 401 || r.status === 403 ? `You don't have access to ${what} in the ERP.` : r.message, true),
  status: r.status,
  note: r.note,
  target,
});
const answer = (v: unknown, target: string): R3Outcome => ({ result: text(JSON.stringify(v)), status: 200, note: "", target });
const asBrief = (r: R3Read): BriefRead => (r.ok ? { ok: true, value: r.value } : { ok: false, status: r.status, message: r.message });

// ── tool definitions ────────────────────────────────────────────────────────

const readOnly = { readOnlyHint: true, openWorldHint: false };
const COMPANY = { type: "string", description: "Which company's data, as for the other tools (default: the person's usual company)" };
const noArgs = { type: "object", properties: { company: COMPANY }, additionalProperties: false };

/** export_excel's lists: the main transaction and master lists, each read page by page as the person. */
export const EXPORT_LISTS: Record<string, { path: string; rowsKey: string; paging: "zero" | "assr" | "none"; search: string; title: string; dates: boolean }> = {
  sales_orders: { path: "/api/scm/mfg-sales-orders", rowsKey: "salesOrders", paging: "zero", search: "q", title: "Sales orders", dates: true },
  delivery_orders: { path: "/api/scm/delivery-orders-mfg", rowsKey: "deliveryOrders", paging: "zero", search: "q", title: "Delivery orders", dates: true },
  sales_invoices: { path: "/api/scm/sales-invoices", rowsKey: "salesInvoices", paging: "zero", search: "q", title: "Sales invoices", dates: true },
  purchase_orders: { path: "/api/scm/mfg-purchase-orders", rowsKey: "purchaseOrders", paging: "zero", search: "q", title: "Purchase orders", dates: true },
  grns: { path: "/api/scm/grns", rowsKey: "grns", paging: "zero", search: "q", title: "Goods received", dates: true },
  service_cases: { path: "/api/assr", rowsKey: "data", paging: "assr", search: "search", title: "Service cases", dates: true },
  suppliers: { path: "/api/scm/suppliers", rowsKey: "suppliers", paging: "none", search: "search", title: "Suppliers", dates: false },
  customers: { path: "/api/scm/other-debtors", rowsKey: "debtors", paging: "none", search: "", title: "Customers", dates: false },
};

export const ROUND3_TOOLS = [
  {
    name: "outlet_sales",
    title: "Sales by outlet today and this month (quick answer)",
    description: "Today's and month-to-date sales orders and sales (RM) for every showroom / outlet, in ONE call. Same numbers as the Sales Report's Sales Order stage.",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "pos_sales",
    title: "Booth POS sales (quick answer)",
    description: "The booth POS (Cash & Carry and fair terminals): today's and month-to-date bills and net sales (RM) for each event on going or ended this month, payment methods and top items. Needs POS Admin access.",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "after_sales_summary",
    title: "Open service cases by status and age (quick answer)",
    description: "Open after-sales service cases (ASSR) in ONE call: count, pending review, past deadline, by stage, by status, by age (0-7, 8-30, 31-90, over 90 days) and the oldest cases with links.",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "attendance_today",
    title: "Who is on leave or absent today (quick answer)",
    description: "Today's HR attendance: who is on leave, absent, late, or has not clocked in yet. HR access only; anyone else is told they have no access.",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "daily_brief",
    title: "What do I need to look at today?",
    description:
      "The signed-in person's own to-do in ONE call: approvals and Mail Center threads waiting for them, their sales orders due for delivery (past or within 3 days), purchase orders past their supplier date, their open service cases, leave requests to approve and unacknowledged announcements. Each with a count and the first 5 with links.",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "export_excel",
    title: "Export a list to Excel",
    description:
      "Export one ERP list as a real .xlsx file (money in RM) and get a download link valid for 15 minutes. Up to 5,000 rows; the reply says when the list was cut. Only what the person may see in the ERP.",
    inputSchema: {
      type: "object",
      properties: {
        list: { type: "string", enum: Object.keys(EXPORT_LISTS), description: "Which list" },
        search: { type: "string", description: "Search text, as typed in the list's search box (a number or a name)" },
        status: { type: "string", description: "Status filter as the list takes it (e.g. CONFIRMED, outstanding)" },
        from: { type: "string", description: "YYYY-MM-DD, document date from (transaction lists)" },
        to: { type: "string", description: "YYYY-MM-DD, document date to (transaction lists)" },
        fields: { type: "array", items: { type: "string" }, description: "Only these columns (e.g. [\"doc_no\",\"debtor_name\",\"total_sen\"]); default all" },
        company: COMPANY,
      },
      required: ["list"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  ...FAQ_TOOLS,
];

const NAMES = new Set(ROUND3_TOOLS.map((t) => t.name));
export const isRound3Tool = (name: string): boolean => NAMES.has(name);
/** The read-only summaries the route may answer from the 30-second cache (services/mcp-ratelimit.ts). */
export const CACHEABLE_TOOLS = new Set(["sales_summary", "delivery_summary", "outlet_sales", "pos_sales", "after_sales_summary", "attendance_today", "daily_brief", ...FAQ_TOOL_NAMES]);

export const ROUND3_INSTRUCTIONS = `- Sales by showroom / outlet today and month to date: outlet_sales. Booth POS sales: pos_sales. Open service cases by status and age: after_sales_summary. Who is on leave or absent today (HR only): attendance_today.
- "What do I need to look at today?": daily_brief. A list as an Excel file: export_excel {list, search, status, from, to, fields}; give the person the download link.
${FAQ_INSTRUCTIONS}`;

// ── quick answers ───────────────────────────────────────────────────────────

async function outletSales(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `outlets:${today}`;
  const r = await ctx.read("/api/scm/reports/fair-report", { stage: "so", date_from: monthStartOf(today), date_to: today });
  if (!r.ok) return refused(r, target, "the Sales Report");
  return answer(summariseOutletSales(r.value, today), target);
}

async function posSales(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `pos:${today}`;
  const ev = await ctx.read("/api/pos-admin/events", undefined);
  if (!ev.ok) return refused(ev, target, "POS Admin");
  const events = pickPosEvents(ev.value, today);
  const reports = await Promise.all(events.map((e) => ctx.read("/api/pos-admin/report", { project_id: e.projectId, from: monthStartOf(today), to: today })));
  const shaped: ReturnType<typeof summarisePosEvent>[] = [];
  const unreadable: string[] = [];
  reports.forEach((r, i) => {
    if (r.ok) shaped.push(summarisePosEvent(events[i], r.value, today));
    else unreadable.push(events[i].name);
  });
  const total = Array.isArray((ev.value as { data?: unknown }).data) ? ((ev.value as { data: unknown[] }).data.length) : 0;
  return answer(summarisePosSales(shaped, unreadable, today, total), target);
}

const ASSR_PAGE = 200;
const ASSR_PAGES_MAX = 3;

async function afterSales(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `after-sales:${today}`;
  const page = (n: number) => ctx.read("/api/assr", { exclude_stage: "completed,voided", per_page: ASSR_PAGE, page: n, sort_by: "id", sort_dir: "asc" });
  const [summary, first] = await Promise.all([ctx.read("/api/assr/summary", undefined), page(1)]);
  if (!first.ok) return refused(first, target, "service cases");
  const total = Number((first.value as { total?: unknown }).total) || 0;
  const rows: Obj[] = [...(((first.value as { data?: unknown }).data as Obj[] | undefined) ?? [])];
  const more = Math.min(ASSR_PAGES_MAX, Math.ceil(total / ASSR_PAGE)) - 1;
  if (more > 0) {
    const rest = await Promise.all(Array.from({ length: more }, (_, i) => page(i + 2)));
    for (const r of rest) if (r.ok) rows.push(...(((r.value as { data?: unknown }).data as Obj[] | undefined) ?? []));
  }
  return answer(summariseAfterSales(summary.ok ? summary.value : null, rows, total, today, ctx.origin), target);
}

async function attendanceToday(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `attendance:${today}`;
  const r = await ctx.read("/api/hr/attendance", { date: today });
  if (!r.ok) return refused(r, target, "HR attendance");
  return answer(summariseAttendance(r.value), target);
}

// ── daily brief ─────────────────────────────────────────────────────────────

export const BRIEF_BADGE_SOURCES = [
  "amendment-approvals",
  "po-amendment-approvals",
  "payment-backdate-approvals",
  "payment-requests-waiting",
  "product-request-approvals",
  "stock-take-approvals",
  "finance-todo",
  "fair-links-to-settle",
  "mail-waiting",
  "meetings-unread",
  "it-support-replies",
];

/** Six reads, all at once (services/mcp-brief.ts lists them). */
async function dailyBrief(ctx: R3Ctx): Promise<R3Outcome> {
  const today = myToday(new Date(ctx.now));
  const target = `brief:${today}`;
  const since = new Date(Date.parse(today) - 180 * 86_400_000).toISOString().slice(0, 10);
  const [badges, salesOrders, purchaseOrders, cases, leave, notices] = await Promise.all([
    ctx.read("/api/badge-counts", { sources: BRIEF_BADGE_SOURCES.join(",") }),
    ctx.read("/api/scm/mfg-sales-orders/mine", { from: since, to: today }),
    ctx.read("/api/scm/mfg-purchase-orders", { page: 0, pageSize: 100, status: "outstanding", sort: "po_date:asc" }),
    ctx.read("/api/assr/my-cases", undefined),
    ctx.read("/api/attendance/leave", undefined),
    ctx.read("/api/announcements/banner", undefined),
  ]);
  const brief = buildBrief(
    { badges: asBrief(badges), salesOrders: asBrief(salesOrders), purchaseOrders: asBrief(purchaseOrders), cases: asBrief(cases), leave: asBrief(leave), notices: asBrief(notices) },
    today,
    ctx.origin,
  );
  return answer(brief, target);
}

// ── export to Excel ─────────────────────────────────────────────────────────

export const EXPORT_MAX_ROWS = 5000;
const PAGE_SIZE: Record<"zero" | "assr", number> = { zero: 100, assr: 200 };
const PAGES_PARALLEL = 4;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The query string a list takes for the person's filters; null + message when a filter is unreadable. */
export function exportQuery(spec: (typeof EXPORT_LISTS)[string], args: Obj): { ok: true; q: Obj } | { ok: false; message: string } {
  const q: Obj = {};
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
  if (s("search")) {
    if (!spec.search) return { ok: false, message: "This list has no search; export it whole and filter in Excel." };
    q[spec.search] = s("search").slice(0, 100);
  }
  if (s("status")) q.status = s("status").slice(0, 40);
  for (const k of ["from", "to"] as const) {
    if (!s(k)) continue;
    if (!spec.dates) return { ok: false, message: "This list has no date filter." };
    if (!YMD.test(s(k))) return { ok: false, message: "Dates are YYYY-MM-DD." };
    q[k] = s(k);
  }
  return { ok: true, q };
}

/** Client-side search for a list the ERP hands over whole (customers): any text field contains the words. */
export function matchesSearch(row: Obj, search: string): boolean {
  const needle = search.toLowerCase();
  return Object.values(row).some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
}

/** Every row the person may see, page by page (4 pages at a time), up to EXPORT_MAX_ROWS. */
export async function fetchAllRows(ctx: R3Ctx, spec: (typeof EXPORT_LISTS)[string], q: Obj): Promise<{ ok: true; rows: Obj[]; truncated: boolean; reads: number } | { ok: false; r: R3Read & { ok: false } }> {
  const rowsOf = (v: unknown): Obj[] => {
    const x = (v as Obj | null)?.[spec.rowsKey];
    return Array.isArray(x) ? (x as Obj[]) : [];
  };
  if (spec.paging === "none") {
    const r = await ctx.read(spec.path, q);
    if (!r.ok) return { ok: false, r };
    const all = rowsOf(r.value);
    return { ok: true, rows: all.slice(0, EXPORT_MAX_ROWS), truncated: all.length > EXPORT_MAX_ROWS, reads: 1 };
  }
  const size = PAGE_SIZE[spec.paging];
  const pageQuery = (n: number): Obj => (spec.paging === "zero" ? { ...q, page: n, pageSize: size } : { ...q, page: n + 1, per_page: size });
  const first = await ctx.read(spec.path, pageQuery(0));
  if (!first.ok) return { ok: false, r: first };
  const rows = rowsOf(first.value);
  const total = Number((first.value as Obj).total) || rows.length;
  const pages = Math.min(Math.ceil(total / size), Math.ceil(EXPORT_MAX_ROWS / size));
  let reads = 1;
  for (let p = 1; p < pages; p += PAGES_PARALLEL) {
    const batch = Array.from({ length: Math.min(PAGES_PARALLEL, pages - p) }, (_, i) => p + i);
    // eslint-disable-next-line no-await-in-loop -- bounded fan-out: 4 in-process page reads at a time, so one export never floods the DB pool
    const got = await Promise.all(batch.map((n) => ctx.read(spec.path, pageQuery(n))));
    reads += got.length;
    for (const g of got) {
      if (!g.ok) return { ok: false, r: g };
      rows.push(...rowsOf(g.value));
    }
  }
  return { ok: true, rows: rows.slice(0, EXPORT_MAX_ROWS), truncated: total > EXPORT_MAX_ROWS || rows.length > EXPORT_MAX_ROWS, reads };
}

async function exportExcel(ctx: R3Ctx, args: Obj): Promise<R3Outcome> {
  const list = String(args.list ?? "");
  const target = `export:${list}`.slice(0, 200);
  const spec = Object.prototype.hasOwnProperty.call(EXPORT_LISTS, list) ? EXPORT_LISTS[list] : null;
  if (!spec) return { result: text(`export_excel takes one of: ${Object.keys(EXPORT_LISTS).join(", ")}.`, true), status: 400, note: "", target };
  const q = exportQuery(spec, args);
  if (!q.ok) return { result: text(q.message, true), status: 400, note: "", target };
  const got = await fetchAllRows(ctx, spec, q.q);
  if (!got.ok) return refused(got.r, target, spec.title.toLowerCase());
  let rows = got.rows.map(flattenRow);
  const search = typeof args.search === "string" ? args.search.trim() : "";
  if (!spec.search && search) rows = rows.filter((r) => matchesSearch(r, search));
  const fields = Array.isArray(args.fields) ? (args.fields as unknown[]).map(String).filter(Boolean).slice(0, 60) : [];
  const cols = pickColumns(rows, fields);
  if (rows.length && !cols.length) return { result: text(`None of those fields are in this list. Try without "fields".`, true), status: 400, note: "", target };
  const bytes = await buildXlsx(spec.title, cols, rows);
  const key = randomToken(32);
  const expiresAt = new Date(ctx.now + EXPORT_TTL_MS).toISOString();
  const today = myToday(new Date(ctx.now));
  const filename = `${list}-${today}.xlsx`;
  await ctx.bucket.put(`${EXPORT_PREFIX}${key}.xlsx`, bytes, {
    httpMetadata: { contentType: XLSX_TYPE },
    customMetadata: { expiresAt, userId: String(ctx.userId), doc: `export:${list}`, filename },
  });
  return {
    result: text(
      JSON.stringify({
        download: `${ctx.origin}/api/mcp/xlsx/${key}`,
        expiresAt,
        rows: rows.length,
        columns: cols.length,
        ...(got.truncated ? { truncated: true, note: `Cut at ${EXPORT_MAX_ROWS} rows. Narrow it with search, status or dates for the rest.` } : {}),
        howTo: "The link downloads the Excel file and works for 15 minutes. Money columns are in RM.",
      }),
    ),
    status: 200,
    note: `${rows.length} rows${got.truncated ? " (truncated)" : ""}, ${got.reads} reads`,
    target: `${target} ${JSON.stringify(q.q)}`.slice(0, 200),
  };
}

/** Run one round-3 tool. */
export async function runRound3Tool(ctx: R3Ctx, name: string, args: Obj): Promise<R3Outcome> {
  switch (name) {
    case "outlet_sales":
      return outletSales(ctx);
    case "pos_sales":
      return posSales(ctx);
    case "after_sales_summary":
      return afterSales(ctx);
    case "attendance_today":
      return attendanceToday(ctx);
    case "daily_brief":
      return dailyBrief(ctx);
    case "export_excel":
      return exportExcel(ctx, args);
    default:
      return runFaqTool(ctx, name, args) ?? { result: text(`Unknown tool: ${name}`, true), status: 400, note: "", target: "" };
  }
}

// ── download ────────────────────────────────────────────────────────────────
// GET /api/mcp/xlsx/:key — an export_excel file, stored 15 minutes under an
// unguessable key (R2 mcp-exports/<key>.xlsx), like get_pdf's printouts. The
// key is the permission: it exists only after the person's own reads succeeded.

export const mcpXlsxDownload = new Hono<{ Bindings: Env }>();
mcpXlsxDownload.get("/:key", async (c) => {
  const key = c.req.param("key");
  const gone = (status: 404 | 410) =>
    new Response("This download link has expired or does not exist. Ask the AI for the export again.\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (!EXPORT_KEY_RE.test(key)) return gone(404);
  const objKey = `${EXPORT_PREFIX}${key}.xlsx`;
  const obj = await c.env.POD_BUCKET.get(objKey);
  if (!obj) return gone(404);
  if (!exportAlive(obj.customMetadata?.expiresAt, Date.now())) {
    await c.env.POD_BUCKET.delete(objKey);
    return gone(410);
  }
  const filename = (obj.customMetadata?.filename ?? "export.xlsx").replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(obj.body, {
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
