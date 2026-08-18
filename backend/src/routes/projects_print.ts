import { Hono } from "hono";
import type { Env } from "../types";
import { getProjectDetail, stripSensitiveChecklist, stripSetupDismantle } from "../services/projects";
import { activeCompanyId } from "../scm/lib/companyScope";
import {
  getBrandingForCompany,
  resolveCompanyCode,
  shortCompanyName,
  brandingAddressLines,
  composeBrandingAddress,
  HOUZS_COMPANY_CODE,
  letterheadLogoKey,
} from "../services/branding";
import { canSeeProject } from "../services/projectAcl";
import { getPmsAccess, isFinanceViewer } from "../services/pmsAccess";
import { scopeSalesReportsForUser } from "../services/orgScope";
import { hasPermission } from "../services/permissions";

/**
 * Post-event summary — A4 printable sheet.
 *
 * Matches the ASSR print view's formal black-and-white style so the
 * same letterhead/footer conventions apply. Content is data-dense:
 * one page for short events, two for busy ones. Intended to be used
 * as a debrief artifact after the event closes.
 */

const app = new Hono<{ Bindings: Env }>();

function esc(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// All printed dates/timestamps render in Malaysia wall-clock time
// (UTC+8). The Worker runs in UTC and the old getUTC* formatting
// printed instants 8 hours behind the office clock (Nick 2026-07-14:
// the printed "Generated" stamp read 8h early). Date-only strings (YYYY-MM-DD)
// parse as UTC midnight, so the +8h shift never moves their calendar day.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    const parts = s.slice(0, 10).split("-");
    if (parts.length === 3 && parts[0].length === 4) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return s.slice(0, 10);
  }
  const shifted = new Date(d.getTime() + MYT_OFFSET_MS);
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = shifted.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  // Setup / dismantle times come from a <input type="datetime-local"> and are
  // stored as naive MYT wall clock ("2026-07-30T11:00") — no zone marker. Those
  // must print exactly as typed; the +8h shift below is only for true instants
  // (created_at & friends, which carry Z / an offset). Before this, an 11:00
  // crew call printed as 19:00 (owner 2026-08-12).
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/.test(s.trim());
  if (naive) {
    const [datePart, timePart] = s.trim().replace("T", " ").split(" ");
    const [yy, mm, dd] = datePart.split("-");
    return `${dd}/${mm}/${yy} ${(timePart || "").slice(0, 5)}`.trim();
  }
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return s.slice(0, 16).replace("T", " ");
  const d = new Date(parsed.getTime() + MYT_OFFSET_MS);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "31 Jul - 2 Aug 2026" / "1 - 3 Aug 2026" / "9 Aug 2026" — the event dates read
// as one line under the title instead of two Start/End fields in the grid
// (owner's reference sheet, 2026-08-12). Date-only strings, no timezone shift.
function fmtRange(a: string | null | undefined, b: string | null | undefined): string {
  const part = (s: string | null | undefined) => {
    if (!s) return null;
    const t = String(s).slice(0, 10).split("-");
    if (t.length !== 3) return null;
    const y = Number(t[0]);
    const m = Number(t[1]);
    const d = Number(t[2]);
    if (!y || !m || !d || m > 12) return null;
    return { y, m, d };
  };
  const s = part(a);
  const e = part(b);
  const one = (x: { y: number; m: number; d: number }) => `${x.d} ${MONTHS[x.m - 1]} ${x.y}`;
  if (!s && !e) return "—";
  if (!s) return one(e!);
  if (!e) return one(s);
  if (s.y === e.y && s.m === e.m && s.d === e.d) return one(s);
  if (s.y !== e.y) return `${one(s)} - ${one(e)}`;
  if (s.m !== e.m) return `${s.d} ${MONTHS[s.m - 1]} - ${e.d} ${MONTHS[e.m - 1]} ${e.y}`;
  return `${s.d} - ${e.d} ${MONTHS[e.m - 1]} ${e.y}`;
}

// ── Crew (projects.setup_crew / dismantle_crew) ─────────────────────
// The logistics form writes a JSON blob, not columns, and it has been through
// three shapes: the current one nests crew under `lorry_crew` (one entry per
// lorry, each with its own drivers/helpers), an older one keeps flat
// drivers/helpers/lorries arrays, and `outsourced` is sometimes {enabled,
// entries[]} and sometimes a single {name, phone, plate}. Parse all of them and
// normalise, or the printed sheet shows an empty crew for most projects (which
// is what it did — owner 2026-08-14).
type CrewPerson = { name: string; phone?: string };
type CrewLorry = { plate?: string; provider?: string; drivers: CrewPerson[]; helpers: CrewPerson[] };
type Crew = {
  lorries: CrewLorry[];
  outsourced: Array<{ name?: string; phone?: string; plate?: string }>;
  remark?: string;
  outsourcedRemark?: string;
};

function asPerson(v: any): CrewPerson | null {
  if (!v) return null;
  if (typeof v === "string") return v.trim() ? { name: v.trim() } : null;
  const name = String(v.name ?? "").trim();
  if (!name) return null;
  const phone = String(v.phone ?? "").trim();
  return phone ? { name, phone } : { name };
}

function asPeople(v: any): CrewPerson[] {
  return (Array.isArray(v) ? v : []).map(asPerson).filter((x): x is CrewPerson => !!x);
}

function parseCrew(raw: unknown): Crew {
  const empty: Crew = { lorries: [], outsourced: [] };
  if (!raw) return empty;
  let data: any = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return empty;
    }
  }
  if (!data || typeof data !== "object") return empty;

  const lorries: CrewLorry[] = [];
  const nested = Array.isArray(data.lorry_crew) ? data.lorry_crew : [];
  for (const entry of nested) {
    if (!entry || typeof entry !== "object") continue;
    lorries.push({
      plate: String(entry.plate ?? "").trim() || undefined,
      provider: String(entry.provider ?? "").trim() || undefined,
      drivers: asPeople(entry.drivers),
      helpers: asPeople(entry.helpers),
    });
  }
  if (!lorries.length) {
    // Flat shape: one lorry carrying every driver / helper, then any extra
    // plates as their own row so nothing is dropped.
    const plates = (Array.isArray(data.lorries) ? data.lorries : [])
      .map((l: any) => String(typeof l === "string" ? l : (l?.plate ?? "")).trim())
      .filter(Boolean);
    const drivers = asPeople(data.drivers);
    const helpers = asPeople(data.helpers);
    if (plates.length || drivers.length || helpers.length) {
      lorries.push({ plate: plates[0], drivers, helpers });
      for (const plate of plates.slice(1)) lorries.push({ plate, drivers: [], helpers: [] });
    }
  }

  const outsourced: Crew["outsourced"] = [];
  const o = data.outsourced;
  if (o && typeof o === "object") {
    const rows = Array.isArray(o.entries) ? o.entries : o.name || o.phone || o.plate ? [o] : [];
    // `enabled: false` with rows still present means the user turned the block
    // off — respect that rather than printing crew they removed.
    if (o.enabled !== false) {
      for (const r of rows) {
        const name = String(r?.name ?? "").trim();
        const phone = String(r?.phone ?? "").trim();
        const plate = String(r?.plate ?? "").trim();
        if (name || phone || plate) outsourced.push({ name, phone, plate });
      }
    }
  }

  return {
    lorries,
    outsourced,
    remark: String(data.remark ?? "").trim() || undefined,
    outsourcedRemark: String(data.outsourced_remark ?? "").trim() || undefined,
  };
}

// Legacy fallback: the projects.* crew columns, still the only source on ~220
// older projects.
function legacyCrew(
  plate: unknown,
  driver: unknown,
  driverPhone: unknown,
  h1: unknown,
  h1Phone: unknown,
  h2: unknown,
  h2Phone: unknown,
): Crew {
  const drivers = [asPerson({ name: driver, phone: driverPhone })].filter(
    (x): x is CrewPerson => !!x,
  );
  const helpers = [asPerson({ name: h1, phone: h1Phone }), asPerson({ name: h2, phone: h2Phone })].filter(
    (x): x is CrewPerson => !!x,
  );
  const p = String(plate ?? "").trim();
  if (!p && !drivers.length && !helpers.length) return { lorries: [], outsourced: [] };
  return { lorries: [{ plate: p || undefined, drivers, helpers }], outsourced: [] };
}

// One crew column: the phase header, then a row per lorry / driver / helper.
function crewColumn(crew: Crew): string {
  const rows: string[] = [];
  const row = (k: string, v: string) =>
    `<div class="lr"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  const person = (x: CrewPerson) =>
    `${esc(x.name)}${x.phone ? ` <span class="tel">${esc(x.phone)}</span>` : ""}`;

  crew.lorries.forEach((l, i) => {
    const label = crew.lorries.length > 1 ? `Lorry ${i + 1}` : "Lorry";
    rows.push(
      row(
        label,
        `<span class="mono">${esc(l.plate || "—")}</span>${l.provider ? ` <span class="tel">${esc(l.provider)}</span>` : ""}`,
      ),
    );
    if (!l.drivers.length) rows.push(row("Driver", "—"));
    l.drivers.forEach((d, n) =>
      rows.push(row(l.drivers.length > 1 ? `Driver ${n + 1}` : "Driver", person(d))),
    );
    l.helpers.forEach((h, n) => rows.push(row(`Helper ${n + 1}`, person(h))));
  });

  crew.outsourced.forEach((o, i) => {
    const parts = [o.name, o.phone ? `<span class="tel">${esc(o.phone)}</span>` : null]
      .filter(Boolean)
      .map((s) => (s === o.name ? esc(String(s)) : String(s)));
    rows.push(
      row(
        crew.outsourced.length > 1 ? `Outsource ${i + 1}` : "Outsource",
        `${parts.join(" ") || "—"}${o.plate ? ` <span class="mono">${esc(o.plate)}</span>` : ""}`,
      ),
    );
  });

  if (crew.remark) rows.push(row("Remark", esc(crew.remark)));
  if (crew.outsourcedRemark) rows.push(row("Outsource Remark", esc(crew.outsourcedRemark)));

  if (!rows.length) rows.push(row("Crew", "Not assigned"));
  return rows.join("");
}

// Ledger category → printed label. cogs_matt_sofa reads "COGS · Matt Sofa".
function costLabel(cat: string): string {
  const c = String(cat || "");
  if (c === "cogs") return "COGS";
  if (c.startsWith("cogs_")) return `COGS · ${catLabelText(c.slice(5))}`;
  return catLabelText(c);
}

function catLabelText(cat: string): string {
  return String(cat || "")
    .split("_")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `RM ${n.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Whole ringgit — the headline strip drops the sen so the four numbers stay on
// one line each at 12pt.
function fmtMoney0(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `RM ${Math.round(n).toLocaleString("en-MY")}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
    );
  }
  return btoa(binary);
}

async function fetchAsDataUri(
  env: Env,
  key: string,
  fallbackMime = "image/png",
  maxBytes?: number,
): Promise<string | null> {
  try {
    const obj = await env.POD_BUCKET.get(key);
    if (!obj) return null;
    // Site photos come straight off a phone camera and can run to several MB;
    // base64 adds a third on top. Skip anything oversized rather than build a
    // 20MB page the browser then has to print (owner 2026-08-12).
    if (maxBytes != null && typeof obj.size === "number" && obj.size > maxBytes) {
      console.warn(`[print] skipped ${key}: ${obj.size} bytes > ${maxBytes}`);
      return null;
    }
    const buf = new Uint8Array(await obj.arrayBuffer());
    const mime = obj.httpMetadata?.contentType || fallbackMime;
    return `data:${mime};base64,${bytesToBase64(buf)}`;
  } catch (e) {
    console.warn(`[print] failed to load ${key}`, e);
    return null;
  }
}

app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.text("Invalid ID", 400);

  // Multi-company: same active-company gate as the detail JSON — a
  // cross-company id prints "Not found".
  const detail = await getProjectDetail(c.env, id, activeCompanyId(c));
  if (!detail) return c.text("Not found", 404);

  // Row-level ACL — this debrief bypassed canSeeProject before, so any
  // authenticated user could print any project id. Enforce the same gate the
  // detail JSON uses.
  const user = (c as any).get("user");
  // Mirror the detail-GET read gate: PIC line + brand + grace (canSeeProject)
  // OR a scoped rep on the project's Sales Attending list (attendee arm, mig
  // 087). Keeps the printable debrief in lockstep with what the list surfaces
  // and the detail JSON opens. Dual-read rep_user_id (pg driver camelCases).
  const isPrintAttendee =
    !!user?.id &&
    ((detail as any).sales_attendees ?? []).some(
      (a: any) => (a.rep_user_id ?? a.repUserId) === user.id
    );
  if (user && !canSeeProject(user, detail.project as any) && !isPrintAttendee) {
    return c.text("Not found", 404);
  }
  // Section-level finance/payment gate (Sales-department visibility, rules 3 &
  // 5). Non-director positions must not see money in the printable debrief
  // either — the JSON endpoint strips it, so must this. Gated on position_id
  // to match the detail-GET rollout rule (un-migrated users keep legacy access).
  const pmsPrint = getPmsAccess(user, detail.project as any);
  const hideMoney = !!user && user.position_id != null && !pmsPrint.canFinancial;
  // Quotation / Agreement (WF_SENSITIVE) are DIRECTOR-only (rule 5) — strip
  // those checklist rows from the debrief for a non-director position, the
  // same server-side backstop as the detail JSON.
  const hideSensitive = !!user && user.position_id != null && !pmsPrint.canSensitive;
  // Setup & Dismantle (owner 2026-07-15) — the crew JSON + "SETUP & DISMANTLE
  // DOCUMENTS" checklist rows are hidden from non-director Sales (even the PIC)
  // in the detail JSON, so strip them from the printable debrief too.
  const hideSetupDismantle = !!user && user.position_id != null && !pmsPrint.canSetupDismantle;
  let scoped: any = hideSensitive ? stripSensitiveChecklist(detail as any) : detail;
  if (hideSetupDismantle) scoped = stripSetupDismantle(scoped);

  const p = detail.project as any;
  const finance = detail.finance as any;
  const lines = (detail.finance_lines as any[]) ?? [];
  const checklist = (scoped.checklist as any[]) ?? [];
  const defects = (detail.defects as any[]) ?? [];
  // Sales-reports row scoping (owner 2026-07) — mirror the detail-GET rule so
  // the printable debrief never leaks another rep's sale amounts. Non-director
  // sales users see only their own + downline rows (rep identity = uploaded_by);
  // directors + service-case managers see all. Fail closed on unresolved reps.
  const printGranted = user?.permissions_set ?? user?.permissions ?? [];
  const canSeeAllSalesReports =
    isFinanceViewer(user) || hasPermission(printGranted, "service_cases.manage");
  const salesReports = await scopeSalesReportsForUser(
    c.env,
    user?.id,
    (detail.sales_reports as any[]) ?? [],
    canSeeAllSalesReports,
  );
  const stockTransfers = (detail.stock_transfers as any[]) ?? [];

  // ── Company identity (per-company branding) ─────────────────
  // Letterhead / footer come from the DOCUMENT's company. `projects` has no
  // company_id column yet (PMS is Houzs-only today) — read it if the row ever
  // grows one, else fall back to the request's active company, then HOUZS.
  const companyCode = await resolveCompanyCode(
    c.env,
    p.company_id ?? c.get("companyCode"),
  );
  const branding = await getBrandingForCompany(c.env, companyCode);
  const coShort = shortCompanyName(branding.companyName);
  const coAddressLines = brandingAddressLines(composeBrandingAddress(branding));

  // Uploaded per-company letterhead logo wins; the bundled Houzs wordmark is
  // HOUZS-only; otherwise the text fallback renders the company name.
  // letterheadLogoKey: the dedicated print logo when one is uploaded, else the
  // on-screen one (the app chrome is dark, paper is white — see Branding).
  const printLogoKey = letterheadLogoKey(branding);
  const logoUri = printLogoKey
    ? await fetchAsDataUri(c.env, printLogoKey)
    : companyCode === HOUZS_COMPANY_CODE
      ? await fetchAsDataUri(c.env, "static/logo-wordmark.png")
      : null;

  // ── Finance rollups from the ledger ─────────────────────
  const incomeLines = lines.filter((l) => l.kind === "income");
  const costLines = lines.filter((l) => l.kind === "cost");
  const totalIncome = incomeLines.reduce((s, l) => s + (l.amount || 0), 0);
  const totalCost = costLines.reduce((s, l) => s + (l.amount || 0), 0);
  const rentalTotal = costLines
    .filter((l) => l.category === "rental")
    .reduce((s, l) => s + (l.amount || 0), 0);
  const rentalPerSqm = p.size_sqm && p.size_sqm > 0 ? rentalTotal / p.size_sqm : null;
  const rentalPerDay =
    p.duration_days && p.duration_days > 0 ? rentalTotal / p.duration_days : null;

  // ── Headline finance numbers (owner's reference sheet, 2026-08-12) ──
  // Event sales live in TWO places: per-day ledger lines and the lump
  // project_finance.total_sales box. A project has one or the other (older
  // months only have the lump), so take the larger rather than adding them —
  // summing would double-count every project that has both.
  const salesTotal = Math.max(totalIncome, Number(finance?.total_sales) || 0);
  // Gross profit stops at cost of goods; net profit carries every cost line
  // (rental, contractor, transport…), which is why the two differ on the sheet.
  const cogsTotal = costLines
    .filter((l) => String(l.category || "").startsWith("cogs"))
    .reduce((s, l) => s + (l.amount || 0), 0);
  const grossProfit = salesTotal - cogsTotal;
  const netProfit = salesTotal - totalCost;
  const margin = salesTotal > 0 ? (netProfit / salesTotal) * 100 : null;

  // Checklist rollup — the progress bar / done-pending-blocked-n/a strip was
  // dropped from the sheet (owner 2026-08-12); the section heading still shows
  // "done / countable" so the totals live there.
  const checklistTotal = checklist.length;
  const checklistDone = checklist.filter((c) => c.status === "done").length;
  const checklistNa = checklist.filter((c) => c.status === "na").length;

  // Group cost lines by category for the finance table
  const costByCategory = new Map<string, number>();
  for (const l of costLines) {
    costByCategory.set(l.category, (costByCategory.get(l.category) ?? 0) + (l.amount || 0));
  }
  const incomeByCategory = new Map<string, number>();
  for (const l of incomeLines) {
    incomeByCategory.set(l.category, (incomeByCategory.get(l.category) ?? 0) + (l.amount || 0));
  }
  // Cost ladder for the Finance Snapshot: cogs buckets, then everything else.
  const cogsRows = [...costByCategory.entries()].filter(([cat]) =>
    String(cat || "").startsWith("cogs"),
  );
  const otherRows = [...costByCategory.entries()].filter(
    ([cat]) => !String(cat || "").startsWith("cogs"),
  );
  // Rental reads better as a rate — "(RM 158/m²/day)" beside the amount.
  const rentalRate =
    rentalTotal > 0 && p.size_sqm > 0 && p.duration_days > 0
      ? rentalTotal / (p.size_sqm * p.duration_days)
      : null;
  const rentalNote = rentalRate != null ? `RM ${Math.round(rentalRate)}/m²/day` : null;

  // Defect counts
  const setupDefects = defects.filter((d) => d.phase === "setup");
  const dismantleDefects = defects.filter((d) => d.phase === "dismantle");
  const salesDefects = defects.filter((d) => d.reported_by_role === "sales");
  const logisticDefects = defects.filter((d) => d.reported_by_role === "logistic");

  // Sales report sum
  const salesReportTotal = salesReports.reduce((s, r) => s + (r.sales_amount || 0), 0);

  function catLabel(cat: string): string {
    return cat
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // Raw enum values (done / in_review / na / setup / logistic …) printed as
  // words — the sheet used to carry the database spelling straight through.
  function nice(v: unknown): string {
    const t = String(v ?? "").trim();
    if (!t) return "—";
    if (t.toLowerCase() === "na") return "N/A";
    return t
      .replace(/[_-]+/g, " ")
      .split(" ")
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(" ");
  }

  // ── What appears when printing (owner 2026-08-12) ───────────────
  // Keys: overview, finance, logistics, photos, sales, defects, stock,
  // checklist, notes.
  // `?sections=overview,finance,checklist` prints ONLY those blocks. Absent =
  // everything the caller is allowed to see (unchanged behaviour, so existing
  // links and the plain Print button keep working). The permission strips
  // (hideMoney / hideSetupDismantle) still win — this can only ever REMOVE
  // sections, never reveal one the user may not see.
  const sectionsParam = (c.req.query("sections") || "").trim();
  const wanted = new Set(
    sectionsParam
      ? sectionsParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [],
  );
  const want = (key: string): boolean => wanted.size === 0 || wanted.has(key);
  // Sections are numbered as they RENDER, so hiding one no longer leaves a gap
  // (the report used to read 1, 2, 3, 7 because the numbers were hardcoded and
  // empty sections just vanished). Each h2 calls this once, in document order.
  let _secNo = 0;
  const secNo = (): number => ++_secNo;

  // ── Checklist grouped by its sections (mig 050) ─────────────────
  // The sheet used to print one flat 6-column table; the owner's reference
  // layout groups tasks under their section band with a per-section count.
  // Sections that end up empty (all rows stripped by a permission gate, or
  // simply unused on this project) are skipped, so no orphan bands print.
  const sectionRows = ((scoped as any).sections as any[]) ?? [];
  const clGroups: Array<{ name: string; items: any[]; done: number; denom: number }> = [];
  const pushGroup = (name: string, items: any[]) => {
    if (!items.length) return;
    const na = items.filter((ci) => ci.status === "na").length;
    clGroups.push({
      name,
      items,
      done: items.filter((ci) => ci.status === "done").length,
      denom: items.length - na,
    });
  };
  for (const s of sectionRows) {
    pushGroup(s.name, checklist.filter((ci) => ci.section_id === s.id));
  }
  const knownSectionIds = new Set(sectionRows.map((s) => s.id));
  pushGroup(
    "Other",
    checklist.filter((ci) => !ci.section_id || !knownSectionIds.has(ci.section_id)),
  );

  // Crew for both phases: the JSON blob the logistics form writes, falling back
  // to the older projects.* columns when it is empty.
  const setupCrewJson = parseCrew(p.setup_crew);
  const dismantleCrewJson = parseCrew(p.dismantle_crew);
  const setupCrew = setupCrewJson.lorries.length || setupCrewJson.outsourced.length
    ? setupCrewJson
    : legacyCrew(
        p.setup_lorry_plate,
        p.setup_driver_name,
        p.setup_driver_phone,
        p.setup_helper_1_name,
        p.setup_helper_1_phone,
        p.setup_helper_2_name,
        p.setup_helper_2_phone,
      );
  const dismantleCrew = dismantleCrewJson.lorries.length || dismantleCrewJson.outsourced.length
    ? dismantleCrewJson
    : legacyCrew(
        p.dismantle_lorry_plate,
        p.dismantle_driver_name,
        p.dismantle_driver_phone,
        p.dismantle_helper_1_name,
        p.dismantle_helper_1_phone,
        p.dismantle_helper_2_name,
        p.dismantle_helper_2_phone,
      );

  // ── Setup / dismantle photos (owner's reference sheet, 2026-08-12) ──
  // One picture per phase, taken from the first image attached to the phase's
  // checklist task. Behind the same gate as the crew details: a user who cannot
  // see Setup & Dismantle does not get the photos either.
  const taskPhotoRows = ((detail as any).checklist_attachments as any[]) ?? [];
  const titleById = new Map<number, string>(
    checklist.map((ci: any) => [ci.id, String(ci.title || "").toLowerCase()]),
  );
  const findPhoto = (match: (title: string) => boolean) => {
    for (const a of taskPhotoRows) {
      const itemId = a.item_id ?? a.itemId;
      const title = titleById.get(itemId);
      if (!title || !match(title)) continue;
      const key = a.r2_key ?? a.r2Key;
      const mime = String(a.content_type ?? a.contentType ?? "");
      const name = String(a.file_name ?? a.fileName ?? "");
      const looksImage = mime.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(name);
      if (!key || !looksImage) continue;
      return { key: String(key), mime: mime || "image/jpeg" };
    }
    return null;
  };
  const PHOTO_MAX_BYTES = 4_000_000;
  const wantPhotos = want("photos") && !hideSetupDismantle;
  const setupShot = wantPhotos ? findPhoto((t) => t.includes("setup image")) : null;
  const dismantleShot = wantPhotos
    ? findPhoto((t) => t.includes("dismantle image")) ??
      findPhoto((t) => t.includes("event complete"))
    : null;
  const [setupPhotoUri, dismantlePhotoUri] = await Promise.all([
    setupShot ? fetchAsDataUri(c.env, setupShot.key, setupShot.mime, PHOTO_MAX_BYTES) : null,
    dismantleShot
      ? fetchAsDataUri(c.env, dismantleShot.key, dismantleShot.mime, PHOTO_MAX_BYTES)
      : null,
  ]);

  // Status pill palette — done green, waiting amber, blocked red, n/a grey.
  function pillClass(status: string, review?: string | null): string {
    const s = String(status || "").toLowerCase();
    if (s === "done") return "ok";
    if (s === "na") return "na";
    if (s === "blocked") return "bad";
    if (review) return "wait";
    return "wait";
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Event Summary — ${esc(p.code)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    /* Layout follows the owner's reference sheet (2026-08-12): label-above-value
       cells four to a row, a KPI strip for finance, and the checklist grouped
       under section bands with coloured status pills. */
    @page { size: A4; margin: 12mm 10mm 12mm 10mm; }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    :root {
      --ink: #1a1f29;
      --muted: #7b8290;
      --line: #dcdfe3;
      --band: #eef0f2;
      --ok-bg: #e3f5e8;
      --ok-fg: #145c2c;
      --wait-bg: #fdf3d6;
      --wait-fg: #6b4e00;
      --bad-bg: #fde4e1;
      --bad-fg: #8c1d18;
      --na-bg: #f1f2f0;
      --na-fg: #5f6368;
    }
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      font-family: "Google Sans", "Product Sans", "Roboto", Helvetica, Arial, sans-serif;
      color: var(--ink);
      font-size: 9pt;
      line-height: 1.45;
      background: #fff;
      -webkit-font-smoothing: antialiased;
    }
    table.sheet { width: 210mm; margin: 0 auto; border-collapse: collapse; background: #fff; height: 100%; }
    table.sheet td, table.sheet th { padding: 0; }
    table.sheet > tbody > tr > td { vertical-align: top; }
    @media screen {
      body { background: #d9d6cf; padding: 24px 0; height: auto; min-height: 100%; }
      table.sheet { box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 12px 36px rgba(0,0,0,0.14); min-height: 297mm; }
    }
    @media print {
      body { background: #fff !important; }
      table.sheet { box-shadow: none !important; margin: 0 !important; width: 100% !important; }
    }
    table.sheet > thead > tr > td { padding: 2mm 10mm 3mm 10mm; }
    table.sheet > tbody > tr > td { padding: 0 10mm 2mm 10mm; }
    table.sheet > tfoot > tr > td { padding: 2mm 10mm 2mm 10mm; }
    table.sheet > tbody > tr.filler > td { padding: 0 !important; height: 100%; }

    /* Letterhead */
    .letterhead {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 3mm;
      border-bottom: 0.75pt solid var(--ink);
    }
    .letterhead .logo { max-height: 44px; max-width: 200px; object-fit: contain; }
    .letterhead .logo-fallback { font-weight: 700; font-size: 17pt; letter-spacing: 1.2pt; text-transform: uppercase; }
    .letterhead .company { text-align: right; font-size: 7.3pt; line-height: 1.42; max-width: 95mm; color: var(--muted); }
    .letterhead .company .co-name { font-weight: 700; font-size: 9.5pt; letter-spacing: 0.3pt; text-transform: uppercase; color: var(--ink); }
    .letterhead .company .reg-no { font-family: "Roboto Mono", monospace; font-size: 7pt; }

    /* Title + event identity */
    .doc-title {
      margin-top: 3.5mm;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 6mm;
    }
    .doc-title h1 {
      margin: 0;
      font-size: 15pt;
      font-weight: 700;
      letter-spacing: 0.5pt;
      text-transform: uppercase;
    }
    .doc-title .ref { font-size: 7.3pt; color: var(--muted); text-align: right; white-space: nowrap; }
    /* Hero band — event identity reversed out of the dark ink, with the PIC on
       a green tag (owner's second reference sheet, 2026-08-12). */
    .hero {
      margin-top: 3mm;
      background: var(--ink);
      color: #fff;
      padding: 3mm 4mm;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 5mm;
    }
    .hero .h-name { font-size: 13pt; font-weight: 700; line-height: 1.2; }
    .hero .h-meta { font-size: 8.5pt; margin-top: 1.2mm; color: #c7cdd8; }
    .hero .h-pic {
      background: #2f6f4f;
      color: #fff;
      font-size: 8.5pt;
      font-weight: 700;
      padding: 1.2mm 3mm;
      border-radius: 1mm;
      white-space: nowrap;
    }

    /* Headline money strip — leads the Finance Snapshot section (owner
       2026-08-18; previously sat under the hero band in the page header) */
    .kpi { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: #f7f8f6; margin: 1mm 0 1.5mm; }
    .kpi .kc { padding: 2.2mm 3mm; border-left: 0.5pt solid var(--line); min-width: 0; }
    .kpi .kc:first-child { border-left: 0; }
    .kpi .kc .k {
      font-size: 6.6pt;
      font-weight: 700;
      letter-spacing: 0.55pt;
      text-transform: uppercase;
      color: var(--muted);
    }
    .kpi .kc .v { font-size: 12pt; font-weight: 700; font-family: "Roboto Mono", monospace; }
    .kpi .kc .v.neg { color: var(--bad-fg); }

    /* Finance snapshot — cost ladder with sub-totals */
    table.fin { width: 100%; border-collapse: collapse; font-size: 8.3pt; margin-top: 1mm; }
    table.fin td { padding: 0.7mm 0; border-bottom: 0.5pt dotted var(--line); }
    table.fin td.amt { text-align: right; font-family: "Roboto Mono", monospace; white-space: nowrap; }
    table.fin tr.sum td { font-weight: 700; border-top: 0.5pt solid var(--ink); border-bottom: 0; }

    /* Logistics — setup left, dismantle right */
    .logi { display: grid; grid-template-columns: 1fr 1fr; column-gap: 6mm; margin-top: 1.5mm; }
    .logi .col.right { border-left: 0.5pt solid var(--line); padding-left: 6mm; }
    .logi .col-head {
      font-size: 8.5pt;
      font-weight: 700;
      letter-spacing: 0.3pt;
      padding-bottom: 1mm;
      border-bottom: 0.5pt solid var(--line);
    }
    .logi .lr { display: grid; grid-template-columns: 17mm minmax(0, 1fr); padding: 0.9mm 0; border-bottom: 0.5pt dotted var(--line); }
    .logi .lr .k {
      font-size: 6.4pt;
      font-weight: 700;
      letter-spacing: 0.5pt;
      text-transform: uppercase;
      color: var(--muted);
      align-self: center;
    }
    .logi .lr .v { font-size: 8.6pt; font-weight: 700; overflow-wrap: anywhere; }
    .logi .lr .v .tel { font-weight: 400; color: var(--muted); font-family: "Roboto Mono", monospace; font-size: 7.6pt; }

    /* Setup / dismantle photos, two up */
    .shots { display: grid; grid-template-columns: 1fr 1fr; column-gap: 6mm; margin-top: 1.5mm; }
    .shots figure { margin: 0; }
    .shots figcaption {
      font-size: 7.5pt;
      color: var(--muted);
      padding-bottom: 1mm;
    }
    .shots img {
      width: 100%;
      max-height: 62mm;
      object-fit: cover;
      border: 0.5pt solid var(--line);
      display: block;
    }
    .shots .none {
      border: 0.5pt dashed var(--line);
      height: 24mm;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 7.5pt;
      color: var(--muted);
    }

    /* Sections */
    section { margin-top: 4mm; }
    section h2 {
      margin: 0;
      font-size: 9.3pt;
      font-weight: 700;
      letter-spacing: 0.5pt;
      text-transform: uppercase;
      break-after: avoid;
      page-break-after: avoid;
    }
    section h2 + .sub, section .sub { font-size: 7.6pt; color: var(--muted); }
    section .rule { border-top: 0.75pt solid var(--ink); margin-top: 1mm; }

    /* Label-above-value cells, four to a row */
    .cells { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); column-gap: 5mm; }
    .cells.six { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .cell { padding: 1.5mm 0 1.4mm 0; border-bottom: 0.5pt solid var(--line); min-width: 0; }
    .cell .k {
      font-size: 6.6pt;
      font-weight: 700;
      letter-spacing: 0.55pt;
      text-transform: uppercase;
      color: var(--muted);
    }
    .cell .v { font-size: 9pt; font-weight: 700; overflow-wrap: anywhere; }
    .cell .v.mono { font-family: "Roboto Mono", monospace; font-size: 8.5pt; }
    .cell .v .sub2 { display: block; font-size: 7.4pt; font-weight: 400; color: var(--muted); }
    .cell .v.neg { color: var(--bad-fg); }
    .cell.blank { border-bottom: 0; }
    .cell.span2 { grid-column: span 2; }

    /* Data tables */
    table.data { width: 100%; border-collapse: collapse; font-size: 8.2pt; margin-top: 1mm; }
    table.data th, table.data td { padding: 1mm 1.6mm 1mm 0; border-bottom: 0.5pt solid var(--line); vertical-align: top; }
    table.data thead { display: table-header-group; }
    table.data th {
      text-align: left;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 6.6pt;
      letter-spacing: 0.55pt;
      color: var(--muted);
      border-bottom: 0.5pt solid var(--line);
    }
    table.data tr { break-inside: avoid; page-break-inside: avoid; }
    table.data th.num, table.data td.num { text-align: right; padding-right: 0; }
    table.data td.num, table.data td.mono { font-family: "Roboto Mono", monospace; }
    table.data tr.total td { font-weight: 700; border-top: 0.75pt solid var(--ink); border-bottom: 0; }
    /* Section band inside the checklist table */
    table.data tr.grp td {
      background: var(--band);
      font-weight: 700;
      font-size: 7.2pt;
      letter-spacing: 0.6pt;
      text-transform: uppercase;
      padding: 1.2mm 1.6mm;
      border-bottom: 0;
    }
    table.data tr.grp td.cnt { text-align: right; font-family: "Roboto Mono", monospace; letter-spacing: 0; color: #4a5060; }

    /* Status pills */
    .pill {
      display: inline-block;
      padding: 0.6mm 1.6mm;
      border-radius: 1mm;
      font-size: 6.6pt;
      font-weight: 700;
      letter-spacing: 0.4pt;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .pill.ok { background: var(--ok-bg); color: var(--ok-fg); }
    .pill.wait { background: var(--wait-bg); color: var(--wait-fg); }
    .pill.bad { background: var(--bad-bg); color: var(--bad-fg); }
    .pill.na { background: var(--na-bg); color: var(--na-fg); }

    .meta-line { font-size: 7.8pt; color: var(--muted); margin-top: 1.2mm; }
    .notes-body { white-space: pre-wrap; margin: 1.5mm 0 0 0; font-size: 8.6pt; }

    .footer-line {
      border-top: 0.5pt solid var(--line);
      padding-top: 1.5mm;
      font-size: 6.8pt;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      gap: 6mm;
    }

    .muted { color: var(--muted); font-weight: 400; }

    @media screen and (max-width: 680px) {
      .cells { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    /* Screen-only section picker — ticks decide what lands on the paper. Built
       from the sections that actually rendered, so a user only ever sees blocks
       they are allowed to print (owner 2026-08-12). */
    .picker {
      width: 210mm;
      max-width: 100%;
      margin: 0 auto 10px auto;
      background: #fff;
      border: 1px solid #b9b5ad;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 14px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    }
    .picker strong { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.6px; }
    .picker label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; white-space: nowrap; }
    .picker .spacer { flex: 1 1 auto; }
    .picker button {
      font: inherit;
      padding: 4px 12px;
      border: 1px solid var(--ink);
      background: var(--ink);
      color: #fff;
      border-radius: 4px;
      cursor: pointer;
    }
    .picker button.ghost { background: #fff; color: var(--ink); }
    section.off { display: none !important; }
    @media print { .picker { display: none !important; } }
  </style>
</head>
<body>
  <table class="sheet">
    <thead>
      <tr>
        <td>
          <div class="letterhead">
            ${
              logoUri
                ? `<img class="logo" src="${logoUri}" alt="${esc(coShort)}">`
                : `<div class="logo-fallback">${esc(coShort)}</div>`
            }
            <div class="company">
              <div class="co-name">${esc(branding.companyName)}</div>
              ${branding.registrationNo ? `<div class="reg-no">${esc(branding.registrationNo)}</div>` : ""}
              ${coAddressLines.map((l) => `<div>${esc(l)}</div>`).join("")}
            </div>
          </div>
          <div class="doc-title">
            <h1>Event Summary Report</h1>
            <div class="ref">Generated ${fmtDateTime(new Date().toISOString())}</div>
          </div>
          <div class="hero">
            <div>
              <div class="h-name">${esc(p.name)}</div>
              <!-- Title + dates only (owner 2026-08-14) — booth, brand, event
                   type and the code all repeat further down the sheet. -->
              <div class="h-meta">${esc(fmtRange(p.start_date, p.end_date))}</div>
            </div>
            ${p.pic_name ? `<div class="h-pic">PIC · ${esc(p.pic_name)}</div>` : ""}
          </div>
          <!-- KPI strip moved INTO the Finance Snapshot section (owner
               2026-08-18: "finance should not be below the title. event over
               view after title.") — the header now ends at the hero band and
               Event Overview is the first thing after it. -->
        </td>
      </tr>
    </thead>

    <tbody>
      <tr><td>
        <!-- ── Event overview ────────────────────────────── -->
        ${
          want("overview")
            ? `<section data-sec="overview" data-label="Event Overview">
          <h2><span class="sn">${secNo()}.</span> Event Overview</h2>
          <div class="rule"></div>
          <!-- Brand / event type / state / organizer / venue removed (owner
               2026-08-18: "becoz already ahve in balck card" — the hero title
               is "STATE [BRAND] ORGANIZER @ VENUE"), so the grid carries only
               what the title cannot: booth, duration, size. -->
          <div class="cells">
            <div class="cell"><div class="k">Booth No.</div><div class="v mono">${esc(p.booth_no || "—")}</div></div>
            <div class="cell"><div class="k">Duration</div><div class="v">${p.duration_days ?? "—"} day(s)</div></div>
            <div class="cell"><div class="k">Size (sqm)</div><div class="v mono">${p.size_sqm ?? "—"}</div></div>
            <!-- Status / Stage / Payment removed from the sheet (owner
                 2026-08-14) — workflow state belongs on screen, not on the
                 printed debrief. -->
          </div>
        </section>`
            : ""
        }

        <!-- ── Finance snapshot ──────────────────────────── -->
        <!-- Headline KPI strip first (moved down from the header band, owner
             2026-08-18), then the cost ladder: every cogs bucket, a COGS
             sub-total, the rest of the ledger and Total Cost. -->
        ${hideMoney || !want("finance") ? "" : `
        <section data-sec="finance" data-label="Finance Snapshot">
          <h2><span class="sn">${secNo()}.</span> Finance Snapshot</h2>
          <div class="rule"></div>
          <div class="kpi">
            <div class="kc"><div class="k">Total Sales</div><div class="v">${fmtMoney0(salesTotal)}</div></div>
            <div class="kc"><div class="k">Gross Profit</div><div class="v${grossProfit < 0 ? " neg" : ""}">${fmtMoney0(grossProfit)}</div></div>
            <div class="kc"><div class="k">Net Profit</div><div class="v${netProfit < 0 ? " neg" : ""}">${fmtMoney0(netProfit)}</div></div>
            <div class="kc"><div class="k">Margin</div><div class="v${margin != null && margin < 0 ? " neg" : ""}">${margin != null ? margin.toFixed(1) + "%" : "—"}</div></div>
          </div>
          <table class="fin">
            <tbody>
              ${cogsRows
                .map(
                  ([cat, amt]) => `
                  <tr>
                    <td>${esc(costLabel(cat))}</td>
                    <td class="amt">${fmtMoney(amt)}</td>
                  </tr>`
                )
                .join("")}
              ${
                cogsRows.length > 1
                  ? `<tr class="sum">
                      <td>COGS Total</td>
                      <td class="amt">${fmtMoney(cogsTotal)}</td>
                    </tr>`
                  : ""
              }
              ${otherRows
                .map(
                  ([cat, amt]) => `
                  <tr>
                    <td>${esc(costLabel(cat))}${cat === "rental" && rentalNote ? ` <span class="muted">(${esc(rentalNote)})</span>` : ""}</td>
                    <td class="amt">${fmtMoney(amt)}</td>
                  </tr>`
                )
                .join("")}
              <tr class="sum">
                <td>Total Cost</td>
                <td class="amt">${fmtMoney(totalCost)}</td>
              </tr>
            </tbody>
          </table>
        </section>`}

        <!-- ── Logistics schedule ────────────────────────── -->
        <!-- Setup left, dismantle right, each with lorry, driver and helpers +
             their phone numbers so the sheet works on site. -->
        ${
          want("logistics") && !hideSetupDismantle && (p.setup_start_at || p.dismantle_start_at)
            ? `<section data-sec="logistics" data-label="Logistics Schedule">
                <h2><span class="sn">${secNo()}.</span> Logistics Schedule</h2>
                <div class="rule"></div>
                <div class="logi">
                  <div class="col">
                    <div class="col-head">SETUP · ${fmtDateTime(p.setup_start_at)}${p.setup_end_at ? ` → ${fmtDateTime(p.setup_end_at)}` : ""}</div>
                    ${crewColumn(setupCrew)}
                  </div>
                  <div class="col right">
                    <div class="col-head">DISMANTLE · ${fmtDateTime(p.dismantle_start_at)}${p.dismantle_end_at ? ` → ${fmtDateTime(p.dismantle_end_at)}` : ""}</div>
                    ${crewColumn(dismantleCrew)}
                  </div>
                </div>
              </section>`
            : ""
        }

        <!-- ── Setup & dismantle photos ──────────────────── -->
        ${
          setupPhotoUri || dismantlePhotoUri
            ? `<section data-sec="photos" data-label="Setup &amp; Dismantle Photos">
                <h2><span class="sn">${secNo()}.</span> Setup &amp; Dismantle Photos</h2>
                <div class="rule"></div>
                <div class="shots">
                  <figure>
                    <figcaption>Setup${p.setup_start_at ? ` · ${fmtDate(p.setup_start_at)}` : ""}</figcaption>
                    ${
                      setupPhotoUri
                        ? `<img src="${setupPhotoUri}" alt="Setup photo">`
                        : `<div class="none">No setup photo attached</div>`
                    }
                  </figure>
                  <figure>
                    <figcaption>Dismantle${p.dismantle_start_at ? ` · ${fmtDate(p.dismantle_start_at)}` : ""}</figcaption>
                    ${
                      dismantlePhotoUri
                        ? `<img src="${dismantlePhotoUri}" alt="Dismantle photo">`
                        : `<div class="none">No dismantle photo attached</div>`
                    }
                  </figure>
                </div>
              </section>`
            : ""
        }

        <!-- ── Sales reports ─────────────────────────────── -->
        ${
          want("sales") && !hideMoney && salesReports.length
            ? `<section data-sec="sales" data-label="Sales Reports">
                <h2><span class="sn">${secNo()}.</span> Sales Reports</h2>
                <div class="rule"></div>
                <table class="data">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Period</th>
                      <th class="num">Amount (RM)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${salesReports
                      .map(
                        (r: any) => `
                        <tr>
                          <td>${esc(r.title || "—")}</td>
                          <td class="mono">${r.period_start ? fmtDate(r.period_start) : "—"} — ${r.period_end ? fmtDate(r.period_end) : "—"}</td>
                          <td class="num">${r.sales_amount != null ? fmtMoney(r.sales_amount).replace("RM ", "") : "—"}</td>
                        </tr>`
                      )
                      .join("")}
                    <tr class="total">
                      <td colspan="2">Total</td>
                      <td class="num">${fmtMoney(salesReportTotal).replace("RM ", "")}</td>
                    </tr>
                  </tbody>
                </table>
              </section>`
            : ""
        }

        <!-- ── Defects ───────────────────────────────────── -->
        ${
          want("defects") && defects.length
            ? `<section data-sec="defects" data-label="Defect Report">
                <h2><span class="sn">${secNo()}.</span> Defect Report</h2>
                <div class="sub">${defects.length} total · Setup: ${setupDefects.length} · Dismantle: ${dismantleDefects.length} · By Sales: ${salesDefects.length} · By Logistic: ${logisticDefects.length}</div>
                <div class="rule"></div>
                <table class="data">
                  <thead>
                    <tr>
                      <th>Phase</th>
                      <th>Role</th>
                      <th>Item</th>
                      <th>Size</th>
                      <th class="num">Qty</th>
                      <th>Reason</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${defects
                      .map(
                        (d: any) => `
                        <tr>
                          <td>${nice(d.phase)}</td>
                          <td>${nice(d.reported_by_role)}</td>
                          <td>${esc(d.item_code || d.item_description || "—")}</td>
                          <td>${esc(d.size || "—")}</td>
                          <td class="num">${d.quantity ?? 1}</td>
                          <td>${esc(d.reason || "—")}</td>
                          <td><span class="pill ${d.resolved ? "ok" : "wait"}">${d.resolved ? "Resolved" : "Open"}</span>${d.linked_assr_no ? ` <span class="muted">${esc(d.linked_assr_no)}</span>` : ""}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </section>`
            : ""
        }

        <!-- ── Stock transfer ────────────────────────────── -->
        ${
          want("stock") && stockTransfers.length
            ? `<section data-sec="stock" data-label="Stock Transfer">
                <h2><span class="sn">${secNo()}.</span> Stock Transfer</h2>
                <div class="rule"></div>
                <table class="data">
                  <thead>
                    <tr>
                      <th>Direction</th>
                      <th>When</th>
                      <th>Notes</th>
                      <th>Confirmed</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${stockTransfers
                      .map(
                        (t: any) => `
                        <tr>
                          <td>${t.direction === "out" ? "OUT" : "RETURN"}</td>
                          <td class="mono">${fmtDateTime(t.transferred_at)}</td>
                          <td>${esc(t.notes || "—")}</td>
                          <td>${t.confirmed_at ? `${fmtDate(t.confirmed_at)} · ${esc(t.confirmed_by_name || "—")}` : `<span class="pill wait">Pending</span>`}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </section>`
            : ""
        }

        <!-- ── Checklist, grouped by section ─────────────── -->
        ${
          want("checklist") && checklist.length
            ? `<section data-sec="checklist" data-label="Checklist">
                <h2><span class="sn">${secNo()}.</span> Checklist</h2>
                <div class="sub">${checklistDone}/${checklistTotal - checklistNa} complete · ${checklistTotal} tasks total</div>
                <div class="rule"></div>
                <table class="data">
                  <thead>
                    <tr>
                      <th style="width:44%">Task</th>
                      <th>Due</th>
                      <th>Status</th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${clGroups
                      .map(
                        (g) => `
                        <tr class="grp">
                          <td colspan="3">${esc(g.name)}</td>
                          <td class="cnt">${g.done}/${g.denom}</td>
                        </tr>
                        ${g.items
                          .map(
                            (ci: any) => `
                            <tr>
                              <td>${esc(ci.title)}${ci.required_perm ? ` <span class="muted">(gated)</span>` : ""}</td>
                              <td class="mono">${fmtDate(ci.due_date)}</td>
                              <td><span class="pill ${pillClass(ci.status, ci.review_status)}">${nice(ci.status)}${ci.review_status ? ` · ${nice(ci.review_status)}` : ""}</span></td>
                              <td>${ci.completed_at ? `<span class="mono">${fmtDate(ci.completed_at)}</span>${ci.completed_by_name ? ` · ${esc(ci.completed_by_name)}` : ""}` : "—"}</td>
                            </tr>`
                          )
                          .join("")}`
                      )
                      .join("")}
                  </tbody>
                </table>
              </section>`
            : ""
        }

        <!-- Activity Highlights dropped (owner 2026-08-12) — the audit trail is
             noise on a printed debrief and pushed the sheet onto a second page.
             It stays available in the on-screen project timeline. -->

        ${
          want("notes") && p.notes
            ? `<section data-sec="notes" data-label="Notes">
                <h2><span class="sn">${secNo()}.</span> Notes</h2>
                <div class="rule"></div>
                <p class="notes-body">${esc(p.notes)}</p>
              </section>`
            : ""
        }
      </td></tr>
      <tr class="filler"><td></td></tr>
    </tbody>

    <tfoot>
      <tr>
        <td>
          <div class="footer-line">
            <span>${esc(branding.companyName)} · This is a computer-generated document; no signature is required.</span>
            <span>${esc(p.code)}</span>
          </div>
        </td>
      </tr>
    </tfoot>
  </table>

  <script>
    // Auto-print removed — user can Ctrl/Cmd+P when ready.
    //
    // Section picker: tick / untick what appears when printing. Choices are
    // remembered per browser, so the next report opens the same way. Section
    // numbers are renumbered on every toggle — hiding one never leaves a gap
    // (the sheet used to read 1, 2, 3, 7).
    (function () {
      var KEY = "houzs.print.sections.v1";
      var secs = Array.prototype.slice.call(document.querySelectorAll("section[data-sec]"));
      if (!secs.length) return;

      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { saved = {}; }

      function renumber() {
        var n = 0;
        for (var i = 0; i < secs.length; i++) {
          if (secs[i].classList.contains("off")) continue;
          n += 1;
          var sn = secs[i].querySelector("h2 .sn");
          if (sn) sn.textContent = n + ".";
        }
      }

      var bar = document.createElement("div");
      bar.className = "picker";
      var lead = document.createElement("strong");
      lead.textContent = "Print sections";
      bar.appendChild(lead);

      var boxes = [];
      secs.forEach(function (sec) {
        var key = sec.getAttribute("data-sec");
        var on = saved[key] !== false;
        sec.classList.toggle("off", !on);
        var lab = document.createElement("label");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = on;
        cb.addEventListener("change", function () {
          sec.classList.toggle("off", !cb.checked);
          saved[key] = cb.checked;
          try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
          renumber();
        });
        boxes.push(cb);
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(sec.getAttribute("data-label") || key));
        bar.appendChild(lab);
      });

      var spacer = document.createElement("span");
      spacer.className = "spacer";
      bar.appendChild(spacer);

      var all = document.createElement("button");
      all.type = "button";
      all.className = "ghost";
      all.textContent = "Select all";
      all.addEventListener("click", function () {
        boxes.forEach(function (cb) {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change")); }
        });
      });
      bar.appendChild(all);

      var pr = document.createElement("button");
      pr.type = "button";
      pr.textContent = "Print";
      pr.addEventListener("click", function () { window.print(); });
      bar.appendChild(pr);

      document.body.insertBefore(bar, document.body.firstChild);
      renumber();
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

export default app;
