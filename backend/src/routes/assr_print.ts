import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { getAssrDetail } from "../services/assr";
import {
  getBrandingForCompany,
  resolveCompanyCode,
  shortCompanyName,
  brandingAddressLines,
  composeBrandingAddress,
  HOUZS_COMPANY_CODE,
} from "../services/branding";

// Formal service-case document modeled on a standard Malaysian business
// invoice/service report:
//   · Letterhead with company name, registration no., and address
//   · Plain document title + reference metadata
//   · Two-column labeled customer / service details (no boxes)
//   · Minimal itemised list separated by horizontal rules
//   · Plain numbered sections
//   · Black & white, light use of a single accent rule
// No coloured backgrounds, no pills, no zebra rows, no decorative blocks.
//
// Three variants share the same chrome; differ in which sections they
// include and what extras (tracker SVG, QR code, acknowledgement) ride
// along. Variant chosen via `?variant=customer|supplier|office`.
// Default `office` preserves the legacy single-template behaviour.

const app = new Hono<{ Bindings: Env }>();

type Variant = "office" | "customer" | "supplier";

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

const STAGE_LABEL: Record<string, string> = {
  pending_review: "Pending Review",
  under_verification: "Under Verification",
  pending_solution: "Pending Solution",
  pending_supplier_pickup: "Supplier Pickup / Return",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Pending Delivery / Service",
  completed: "Completed",
  registration: "Pending Review",
  triage: "Under Verification",
  action: "Pending Solution",
  logistics: "Pending Item Pickup",
  resolution: "Pending Delivery / Service",
  closed: "Completed",
};

const RESOLUTION_LABEL: Record<string, string> = {
  replace_unit: "Replace Unit",
  supplier_repair: "Supplier Repair (Workshop)",
  field_service_own: "Field Service (Own Team)",
  field_service_supplier: "Field Service (Supplier)",
  return_visit: "Return Visit",
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

/**
 * Compute the on-paper "Target Completion" for the supplier variant.
 * Uses `stage_entered_at + stage_target_days` for the case's CURRENT
 * stage — i.e. the supplier sees how long they've got from now to
 * the next handoff, not the case's e2e deadline.
 */
function supplierTargetDateIso(stageEnteredAt: string | null, stageTargetDays: number | null | undefined): string | null {
  if (!stageEnteredAt || !stageTargetDays) return null;
  const iso = stageEnteredAt.endsWith("Z") ? stageEnteredAt : stageEnteredAt + "Z";
  const t0 = new Date(iso).getTime();
  if (isNaN(t0)) return null;
  return new Date(t0 + stageTargetDays * 24 * 60 * 60 * 1000).toISOString();
}

app.get("/:id", requirePermission("service_cases.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.text("Invalid ID", 400);

  const rawVariant = (c.req.query("variant") || "office").toLowerCase();
  const variant: Variant =
    rawVariant === "customer" ? "customer"
    : rawVariant === "supplier" ? "supplier"
    : "office";
  const isCustomer = variant === "customer";
  const isSupplier = variant === "supplier";
  const isOffice = variant === "office";

  const detail = await getAssrDetail(c.env, id);
  if (!detail) return c.text("Not found", 404);

  const { case: cs, items, attachments, activity, logistics } = detail;

  // ── Company identity (per-company branding) ─────────────────
  // Letterhead / footer / inline labels come from the DOCUMENT's company —
  // the case row's company_id (a 2990 case must print 2990's identity no
  // matter which company the operator has active). Fallback: the request's
  // active company, then HOUZS.
  const companyCode = await resolveCompanyCode(
    c.env,
    (cs as any).company_id ?? c.get("companyCode"),
  );
  const branding = await getBrandingForCompany(c.env, companyCode);
  const coShort = shortCompanyName(branding.companyName);
  const coAddressLines = brandingAddressLines(composeBrandingAddress(branding));
  // Warehouse/CS contact line: the historical HOUZS CS number is not part of
  // the Branding config, so HOUZS keeps its literal (unchanged output); other
  // companies show their branding phone (blank → line renders without one).
  const csPhone = companyCode === HOUZS_COMPANY_CODE ? "011-6155 6133" : branding.phone;

  // Uploaded per-company letterhead logo wins; the bundled Houzs wordmark is
  // HOUZS-only (it must never head another company's paper); otherwise the
  // text fallback renders the company name.
  const logoUri = branding.logoR2Key
    ? await fetchAsDataUri(c.env, branding.logoR2Key)
    : companyCode === HOUZS_COMPANY_CODE
      ? await fetchAsDataUri(c.env, "static/logo-wordmark.png")
      : null;

  const imageAttachments = attachments.filter((a: any) =>
    (a.content_type || "").startsWith("image/")
  );
  const otherAttachments = attachments.filter(
    (a: any) => !(a.content_type || "").startsWith("image/")
  );
  // Customer print hides only attachments staff EXPLICITLY marked
  // internal (visible_to_customer = 0). The column's D1-era default was
  // 1 (show), but the Postgres cut-over dropped that default so every
  // upload since lands as NULL — treating NULL as hidden silently
  // stripped all photos from the customer copy. NULL/undefined now
  // means "not hidden" → visible, matching the original intent.
  // Supplier print shows everything; office sees the lot.
  const showImage = (a: any): boolean => {
    if (isOffice) return true;
    if (isCustomer) return a.visible_to_customer !== 0 && a.visible_to_customer !== false;
    return true; // supplier
  };
  const inlinedImages: Array<{ category: string; file_name: string | null; data_url: string }> = [];
  for (const att of imageAttachments as any[]) {
    if (!showImage(att)) continue;
    const uri = await fetchAsDataUri(c.env, att.r2_key as string, att.content_type || "image/jpeg");
    if (!uri) continue;
    inlinedImages.push({
      category: String(att.category ?? ""),
      file_name: att.file_name ? String(att.file_name) : null,
      data_url: uri,
    });
  }

  // Nick 2026-07-03: customer print follows the boxed ASSR Form too —
  // all three sheets share the strict-B&W boxed design, so the colour
  // tracker, QR panel, and notice layout are gone from print. Customers
  // reach the portal via the track-link message instead.

  // Supplier variant — derive the target-completion date for the
  // current stage from the snapshotted `stage_target_days`.
  const supplierTargetIso = isSupplier
    ? supplierTargetDateIso((cs as any).stage_entered_at, (cs as any).stage_target_days)
    : null;

  const docTitle =
    isSupplier ? "Supplier Service Order" : "After-Sales Service Request";

  const docSubtitle =
    isCustomer ? "Customer Copy"
    : isSupplier ? "Supplier Copy — for acknowledgement"
    : "";

  // Status pills (design: two outlined pills top-right). SERVICE maps
  // the resolution method to a service-location bucket; STATUS is the
  // workflow stage. Both render static — change in-app and reprint.
  const servicePillLabel = (() => {
    const m = cs.resolution_method;
    if (m === "field_service_own" || m === "field_service_supplier") return "At Customer";
    if (m === "replace_unit" || m === "supplier_repair") return "Return to Supplier";
    if (m === "return_visit") return "Internal (own team)";
    return "—";
  })();
  const statusPillLabel = STAGE_LABEL[cs.stage] || cs.stage;
  // Switchable sub-status (mig 0116) — the supplier copy shows it as a
  // second pill so the workshop sees where inside the stage the case
  // sits (e.g. Pending Supplier Return = bring it back).
  const SUB_STATUS_LABEL: Record<string, string> = {
    pending_inspection: "Pending Inspection",
    qc_issue_result: "QC Issue Result",
    pending_supplier_pickup: "Pending Supplier Pickup",
    pending_supplier_return: "Pending Supplier Return",
  };
  const subStatusLabel = SUB_STATUS_LABEL[(cs as any).sub_status ?? ""] || null;

  // Warehouse — auto-detected from the case's delivery area (location
  // code) via the SCM State-to-Warehouse mapping (scm.state_warehouse_
  // mappings, company-scoped, configurable in SCM settings), so the
  // supplier copy shows which warehouse the item moves through. Falls
  // back to the legacy public.warehouses code table, then em-dash.
  // Wrapped in try/catch: the D1 test mirror has no scm schema.
  const LOCATION_STATE: Record<string, string> = {
    KL: "Kuala Lumpur",
    PG: "Pulau Pinang",
    SBH: "Sabah",
    SRW: "Sarawak",
  };
  let warehouseLabel: string | null = null;
  const locCode = String((cs as any).location || "").toUpperCase();
  if (locCode) {
    try {
      const stateName = LOCATION_STATE[locCode] ?? null;
      if (stateName) {
        const row = await c.env.DB.prepare(
          `SELECT w.code AS code
             FROM scm.state_warehouse_mappings m
             JOIN scm.warehouses w ON w.id = m.warehouse_id
            WHERE m.state = ? AND m.company_id = ?
            LIMIT 1`
        )
          .bind(stateName, Number((cs as any).company_id ?? 1))
          .first<{ code: string }>();
        warehouseLabel = row?.code ?? null;
      }
      if (!warehouseLabel) {
        const row = await c.env.DB.prepare(
          `SELECT code FROM warehouses WHERE code = ? LIMIT 1`
        )
          .bind(locCode)
          .first<{ code: string }>();
        warehouseLabel = row?.code ?? null;
      }
    } catch {
      warehouseLabel = null;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(docTitle)} — ${esc(cs.assr_no)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    @page { size: A4; margin: 12mm 10mm 12mm 10mm; }

    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    html, body { margin: 0; padding: 0; }

    body {
      font-family: "Google Sans", "Product Sans", "Roboto", "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: #000;
      font-size: 10pt;
      line-height: 1.5;
      background: #fff;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    table.sheet {
      width: 210mm;
      margin: 0 auto;
      border-collapse: collapse;
      background: #fff;
    }
    table.sheet td,
    table.sheet th { padding: 0; }

    html, body { height: 100%; }
    table.sheet { height: 100%; }
    table.sheet > tbody > tr > td { vertical-align: top; }

    @media screen {
      body { background: #d9d6cf; padding: 24px 0; height: auto; min-height: 100%; }
      table.sheet {
        box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 12px 36px rgba(0,0,0,0.14);
        min-height: 297mm;
        height: 297mm;
      }
    }
    @media print {
      body { background: #fff !important; }
      table.sheet {
        box-shadow: none !important;
        margin: 0 !important;
        width: 100% !important;
      }
    }

    table.sheet > thead > tr > td { padding: 2mm 10mm 3mm 10mm; }
    table.sheet > tbody > tr > td { padding: 2mm 10mm 2mm 10mm; }
    table.sheet > tfoot > tr > td { padding: 2mm 10mm 2mm 10mm; }
    table.sheet > tbody > tr.filler > td { padding: 0 !important; height: 100%; }

    .letterhead {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 4mm;
      border-bottom: 1.5pt solid #000;
    }
    .letterhead .logo { max-height: 46px; max-width: 210px; object-fit: contain; display: block; }
    .letterhead .logo-fallback { font-weight: 700; font-size: 18pt; letter-spacing: 1.2pt; color: #000; text-transform: uppercase; }
    .letterhead .company { text-align: right; font-size: 8.5pt; line-height: 1.4; color: #000; max-width: 95mm; }
    .letterhead .company .co-name { font-weight: 700; font-size: 10pt; letter-spacing: 0.3pt; text-transform: uppercase; }
    .letterhead .company .reg-no { font-family: "Roboto Mono", monospace; font-size: 8pt; margin-top: 0.5pt; }

    /* Design refresh — Plex Serif for the document title, left-aligned
       to sit next to the report meta on the right (the header row is
       still centered by the parent .doc-title container). */
    .doc-title { text-align: left; margin: 0 0 8mm 0; }
    .doc-title h1 { margin: 0; font-family: "IBM Plex Serif", "Georgia", serif; font-size: 22pt; font-weight: 700; letter-spacing: 0.2pt; line-height: 1.05; }
    .doc-title .subtitle { margin-top: 2mm; font-family: "Roboto Mono", monospace; font-size: 8.5pt; letter-spacing: 1.5pt; text-transform: uppercase; color: #555; }
    .doc-title .ref { margin-top: 3mm; font-family: "Roboto Mono", monospace; font-size: 11pt; color: #333; white-space: nowrap; }
    .doc-title .ref b { font-size: 12.5pt; }

    /* Info strip with optional QR panel on the side */
    .info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10mm;
      margin-bottom: 8mm;
    }
    .info.with-qr {
      grid-template-columns: 1fr 1fr 38mm;
    }
    .info .col .label {
      font-size: 8pt; letter-spacing: 1pt; text-transform: uppercase; color: #555;
      border-bottom: 0.5pt solid #000; padding-bottom: 1.5mm; margin-bottom: 2.5mm; font-weight: 700;
    }
    .info .col .line {
      display: flex; gap: 4mm; padding: 2mm 0; border-bottom: 0.4pt solid #d0d0d0; font-size: 10pt;
    }
    .info .col .line:last-child { border-bottom: none; }
    .info .col .line .k { flex: 0 0 26mm; color: #555; }
    .info .col .line .v { flex: 1; color: #000; font-weight: 500; }
    .info .col .name-line { font-size: 11pt; font-weight: 700; margin-bottom: 1mm; }

    .qr-panel {
      border: 0.6pt solid #000; padding: 3mm; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 2mm;
    }
    .qr-panel .qr-cap {
      font-size: 7.5pt; letter-spacing: 1pt; text-transform: uppercase; color: #555; font-weight: 700;
    }
    .qr-panel .qr-svg { width: 32mm; height: 32mm; }
    .qr-panel .qr-svg svg { width: 100%; height: 100%; display: block; }
    .qr-panel .qr-url { font-family: "Roboto Mono", monospace; font-size: 6.5pt; word-break: break-all; line-height: 1.3; color: #333; }

    section { margin-top: 7mm; page-break-inside: avoid; }
    h2.sec {
      font-size: 9.5pt; font-weight: 700; letter-spacing: 2pt; text-transform: uppercase;
      margin: 0 0 3mm 0; padding-bottom: 2mm; border-bottom: 0.8pt solid #000;
    }

    .items { width: 100%; border-collapse: collapse; }
    .items th { text-align: left; font-size: 8pt; letter-spacing: 1pt; text-transform: uppercase; font-weight: 700; padding: 2mm 2mm; color: #555; border-bottom: 0.4pt solid #d0d0d0; }
    .items td { font-size: 10pt; padding: 2mm 2mm; border-bottom: 0.4pt solid #d0d0d0; vertical-align: top; }
    .items tr:last-child td { border-bottom: 0.4pt solid #d0d0d0; }
    .items .num { text-align: right; font-variant-numeric: tabular-nums; font-family: "Roboto Mono", monospace; }
    .items .code { font-family: "Roboto Mono", monospace; font-size: 9.5pt; }

    .rows .row { display: flex; gap: 4mm; padding: 2mm 0; border-bottom: 0.4pt solid #d0d0d0; font-size: 10pt; }
    .rows .row:last-child { border-bottom: none; }
    .rows .row .k { flex: 0 0 48mm; color: #555; }
    .rows .row .v { flex: 1; color: #000; font-weight: 500; }
    .rows .row .v.mono { font-family: "Roboto Mono", monospace; }
    .rows-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10mm; }
    .rows-2col .row .k { flex-basis: 38mm; }

    .para { margin-top: 2mm; font-size: 10pt; line-height: 1.6; }
    .para .cap { font-size: 8pt; font-weight: 700; letter-spacing: 1pt; text-transform: uppercase; color: #555; margin-bottom: 1mm; }
    .para .body { white-space: pre-line; }

    .photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; }
    .photo { border: 0.5pt solid #000; page-break-inside: avoid; }
    .photo img { width: 100%; height: 44mm; object-fit: cover; display: block; }
    .photo .cap { padding: 2mm 2mm; font-size: 7.5pt; letter-spacing: 0.8pt; text-transform: uppercase; color: #555; border-top: 0.4pt solid #000; text-align: center; }

    .timeline .entry { display: grid; grid-template-columns: 40mm 1fr; gap: 5mm; padding: 2mm 0; border-bottom: 0.4pt solid #d0d0d0; font-size: 10pt; page-break-inside: avoid; }
    .timeline .entry:last-child { border-bottom: none; }
    .timeline .when { font-family: "Roboto Mono", monospace; font-size: 8.5pt; color: #333; }
    .timeline .who { font-weight: 700; color: #000; margin-right: 3pt; }

    .total-line { margin-top: 4mm; display: flex; justify-content: flex-end; }
    .total-line .row { display: flex; justify-content: space-between; gap: 18mm; min-width: 80mm; padding: 2mm 0; border-top: 1pt solid #000; border-bottom: 1.5pt solid #000; font-size: 11pt; font-weight: 700; letter-spacing: 0.5pt; text-transform: uppercase; }
    .total-line .v { font-family: "Roboto Mono", monospace; }

    /* Supplier-only PO banner — highlighted across the page */
    .po-banner {
      display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 4mm;
      padding: 3mm 4mm; border: 1.5pt solid #000; margin-top: 4mm;
    }
    .po-banner .col .k {
      font-size: 7.5pt; letter-spacing: 1pt; text-transform: uppercase; color: #555; font-weight: 700;
    }
    .po-banner .col .v {
      font-family: "Roboto Mono", monospace; font-size: 12pt; font-weight: 700; margin-top: 1mm;
    }
    .po-banner .col.deadline .v { color: #b91c1c; }

    /* Supplier-only acknowledgement section */
    .ack { margin-top: 8mm; page-break-inside: avoid; }
    .ack .check-row {
      display: flex; align-items: center; gap: 6mm; padding: 3mm 0;
      border-bottom: 0.4pt solid #d0d0d0; font-size: 10pt;
    }
    .ack .check-row .box {
      width: 5mm; height: 5mm; border: 1pt solid #000; flex-shrink: 0;
    }
    .ack .sig-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10mm 14mm; margin-top: 6mm;
    }
    .ack .sig-grid .sig {
      border-top: 0.6pt solid #000; padding-top: 1.5mm;
      font-size: 8pt; letter-spacing: 1pt; text-transform: uppercase; color: #555; font-weight: 700;
    }
    .ack .sig-grid .sig-box {
      height: 18mm; border-bottom: 0.6pt solid #000;
    }

    /* Design refresh — dual sign-off block for the customer + supplier
       variants. Two side-by-side panels; each has bullet checkboxes
       for what the counter-party is confirming, then a signature line
       and a name+date row. Black-and-white only; prints cleanly on
       mono printers. */
    .signoff {
      margin-top: 8mm; page-break-inside: avoid;
      display: grid; grid-template-columns: 1fr 1fr; border: 0.6pt solid #000;
    }
    .signoff .panel { padding: 5mm 6mm 6mm; }
    .signoff .panel + .panel { border-left: 0.6pt solid #000; }
    .signoff .panel h3 {
      margin: 0 0 4mm 0; font-family: "IBM Plex Serif", "Georgia", serif;
      font-size: 12pt; font-weight: 700;
    }
    .signoff .check {
      display: flex; align-items: flex-start; gap: 4mm; margin-bottom: 3.5mm;
      font-size: 10pt; line-height: 1.4;
    }
    .signoff .check .box {
      width: 4.5mm; height: 4.5mm; border: 0.8pt solid #000; flex-shrink: 0; margin-top: 0.6mm;
    }
    .signoff .sig-rule {
      border-top: 0.6pt solid #000; margin-top: 6mm; padding-top: 2mm;
    }
    .signoff .sig-rule .cap {
      font-family: "Roboto Mono", monospace; font-size: 7.5pt;
      letter-spacing: 0.8pt; text-transform: uppercase; color: #6a6a6a; font-weight: 700;
    }
    .signoff .name-date {
      display: flex; gap: 6mm; margin-top: 6mm;
    }
    .signoff .name-date .cell {
      flex: 1; border-bottom: 0.5pt solid #666; padding-bottom: 1.5mm;
    }
    .signoff .name-date .cell .cap {
      font-family: "Roboto Mono", monospace; font-size: 7.5pt;
      letter-spacing: 0.8pt; text-transform: uppercase; color: #6a6a6a; font-weight: 700;
    }

    /* ── Boxed-grid document language (design handoff: Service Print
       Copies). Black section bars, grey label cells + white value
       cells with hairline rules, outlined chips. B&W only. ── */
    .bar {
      background: #141414; color: #fff;
      font-family: "IBM Plex Serif", "Georgia", serif;
      font-size: 10.5pt; font-weight: 600; letter-spacing: 0.5pt;
      padding: 1.8mm 3.6mm; margin-top: 5mm;
    }
    .bar .note { font-family: "IBM Plex Sans", sans-serif; font-size: 7.5pt; font-weight: 400; color: #b8bdb5; letter-spacing: 0; }
    .mgrid { display: grid; border-left: 0.4pt solid #d5d5d5; }
    .mgrid.cols-6 { grid-template-columns: 27mm 1fr 27mm 1fr 27mm 1fr; }
    .mgrid.cols-4 { grid-template-columns: 27mm 1fr 27mm 1fr; }
    .mgrid.cols-8 { grid-template-columns: 22mm 1fr 18mm 1fr 20mm 1fr 17mm 1fr; }
    .mgrid.rule-top { border-top: 1pt solid #141414; }
    .mgrid .lc {
      padding: 2.4mm 2.8mm; background: #f3f3f1;
      border-right: 0.4pt solid #d5d5d5; border-bottom: 0.4pt solid #d5d5d5;
      font-size: 8pt; color: #5a5a5a; font-weight: 600; line-height: 1.35;
    }
    .mgrid .vc {
      padding: 2.4mm 2.8mm;
      border-right: 0.4pt solid #d5d5d5; border-bottom: 0.4pt solid #d5d5d5;
      font-size: 8.8pt; font-weight: 600; line-height: 1.45;
      display: flex; align-items: center; flex-wrap: wrap;
    }
    .mgrid .vc.mono { font-family: "IBM Plex Mono", "Roboto Mono", monospace; }
    .mgrid .vc.dim { color: #b0b0b0; font-weight: 400; }
    .mgrid .span3 { grid-column: span 3; }
    .mgrid .span5 { grid-column: span 5; }
    .chip {
      font-family: "IBM Plex Mono", "Roboto Mono", monospace; font-size: 8.5pt; font-weight: 700;
      border: 1.1pt solid #141414; padding: 0.4mm 2.4mm; border-radius: 0.8mm;
    }
    .pill-cat { font-size: 8.5pt; font-weight: 700; border: 0.7pt solid #141414; padding: 0.6mm 2.8mm; border-radius: 3.2mm; }
    .status-pills { display: flex; gap: 2.4mm; flex-shrink: 0; }
    /* Customer/office header: Status sits beside Service, Sub-Status stacks
       under Status (col 2, row 2). Supplier copy keeps the plain flex row. */
    .status-pills.stacked { display: grid; grid-template-columns: auto auto; align-items: start; }
    .status-pills.stacked .p-service   { grid-column: 1; grid-row: 1; }
    .status-pills.stacked .p-status    { grid-column: 2; grid-row: 1; }
    .status-pills.stacked .p-substatus { grid-column: 2; grid-row: 2; }
    .status-pill {
      min-width: 40mm; padding: 1.6mm 3.2mm; border-radius: 1.8mm;
      border: 1.1pt solid #141414; background: #fff;
      display: flex; flex-direction: column; justify-content: center;
    }
    .status-pill .cap { font-family: "IBM Plex Mono", "Roboto Mono", monospace; font-size: 6.5pt; font-weight: 700; letter-spacing: 1pt; color: #8a8a8a; text-transform: uppercase; }
    .status-pill .val { font-size: 9pt; font-weight: 700; margin-top: 0.6mm; }
    .ititle { display: grid; background: #f3f3f1; border-left: 0.4pt solid #d5d5d5; }
    .itable { display: grid; border-left: 0.4pt solid #d5d5d5; }
    .itable .th {
      padding: 2mm 2.8mm; background: #f3f3f1;
      border-right: 0.4pt solid #d5d5d5; border-bottom: 0.4pt solid #d5d5d5;
      font-family: "IBM Plex Mono", "Roboto Mono", monospace; font-size: 7pt; font-weight: 700;
      letter-spacing: 0.8pt; color: #5a5a5a;
    }
    .itable .td {
      padding: 2.8mm; border-right: 0.4pt solid #d5d5d5; border-bottom: 0.4pt solid #d5d5d5;
      font-size: 9pt; font-weight: 600; line-height: 1.5;
    }
    .itable .td.code { font-family: "IBM Plex Mono", "Roboto Mono", monospace; }
    .itable .td.remark { font-size: 8.3pt; font-weight: 400; color: #3a3a3a; }
    .itable .td.blank { min-height: 9mm; }
    .pgrid {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2.8mm;
      border: 0.4pt solid #d5d5d5; border-top: none; padding: 3.2mm;
    }
    .pgrid .ph { aspect-ratio: 4 / 3; border-radius: 1mm; overflow: hidden; position: relative; background: #f0f0ee; }
    .pgrid .ph img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .pgrid .ph .tag { position: absolute; left: 2mm; bottom: 1.6mm; font-family: "IBM Plex Mono", monospace; font-size: 6pt; color: rgba(255,255,255,0.75); }
    .pgrid .add {
      aspect-ratio: 4 / 3; border-radius: 1mm; border: 1.1pt dashed #cccccc;
      display: flex; align-items: center; justify-content: center; gap: 1.6mm;
      color: #b0b0b0; font-size: 8pt;
    }
    .credit-box { display: grid; grid-template-columns: 1.5fr 1fr 1fr; border: 1.1pt solid #141414; margin-top: 4mm; }
    .credit-box .cell { padding: 3.2mm 3.6mm; }
    .credit-box .cell + .cell { border-left: 0.4pt solid #d5d5d5; }
    .credit-box .k { font-family: "IBM Plex Mono", monospace; font-size: 6.8pt; font-weight: 700; letter-spacing: 1pt; color: #8a8a8a; text-transform: uppercase; margin-bottom: 1.6mm; }
    .credit-box .v { font-family: "IBM Plex Mono", monospace; font-size: 10.5pt; font-weight: 700; line-height: 1.35; }
    .boxed { border: 0.4pt solid #d5d5d5; border-top: none; padding: 3.6mm 4mm; }
    .signoff.boxed-grid { border: 0.4pt solid #d5d5d5; border-top: none; }
    .doc-footer {
      display: flex; align-items: center; justify-content: space-between; gap: 4mm;
      padding-top: 3.6mm; margin-top: 4mm; border-top: 0.4pt solid #e0e0e0;
      font-size: 7.5pt; color: #9a9a9a;
    }
    .doc-footer .contact { font-size: 8pt; color: #3a3a3a; }
    .doc-footer .contact b.mono { font-family: "IBM Plex Mono", monospace; }

    .foot { padding-top: 2mm; border-top: 0.5pt solid #000; text-align: center; font-size: 8pt; color: #555; letter-spacing: 0.5pt; }

    .print-bar {
      position: fixed; top: 14px; right: 14px;
      display: flex; gap: 8px; align-items: center; z-index: 100;
      padding: 6px; background: rgba(255,255,255,0.95); backdrop-filter: blur(6px);
      border-radius: 3pt; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    }
    .print-bar .tip { max-width: 260px; padding: 0 8px; font-size: 10.5px; line-height: 1.4; color: #444; }
    .print-bar .tip strong { color: #000; }
    .print-bar .tip em { font-style: normal; background: #f2ead9; padding: 0 3px; border-radius: 2px; }
    .print-bar button {
      padding: 8pt 14pt; background: #000; color: #fff; border: none; border-radius: 2pt;
      font-family: "Google Sans", "Roboto", Helvetica, Arial, sans-serif; font-size: 8.5pt;
      font-weight: 700; letter-spacing: 1.5pt; text-transform: uppercase; cursor: pointer;
    }
    .print-bar button.secondary { background: #fff; color: #000; border: 0.5pt solid #000; }
    @media print { .print-bar { display: none !important; } }

    .muted { color: #555; }
    .small { font-size: 8.5pt; }

  </style>
</head>
<body>
  <div class="print-bar">
    <div class="tip">
      <strong>Tip:</strong> in the print dialog, open
      <em>More settings</em> and untick <em>Headers and footers</em>
      to hide the browser's URL/date line.
    </div>
    <button class="secondary" onclick="window.close()">Close</button>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>

  <table class="sheet">

    <thead><tr><td>
      <div class="letterhead">
        <div>
          ${logoUri
            ? `<img src="${logoUri}" alt="${esc(coShort)}" class="logo" />`
            : `<div class="logo-fallback">${esc(coShort)}</div>`}
        </div>
        <div class="company">
          <div class="co-name">${esc(branding.companyName)}</div>
          ${branding.registrationNo ? `<div class="reg-no">${esc(branding.registrationNo)}</div>` : ""}
          ${coAddressLines.map((l) => `<div>${esc(l)}</div>`).join("")}
        </div>
      </div>
    </td></tr></thead>

    <tbody><tr><td>

    <div class="doc-title" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 6mm;">
      <div>
        <h1>${esc(docTitle)}</h1>
        ${docSubtitle ? `<div class="subtitle">${esc(docSubtitle)}</div>` : ""}
        <div class="ref">ASSR No. <b>${esc(cs.assr_no)}</b>${cs.ref_no ? ` · Ref No. <b>${esc(cs.ref_no)}</b>` : ""}</div>
      </div>
      ${!isSupplier ? `
      <div class="status-pills stacked">
        <div class="status-pill p-service"><span class="cap">Service</span><span class="val">${esc(servicePillLabel)}</span></div>
        <div class="status-pill p-status"><span class="cap">Status</span><span class="val">${esc(statusPillLabel)}</span></div>${subStatusLabel ? `
        <div class="status-pill p-substatus"><span class="cap">Sub-Status</span><span class="val">${esc(subStatusLabel)}</span></div>` : ""}
      </div>` : `
      <div class="status-pills">
        <div class="status-pill"><span class="cap">Status</span><span class="val">${esc(statusPillLabel)}</span></div>${subStatusLabel ? `
        <div class="status-pill"><span class="cap">Sub-Status</span><span class="val">${esc(subStatusLabel)}</span></div>` : ""}
      </div>`}
    </div>

    ${!isSupplier ? (() => {
      // ── ASSR Form (design handoff) — boxed meta grid, black section
      // bars, fixed items table, 3-up photo grid, dual sign-off. ──
      const officeItems = (items as any[]).map((it, i) => `
        <div class="itable" style="grid-template-columns: 10mm 1fr 12mm 12mm 1.4fr;">
          <span class="td">${i + 1}</span>
          <span class="td code">${esc([it.item_code, it.item_description].filter(Boolean).join(" — "))}</span>
          <span class="td">${esc(it.qty ?? 1)}</span>
          <span class="td">${esc(it.qty_carton ?? 1)}</span>
          <span class="td remark">${it.remark ? esc(it.remark) : i === 0 && cs.action_remark ? esc(cs.action_remark) : ""}</span>
        </div>`);
      const blanks = Math.max(0, 3 - officeItems.length);
      for (let i = 0; i < blanks; i++) {
        officeItems.push(`
        <div class="itable" style="grid-template-columns: 10mm 1fr 12mm 12mm 1.4fr;">
          <span class="td blank"></span><span class="td blank"></span><span class="td blank"></span><span class="td blank"></span><span class="td blank"></span>
        </div>`);
      }
      // Split the case photos into the two panels ops asked for on the
      // customer copy: the reported defect ("Service Issue") vs the
      // post-return quality shots ("QC Approved"). Categories mirror the
      // case-page grouping. Completion / sign-off / delivery images
      // belong to the sign-off block, not the reference grids, so they
      // are excluded from both; anything else (incl. uncategorised
      // legacy photos) falls under Service Issue so none is dropped.
      const qcCats = new Set(["inspection_report", "receipt_evidence"]);
      const skipCats = new Set(["completion", "delivery_pod", "sign_off", "signature"]);
      const qcPhotos = inlinedImages.filter((a) => qcCats.has(a.category));
      const issuePhotos = inlinedImages.filter(
        (a) => !qcCats.has(a.category) && !skipCats.has(a.category)
      );
      const photoCells = (
        imgs: Array<{ category: string; file_name: string | null; data_url: string }>,
        tag: string
      ): string => {
        const cells = imgs.slice(0, 6).map((a, i) =>
          `<div class="ph"><img src="${a.data_url}" alt="${esc(a.file_name || "")}" /><span class="tag">${tag}_${String(i + 1).padStart(2, "0")}</span></div>`
        );
        if (cells.length === 0) cells.push(`<div class="add">＋ Add</div>`);
        return cells.join("");
      };
      return `
    <!-- meta grid -->
    <div class="mgrid cols-6 rule-top">
      <div class="lc">Sales Agent</div><div class="vc">${esc(cs.sales_agent || "—")}</div>
      <div class="lc">Request Date</div><div class="vc mono">${fmtDate(cs.complained_date)}</div>
      <div class="lc">ASSR No</div><div class="vc mono" style="white-space: nowrap;">${esc(cs.assr_no)}</div>
      <div class="lc">Category</div><div class="vc">${cs.service_category || cs.issue_category ? `<span class="pill-cat">${esc(cs.service_category || cs.issue_category)}</span>` : `<span class="dim">—</span>`}</div>
      <div class="lc">Delivery Return</div><div class="vc dim">No · NA</div>
      <div class="lc">Purchase Return</div><div class="vc dim">No · NA</div>
    </div>

    <!-- customer info -->
    <div class="bar">Customer Info</div>
    <div class="mgrid cols-6">
      <div class="lc">Customer Name</div><div class="vc">${esc(cs.customer_name || "—")}</div>
      <div class="lc">HP</div><div class="vc mono">${esc(cs.phone || "—")}</div>
      <div class="lc">Ref No</div><div class="vc mono">${esc(cs.ref_no || "—")}</div>
      <div class="lc">Delivered Date</div><div class="vc mono">${fmtDate((cs as any).do_date)}</div>
      <div class="lc">PO No</div><div class="vc mono">${esc(cs.po_no || "—")}</div>
      <div class="lc">SO No</div><div class="vc mono">${esc(cs.doc_no || "—")}</div>
      <div class="lc">Address</div><div class="vc span5">${esc([cs.addr1, cs.addr2, cs.addr3, cs.addr4].filter(Boolean).join(", ") || "—")}</div>
      <div class="lc">Description of the problem</div><div class="vc span5" style="font-size: 9.4pt;">${esc(cs.complaint_issue || "—")}</div>
    </div>

    <!-- items -->
    <div class="bar">Items</div>
    <div class="itable" style="grid-template-columns: 10mm 1fr 12mm 12mm 1.4fr;">
      <span class="th">NO</span><span class="th">ITEM</span><span class="th">SET</span><span class="th">CTN</span><span class="th">REMARK (IF ANY)</span>
    </div>
    ${officeItems.join("")}

    <!-- service issue pictures -->
    <div class="bar">Service Issue &nbsp;<span class="note">(reported defect)</span></div>
    <div class="pgrid">${photoCells(issuePhotos, "ISS")}</div>

    <!-- qc approved pictures -->
    <div class="bar">QC Approved &nbsp;<span class="note">(quality inspection after service)</span></div>
    <div class="pgrid">${photoCells(qcPhotos, "QC")}</div>

    <!-- sign-off -->
    <div class="bar">Acknowledgement &amp; Sign-off</div>
    <div class="signoff boxed-grid">
      <div class="panel">
        <h3>Customer</h3>
        <div class="check"><span class="box"></span><span>I confirm the reported issue and details above are correct.</span></div>
        <div class="check"><span class="box"></span><span>I have received the serviced / replaced item in good condition.</span></div>
        <div class="sig-rule"><span class="cap">Signature</span><span class="small muted" style="float: right;">${esc(cs.customer_name || "")}</span></div>
        <div class="name-date">
          <div class="cell"><span class="cap">Name</span></div>
          <div class="cell" style="max-width: 44mm"><span class="cap">Date</span></div>
        </div>
      </div>
      <div class="panel">
        <h3>Warehouse</h3>
        <div class="check"><span class="box"></span><span>Goods inspected and received in good condition.</span></div>
        <div class="check"><span class="box"></span><span>Service / repair completed per the plan above.</span></div>
        <div class="sig-rule"><span class="cap">Received &amp; signed</span></div>
        <div class="name-date">
          <div class="cell"><span class="cap">Name</span></div>
          <div class="cell" style="max-width: 44mm"><span class="cap">Date</span></div>
        </div>
      </div>
    </div>

    <div class="doc-footer">
      <span>Computer-generated document · valid without signature until countersigned above.</span>
      <span class="contact"><b>Warehouse Contact</b> · ${esc(coShort)} CS Team &nbsp;<b class="mono">${esc(csPhone)}</b></span>
    </div>`;
    })() : ""}

    ${isSupplier ? (() => {
      // ── Supplier Service Order (design handoff). ──
      const supItems = (items as any[]).map((it, i) => `
        <div class="itable" style="grid-template-columns: 10mm 1fr 12mm 12mm 1.4fr;">
          <span class="td">${i + 1}</span>
          <span class="td code">${esc([it.item_code, it.item_description].filter(Boolean).join(" — "))}</span>
          <span class="td">${esc(it.qty ?? 1)}</span>
          <span class="td">${esc(it.qty_carton ?? 1)}</span>
          <span class="td remark">${it.supplier_remark ? esc(it.supplier_remark) : i === 0 && cs.action_remark ? esc(cs.action_remark) : ""}</span>
        </div>`);
      const photos = inlinedImages.slice(0, 5).map((a, i) => `
        <div class="ph"><img src="${a.data_url}" alt="${esc(a.file_name || "")}" /><span class="tag">IMG_${String(i + 1).padStart(2, "0")}</span></div>`);
      photos.push(`<div class="add">＋ Add</div>`);
      const firstItem = (items as any[])[0];
      return `
    <!-- meta grid -->
    <div class="mgrid cols-8 rule-top">
      <div class="lc">Request Date</div><div class="vc mono">${fmtDate(cs.complained_date)}</div>
      <div class="lc">ASSR No</div><div class="vc mono" style="white-space: nowrap;">${esc(cs.assr_no)}</div>
      <div class="lc">Reference</div><div class="vc mono">${esc(cs.ref_no || "—")}</div>
      <div class="lc">Category</div><div class="vc">${cs.service_category || cs.issue_category ? `<span class="pill-cat">${esc(cs.service_category || cs.issue_category)}</span>` : `<span class="dim">—</span>`}</div>
    </div>

    <!-- creditor box -->
    <div class="credit-box">
      <div class="cell"><div class="k">Supplier (Creditor)</div><div class="v">${esc((cs as any).creditor_name || (cs as any).creditor_code || "—")}</div></div>
      <div class="cell"><div class="k">PO Number</div><div class="v">${esc(cs.po_no || "—")}</div></div>
      <div class="cell"><div class="k">Target Completion</div><div class="v">${supplierTargetIso ? fmtDate(supplierTargetIso) : "—"}</div></div>
    </div>

    <!-- deliver / collect — area + coordinator only, direct contact
         withheld until dispatch (portal contract). -->
    <div class="bar">Deliver / Collect</div>
    <div class="mgrid cols-4">
      <div class="lc">Customer</div><div class="vc">${esc(cs.customer_name || "—")}</div>
      <div class="lc">Delivery Area</div><div class="vc">${esc(cs.location || (cs as any).addr4 || "—")}</div>
      <div class="lc">Coordinator</div><div class="vc">Service Admin (Purchasing)</div>
      <div class="lc">Warehouse</div><div class="vc">${esc(warehouseLabel || "—")}</div>
      <div class="lc">Note</div><div class="vc span3" style="font-weight: 400; color: #6a6a6a; font-size: 8.2pt;">Customer's direct phone &amp; full address are shared after dispatch is confirmed.</div>
    </div>

    <!-- reported issue -->
    <div class="bar">Reported Issue</div>
    <div class="boxed">
      <div style="font-size: 7.6pt; letter-spacing: .08em; text-transform: uppercase; color: #8a8578;">Product Code</div>
      <div style="font-family: 'IBM Plex Mono', monospace; font-size: 9.8pt; font-weight: 700; margin-top: 0.8mm;">${esc((items as any[]).map((it) => it.item_code).filter(Boolean).join(", ") || "—")}</div>
      <div style="font-size: 7.6pt; letter-spacing: .08em; text-transform: uppercase; color: #8a8578; margin-top: 2.4mm;">Issue Details</div>
      <div style="font-size: 8.8pt; color: #3a3a3a; margin-top: 0.8mm; line-height: 1.55;">${esc(cs.complaint_issue || "—")}${cs.issue_category ? ` &nbsp;·&nbsp; Category: ${esc(cs.issue_category)}` : ""}</div>
    </div>

    <!-- items -->
    <div class="bar">Items</div>
    <div class="itable" style="grid-template-columns: 10mm 1fr 12mm 12mm 1.4fr;">
      <span class="th">NO</span><span class="th">ITEM</span><span class="th">SET</span><span class="th">CTN</span><span class="th">REMARK (IF ANY)</span>
    </div>
    ${supItems.join("") || `<div class="itable" style="grid-template-columns: 10mm 1fr 12mm 12mm 1.4fr;"><span class="td blank"></span><span class="td blank"></span><span class="td blank"></span><span class="td blank"></span></div>`}

    <!-- resolution plan -->
    <div class="bar">Resolution Plan</div>
    <div class="mgrid cols-4">
      <div class="lc">Method</div><div class="vc">${esc(cs.resolution_method ? (RESOLUTION_LABEL[cs.resolution_method] || cs.resolution_method) : "—")}</div>
      <div class="lc">Target Date</div><div class="vc mono">${supplierTargetIso ? fmtDate(supplierTargetIso) : "—"}</div>
    </div>

    <!-- supporting evidence -->
    <div class="bar">Supporting Evidence</div>
    <div class="pgrid">${photos.join("")}</div>

    <!-- sign-off -->
    <div class="bar">Acknowledgement &amp; Sign-off</div>
    <div class="signoff boxed-grid">
      <div class="panel">
        <h3>Supplier</h3>
        <div class="check"><span class="box"></span><span>Goods received from ${esc(coShort)} in good condition.</span></div>
        <div class="check"><span class="box"></span><span>Service / repair completed per the plan above.</span></div>
        <div class="sig-rule"><span class="cap">Signature</span></div>
        <div class="name-date">
          <div class="cell"><span class="cap">Name</span></div>
          <div class="cell" style="max-width: 44mm"><span class="cap">Date</span></div>
        </div>
      </div>
      <div class="panel">
        <h3>${esc(coShort)} Representative</h3>
        <div style="font-size: 8.6pt; color: #6a6a6a; line-height: 1.5; margin-bottom: 9mm;">Verified the returned item and confirmed the service against the resolution plan.</div>
        <div class="sig-rule"><span class="cap">Signature</span></div>
        <div class="name-date">
          <div class="cell"><span class="cap">Name</span></div>
          <div class="cell" style="max-width: 44mm"><span class="cap">Date</span></div>
        </div>
      </div>
    </div>

    <div class="doc-footer">
      <span>Computer-generated document · valid without signature until countersigned above.</span>
      <span class="contact"><b>${esc(coShort)} Contact</b> · CS Team &nbsp;<b class="mono">${esc(csPhone)}</b></span>
    </div>`;
    })() : ""}


    </td></tr>
    <tr class="filler"><td>&nbsp;</td></tr>
    </tbody>

    <tfoot><tr><td>
      <div class="foot">
        This is a computer-generated document and does not require a signature.
        Generated ${fmtDateTime(new Date().toISOString())}.
      </div>
    </td></tr></tfoot>

  </table>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

export default app;
