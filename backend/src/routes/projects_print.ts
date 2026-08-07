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

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `RM ${n.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const STAGE_LABEL: Record<string, string> = {
  draft: "Draft",
  planning: "Planning",
  build: "Build",
  live: "Live",
  teardown: "Teardown",
  closed: "Closed",
  cancelled: "Cancelled",
};

const PAYMENT_LABEL: Record<string, string> = {
  not_started: "Not started",
  deposit_paid: "Deposit paid",
  paid: "Paid in full",
  refund_pending: "Refund pending",
  refunded: "Refunded",
};

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

async function fetchAsDataUri(env: Env, key: string, fallbackMime = "image/png"): Promise<string | null> {
  try {
    const obj = await env.POD_BUCKET.get(key);
    if (!obj) return null;
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
  const hidePayment = !!user && user.position_id != null && !pmsPrint.canPayment;
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
  const activity = (detail.activity as any[]) ?? [];

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
  const profit = totalIncome - totalCost;
  const margin = totalIncome > 0 ? (profit / totalIncome) * 100 : null;
  const rentalTotal = costLines
    .filter((l) => l.category === "rental")
    .reduce((s, l) => s + (l.amount || 0), 0);
  const rentalPerSqm = p.size_sqm && p.size_sqm > 0 ? rentalTotal / p.size_sqm : null;
  const rentalPerDay =
    p.duration_days && p.duration_days > 0 ? rentalTotal / p.duration_days : null;

  // Checklist rollup
  const checklistTotal = checklist.length;
  const checklistDone = checklist.filter((c) => c.status === "done").length;
  const checklistNa = checklist.filter((c) => c.status === "na").length;
  const checklistBlocked = checklist.filter((c) => c.status === "blocked").length;
  const checklistPending = checklistTotal - checklistDone - checklistNa - checklistBlocked;
  const denom = checklistTotal - checklistNa;
  const progressPct = denom > 0 ? Math.round((checklistDone / denom) * 100) : 0;

  // Group cost lines by category for the finance table
  const costByCategory = new Map<string, number>();
  for (const l of costLines) {
    costByCategory.set(l.category, (costByCategory.get(l.category) ?? 0) + (l.amount || 0));
  }
  const incomeByCategory = new Map<string, number>();
  for (const l of incomeLines) {
    incomeByCategory.set(l.category, (incomeByCategory.get(l.category) ?? 0) + (l.amount || 0));
  }

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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Event Summary — ${esc(p.code)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    @page { size: A4; margin: 12mm 10mm 12mm 10mm; }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      font-family: "Google Sans", "Product Sans", "Roboto", Helvetica, Arial, sans-serif;
      color: #000;
      font-size: 10pt;
      line-height: 1.5;
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
    table.sheet > tbody > tr > td { padding: 2mm 10mm 2mm 10mm; }
    table.sheet > tfoot > tr > td { padding: 2mm 10mm 2mm 10mm; }
    table.sheet > tbody > tr.filler > td { padding: 0 !important; height: 100%; }

    /* Letterhead */
    .letterhead {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 4mm;
      border-bottom: 1.5pt solid #000;
    }
    .letterhead .logo { max-height: 46px; max-width: 210px; object-fit: contain; }
    .letterhead .logo-fallback { font-weight: 700; font-size: 18pt; letter-spacing: 1.2pt; text-transform: uppercase; }
    .letterhead .company { text-align: right; font-size: 8.5pt; line-height: 1.4; max-width: 95mm; }
    .letterhead .company .co-name { font-weight: 700; font-size: 10pt; letter-spacing: 0.3pt; text-transform: uppercase; }
    .letterhead .company .reg-no { font-family: "Roboto Mono", monospace; font-size: 8pt; margin-top: 0.5pt; }

    /* Doc title */
    .doc-title {
      margin-top: 4mm;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding-bottom: 2mm;
      border-bottom: 0.5pt solid #000;
    }
    .doc-title h1 {
      margin: 0;
      font-size: 14pt;
      font-weight: 700;
      letter-spacing: 0.6pt;
      text-transform: uppercase;
    }
    .doc-title .ref {
      font-family: "Roboto Mono", monospace;
      font-size: 9pt;
      text-align: right;
    }

    /* Sections */
    section { margin-top: 4mm; }
    section h2 {
      margin: 0 0 1.5mm 0;
      font-size: 9.5pt;
      font-weight: 700;
      letter-spacing: 0.4pt;
      text-transform: uppercase;
      border-bottom: 0.5pt solid #000;
      padding-bottom: 0.5mm;
    }

    /* Two-column label/value grid */
    .kv {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 8mm;
      row-gap: 1mm;
      font-size: 9.5pt;
    }
    .kv .row { display: flex; justify-content: space-between; gap: 4mm; border-bottom: 0.25pt dotted #000; padding: 0.4mm 0; }
    .kv .row .lbl { color: #000; font-weight: 500; }
    .kv .row .val { font-family: "Roboto Mono", monospace; text-align: right; }

    /* Data tables */
    table.data { width: 100%; border-collapse: collapse; font-size: 9pt; margin-top: 1mm; }
    table.data th, table.data td { padding: 1mm 2mm; border-bottom: 0.25pt solid #000; }
    table.data th { text-align: left; font-weight: 700; text-transform: uppercase; font-size: 8pt; letter-spacing: 0.4pt; }
    table.data td.num { text-align: right; font-family: "Roboto Mono", monospace; }
    table.data tr.total td { font-weight: 700; border-top: 1pt solid #000; border-bottom: 0; padding-top: 1.2mm; }

    /* Status chip (B&W — outline only) */
    .chip {
      display: inline-block;
      padding: 0.3mm 1.8mm;
      border: 0.5pt solid #000;
      font-size: 7.5pt;
      letter-spacing: 0.3pt;
      text-transform: uppercase;
      font-weight: 700;
      vertical-align: middle;
    }

    /* Progress bar */
    .bar { width: 100%; height: 2.2mm; border: 0.5pt solid #000; position: relative; }
    .bar .fill { height: 100%; background: #000; }
    .bar .val { position: absolute; right: -14mm; top: -0.5mm; font-family: "Roboto Mono", monospace; font-size: 8.5pt; font-weight: 700; }

    .meta-line { font-size: 8.5pt; color: #000; margin-top: 1mm; }

    .footer-line {
      border-top: 0.5pt solid #000;
      padding-top: 1.5mm;
      font-size: 7.5pt;
      color: #000;
      display: flex;
      justify-content: space-between;
    }

    /* Stack grids responsively — not needed for print, but friendly on screen */
    @media screen and (max-width: 680px) {
      .kv { grid-template-columns: 1fr; }
    }

    ul.inline-list { margin: 0.5mm 0 0 0; padding: 0 0 0 4mm; font-size: 9pt; }
    ul.inline-list li { margin-bottom: 0.4mm; }

    .muted { color: #000; opacity: 0.65; }
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
            <div class="ref">
              ${esc(p.code)}<br>
              Generated ${fmtDateTime(new Date().toISOString())}
            </div>
          </div>
        </td>
      </tr>
    </thead>

    <tbody>
      <tr><td>
        <!-- ── 1. Event overview ─────────────────────────── -->
        <section>
          <h2>1. Event Overview</h2>
          <div class="kv">
            <div class="row"><span class="lbl">Project Code</span><span class="val">${esc(p.code)}</span></div>
            <div class="row"><span class="lbl">Name</span><span class="val">${esc(p.name)}</span></div>
            <div class="row"><span class="lbl">Brand</span><span class="val">${esc(p.brand || "—")}</span></div>
            <div class="row"><span class="lbl">Event Type</span><span class="val">${esc(p.event_type_name || "—")}</span></div>
            <div class="row"><span class="lbl">State</span><span class="val">${esc(p.state || "—")}</span></div>
            <div class="row"><span class="lbl">Venue</span><span class="val">${esc(p.venue || "—")}</span></div>
            <div class="row"><span class="lbl">Organizer</span><span class="val">${esc(p.organizer || "—")}</span></div>
            <div class="row"><span class="lbl">Booth No</span><span class="val">${esc(p.booth_no || "—")}</span></div>
            <div class="row"><span class="lbl">Size (m²)</span><span class="val">${p.size_sqm ?? "—"}</span></div>
            <div class="row"><span class="lbl">Start Date</span><span class="val">${fmtDate(p.start_date)}</span></div>
            <div class="row"><span class="lbl">End Date</span><span class="val">${fmtDate(p.end_date)}</span></div>
            <div class="row"><span class="lbl">Duration</span><span class="val">${p.duration_days ?? "—"} day(s)</span></div>
            <div class="row"><span class="lbl">Current Stage</span><span class="val"><span class="chip">${esc(STAGE_LABEL[p.stage] || p.stage)}</span></span></div>
          </div>
          <div class="meta-line">
            <strong>Progress:</strong>
            <span class="bar" style="display:inline-block;width:40mm;vertical-align:middle;margin:0 18mm 0 2mm">
              <span class="fill" style="width:${progressPct}%"></span>
              <span class="val">${progressPct}%</span>
            </span>
            — ${checklistDone} done / ${checklistPending} pending / ${checklistBlocked} blocked / ${checklistNa} n/a
            ${hidePayment ? "" : `&nbsp;·&nbsp; Payment: <span class="chip">${esc(PAYMENT_LABEL[p.payment_status || "not_started"])}</span>`}
          </div>
        </section>

        <!-- ── 2. Logistics schedule ─────────────────────── -->
        ${
          !hideSetupDismantle && (p.setup_start_at || p.dismantle_start_at)
            ? `<section>
                <h2>2. Logistics Schedule</h2>
                <div class="kv">
                  <div class="row"><span class="lbl">Setup Start</span><span class="val">${fmtDateTime(p.setup_start_at)}</span></div>
                  <div class="row"><span class="lbl">Setup End</span><span class="val">${fmtDateTime(p.setup_end_at)}</span></div>
                  <div class="row"><span class="lbl">Setup Driver</span><span class="val">${esc(p.setup_driver_name || "—")}</span></div>
                  <div class="row"><span class="lbl">Setup Lorry</span><span class="val">${esc(p.setup_lorry_plate || "—")}</span></div>
                  <div class="row"><span class="lbl">Dismantle Start</span><span class="val">${fmtDateTime(p.dismantle_start_at)}</span></div>
                  <div class="row"><span class="lbl">Dismantle End</span><span class="val">${fmtDateTime(p.dismantle_end_at)}</span></div>
                  <div class="row"><span class="lbl">Dismantle Driver</span><span class="val">${esc(p.dismantle_driver_name || "—")}</span></div>
                  <div class="row"><span class="lbl">Dismantle Lorry</span><span class="val">${esc(p.dismantle_lorry_plate || "—")}</span></div>
                </div>
              </section>`
            : ""
        }

        <!-- ── 3. Finance ─────────────────────────────────── -->
        ${hideMoney ? "" : `
        <section>
          <h2>3. Finance</h2>
          <table class="data">
            <thead>
              <tr>
                <th>Category</th>
                <th class="num">Income (RM)</th>
                <th class="num">Cost (RM)</th>
              </tr>
            </thead>
            <tbody>
              ${[...incomeByCategory.entries()]
                .map(
                  ([cat, amt]) => `
                  <tr>
                    <td>${esc(catLabel(cat))}</td>
                    <td class="num">${fmtMoney(amt).replace("RM ", "")}</td>
                    <td class="num">—</td>
                  </tr>`
                )
                .join("")}
              ${[...costByCategory.entries()]
                .map(
                  ([cat, amt]) => `
                  <tr>
                    <td>${esc(catLabel(cat))}</td>
                    <td class="num">—</td>
                    <td class="num">${fmtMoney(amt).replace("RM ", "")}</td>
                  </tr>`
                )
                .join("")}
              <tr class="total">
                <td>Total</td>
                <td class="num">${fmtMoney(totalIncome).replace("RM ", "")}</td>
                <td class="num">${fmtMoney(totalCost).replace("RM ", "")}</td>
              </tr>
            </tbody>
          </table>
          <div class="meta-line">
            <strong>Gross profit:</strong> ${fmtMoney(profit)}
            &nbsp;·&nbsp; <strong>Margin:</strong> ${margin != null ? margin.toFixed(1) + "%" : "—"}
            ${rentalPerSqm != null ? `&nbsp;·&nbsp; <strong>Rental / m²:</strong> ${fmtMoney(rentalPerSqm)}` : ""}
            ${rentalPerDay != null ? `&nbsp;·&nbsp; <strong>Rental / day:</strong> ${fmtMoney(rentalPerDay)}` : ""}
          </div>
        </section>`}

        <!-- ── 4. Sales reports ──────────────────────────── -->
        ${
          !hideMoney && salesReports.length
            ? `<section>
                <h2>4. Sales Reports</h2>
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
                          <td>${r.period_start ? fmtDate(r.period_start) : "—"} — ${r.period_end ? fmtDate(r.period_end) : "—"}</td>
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

        <!-- ── 5. Defects ────────────────────────────────── -->
        ${
          defects.length
            ? `<section>
                <h2>5. Defect Report</h2>
                <div class="meta-line">
                  <strong>${defects.length}</strong> total
                  &nbsp;·&nbsp; Setup: ${setupDefects.length} &nbsp;·&nbsp; Dismantle: ${dismantleDefects.length}
                  &nbsp;·&nbsp; By Sales: ${salesDefects.length} &nbsp;·&nbsp; By Logistic: ${logisticDefects.length}
                </div>
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
                          <td>${esc(d.phase)}</td>
                          <td>${esc(d.reported_by_role)}</td>
                          <td>${esc(d.item_code || d.item_description || "—")}</td>
                          <td>${esc(d.size || "—")}</td>
                          <td class="num">${d.quantity ?? 1}</td>
                          <td>${esc(d.reason || "—")}</td>
                          <td>${d.resolved ? "Resolved" : "Open"}${d.linked_assr_no ? ` · ${esc(d.linked_assr_no)}` : ""}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </section>`
            : ""
        }

        <!-- ── 6. Stock transfer ─────────────────────────── -->
        ${
          stockTransfers.length
            ? `<section>
                <h2>6. Stock Transfer</h2>
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
                          <td>${fmtDateTime(t.transferred_at)}</td>
                          <td>${esc(t.notes || "—")}</td>
                          <td>${t.confirmed_at ? `${fmtDate(t.confirmed_at)} by ${esc(t.confirmed_by_name || "—")}` : "Pending"}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </section>`
            : ""
        }

        <!-- ── 7. Checklist ──────────────────────────────── -->
        ${
          checklist.length
            ? `<section>
                <h2>7. Checklist (${checklistDone}/${checklistTotal - checklistNa} complete)</h2>
                <table class="data">
                  <thead>
                    <tr>
                      <th style="width:40%">Task</th>
                      <th>Owner</th>
                      <th>Due</th>
                      <th>Status</th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${checklist
                      .map(
                        (ci: any) => `
                        <tr>
                          <td>${esc(ci.title)}${ci.required_perm ? ` <span class="muted">(gated)</span>` : ""}</td>
                          <td>${esc(ci.owner_name || "—")}</td>
                          <td>${fmtDate(ci.due_date)}</td>
                          <td>${esc(ci.status)}${ci.review_status ? ` · ${esc(ci.review_status)}` : ""}</td>
                          <td>${ci.completed_at ? `${fmtDate(ci.completed_at)}${ci.completed_by_name ? ` · ${esc(ci.completed_by_name)}` : ""}` : "—"}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </section>`
            : ""
        }

        <!-- ── 8. Activity highlights ─────────────────────── -->
        ${
          activity.length
            ? `<section>
                <h2>8. Activity Highlights</h2>
                <ul class="inline-list">
                  ${activity
                    .slice(0, 15)
                    .map(
                      (a: any) => `
                      <li>
                        <strong>${esc(a.action)}</strong>
                        ${a.from_value || a.to_value ? ` — ${esc(a.from_value || "")} → ${esc(a.to_value || "")}` : ""}
                        ${a.note ? ` · ${esc(a.note)}` : ""}
                        <span class="muted"> · ${esc(a.user_name || "system")} · ${fmtDateTime(a.created_at)}</span>
                      </li>`
                    )
                    .join("")}
                </ul>
              </section>`
            : ""
        }

        ${
          p.notes
            ? `<section>
                <h2>9. Notes</h2>
                <p style="white-space:pre-wrap;margin:0;font-size:9.5pt">${esc(p.notes)}</p>
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
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

export default app;
