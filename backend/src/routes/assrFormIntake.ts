/**
 * Google Form → ERP intake webhook (Nick 2026-07-05).
 *
 * The staff-facing service-request Google Form feeds the "Form
 * Responses 3" tab of the HC Delivery sheet; a sheet-bound Apps Script
 * onFormSubmit trigger POSTs the submitted row here so the case lands
 * in the ERP immediately. The form carries only the SO number + item +
 * issue (+ Drive photo links) — customer name/phone/address resolve
 * from the SO via createAssrCase, exactly like the in-app New Case
 * intake.
 *
 * Auth: shared secret in the X-Intake-Key header, compared against the
 * FORM_INTAKE_KEY worker secret (set via GitHub secret → wrangler
 * deploy). No user session — this endpoint is called by Google's
 * servers.
 *
 * Payload: { response_id?: string, row?: number, values: Record<string,string> }
 * where `values` keys are the Form Responses tab's column headers:
 *   Timestamp · Email Address · Doc. No. (SO) · Item Code ·
 *   Issue Category · Issue Description · Photo / Video
 *
 * Idempotent on response_id: the google_form activity note carries
 * `[gform:<response_id>]`; a duplicate trigger for the same response is
 * acknowledged without creating a second case.
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { createAssrCase, assrAttachmentKey, saveAttachment } from "../services/assr";
import { timingSafeEqualStr } from "../services/auth";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { ASSR_SHEET_STATUS } from "../scm/shared/assr-stage-labels";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { summariseReadiness } from "../scm/lib/so-readiness";

const app = new Hono<{ Bindings: Env }>();

// Shared-secret guard for every intake endpoint. Constant-time compare
// (the key is 48 random chars — brute force is hopeless, but the
// comparison shouldn't leak match length anyway), a small failure
// delay, and a per-IP failure limiter so key-guessing runs cost real
// time and eventually 429.
async function badIntakeKey(c: any): Promise<Response | null> {
  const provided = c.req.header("X-Intake-Key") || "";
  const expected = c.env.FORM_INTAKE_KEY || "";
  if (expected && timingSafeEqualStr(provided, expected)) return null;
  const limited = await checkRateLimit(c, "intake_badkey", clientIp(c), 10, 900);
  await new Promise((r) => setTimeout(r, 250));
  if (limited) return limited;
  return c.json({ error: "unauthorized" }, 401);
}

/* ── WHICH COMPANY A SHARED SECRET SPEAKS FOR ──────────────────────────────
   These endpoints are PRE-AUTH by design: Google's servers call them, there is
   no session and no X-Company-Id, so companyContext never runs and there is no
   caller whose grants could scope the query. That is exactly why the export
   below dumped customer_name / phone / addr1-4 / complaint_issue for EVERY
   company's cases to whoever held either key.

   The fix is therefore NOT "add the caller's company predicate" — there is no
   caller. It is to give each SECRET its own company and scope to that, because
   a shared secret held by one company's Google account is a credential FOR that
   company. Both keys in existence today are Houzs Century artifacts:
     · FORM_INTAKE_KEY — the staff service-request Google Form, whose cases
       resolve their customer data from Houzs SOs (createAssrCase).
     · SHEET_SYNC_KEY  — the HC (Houzs Century) Delivery sheet's own Apps
       Script (types.ts:29).
   A future 2990 sheet gets its OWN key and its own row here; it must never be
   given one of these two.

   Consequence worth stating plainly: if a 2990 case ever needs to reach the HC
   sheet, that is now a REFUSAL to notice rather than silent PII disclosure. */
const INTAKE_KEY_COMPANY = "HOUZS";

/** The company code the presented X-Intake-Key speaks for, or null if neither
 *  secret matched. Constant-time compare for both, same as badIntakeKey. */
function intakeKeyCompanyCode(c: any): string | null {
  const provided = c.req.header("X-Intake-Key") || "";
  const keys: Array<[string | undefined, string]> = [
    [c.env.FORM_INTAKE_KEY, INTAKE_KEY_COMPANY],
    [c.env.SHEET_SYNC_KEY, INTAKE_KEY_COMPANY],
  ];
  for (const [secret, code] of keys) {
    if (secret && timingSafeEqualStr(provided, secret)) return code;
  }
  return null;
}

/** Resolve a company code to its id for the raw-SQL predicate.
 *  · `{ master: false }` — the companies master is not readable AT ALL
 *    (pre-migration / the D1 test mirror). The install is single-company, there
 *    is no second tenant to leak to, so the caller degrades to no predicate —
 *    the same three-state contract as scm/lib/companyScope.ts.
 *  · `{ master: true, id: null }` — the master IS readable and has no row for
 *    this code. That is a MISCONFIGURATION, not a legacy state, and the caller
 *    must refuse: falling back to "no predicate" here would re-open the exact
 *    hole on the day someone renames a company code. */
async function intakeCompany(
  db: D1Database,
  code: string,
): Promise<{ master: boolean; id: number | null }> {
  try {
    const row = await db
      .prepare(`SELECT id FROM companies WHERE code = ? LIMIT 1`)
      .bind(code)
      .first<{ id: number | string }>();
    return { master: true, id: row?.id != null ? Number(row.id) : null };
  } catch {
    return { master: false, id: null };
  }
}

// Photo relay limits — Apps Script reads the Drive file and streams the
// bytes here. Mirrors the portal upload allow-list, plus mp4 because
// the form column is literally "Photo / Video".
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov", // iPhone videos in the historical form rows
  "application/pdf": "pdf",
};
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024; // Apps Script UrlFetch POST caps at 50MB
const MAX_ATTACHMENTS_PER_CASE = 20;

const pick = (values: Record<string, unknown>, key: string): string | null => {
  const v = values[key];
  const s = typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
  return s || null;
};

app.post("/", async (c) => {
  const denied = await badIntakeKey(c);
  if (denied) return denied;

  const body = await c.req
    .json<{ response_id?: string; row?: number; values?: Record<string, string> }>()
    .catch(() => null);
  if (!body?.values || typeof body.values !== "object") {
    return c.json({ error: "values object is required" }, 400);
  }
  const values = body.values;
  const responseId = (body.response_id || "").trim().slice(0, 120) || null;

  // Idempotency — a Google trigger can fire twice for one submission.
  if (responseId) {
    const dupe = await c.env.DB.prepare(
      `SELECT assr_id FROM assr_activity
        WHERE source_channel = 'google_form' AND note LIKE ?
        LIMIT 1`
    )
      .bind(`%[gform:${responseId}]%`)
      .first<{ assr_id: number }>();
    if (dupe) {
      return c.json({ ok: true, duplicate: true, id: dupe.assr_id });
    }
  }

  const soNo = pick(values, "Doc. No. (SO)");
  const itemCode = pick(values, "Item Code");
  const category = pick(values, "Issue Category");
  const description = pick(values, "Issue Description");
  const photos = pick(values, "Photo / Video");
  const submitter = pick(values, "Email Address");

  if (!soNo && !description) {
    return c.json({ error: "submission carries neither SO number nor description" }, 400);
  }

  // Drive photo links ride in the complaint text for now — attachment
  // migration to R2 is a later pass (mapping doc tab 3).
  const complaint =
    [description, photos ? `[Photos] ${photos}` : null].filter(Boolean).join("\n\n") ||
    "(no description on form)";

  // created_by: the submitter when their email has an ERP account,
  // else Farra (the form's owner-operator).
  let createdBy: number | undefined;
  for (const email of [submitter, "farraellya02@gmail.com"]) {
    if (!email) continue;
    const u = await c.env.DB.prepare(`SELECT id FROM users WHERE LOWER(email) = ?`)
      .bind(email.toLowerCase())
      .first<{ id: number }>();
    if (u) {
      createdBy = u.id;
      break;
    }
  }

  // Same path as the in-app New Case intake: SO context (customer,
  // phone, address, agent, ref) resolves from AutoCount's live
  // getSingle; assr_no auto-generates; default assignee + SLA +
  // stage history all seeded inside.
  const { assr_no, id } = await createAssrCase(c.env, {
    doc_no: soNo ?? "",
    items: itemCode ? [{ item_code: itemCode }] : [],
    complaint_issue: complaint,
    issue_category: category,
    created_by: createdBy,
  });

  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel)
     VALUES (?, 'note', ?, 'customer', 'google_form')`
  )
    .bind(
      id,
      `Submitted via Google Form${submitter ? ` by ${submitter}` : ""}${body.row ? ` (sheet row ${body.row})` : ""}${responseId ? ` [gform:${responseId}]` : ""}`
    )
    .run();

  return c.json({ ok: true, id, assr_no }, 201);
});

// ── POST /attachments?case_id=&name= ────────────────────────────
//
// Photo/video relay for a case the main handler just created. The
// Apps Script trigger reads each Drive file from the form's
// "Photo / Video" column (it runs under Nick's Google account, so it
// can read files the ERP could never fetch by URL) and streams the
// raw bytes here. Stored in R2 + assr_attachments exactly like an
// in-app upload, so the photos show in the case's Photos/Videos
// grid, the lightbox, and the prints.

app.post("/attachments", async (c) => {
  const denied = await badIntakeKey(c);
  if (denied) return denied;

  const caseId = parseInt(c.req.query("case_id") || "", 10);
  if (isNaN(caseId)) return c.json({ error: "case_id is required" }, 400);
  const fileName = (c.req.query("name") || "").slice(0, 200) || null;

  const contentType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[contentType];
  if (!ext) {
    return c.json({ error: `content-type '${contentType}' not allowed` }, 415);
  }

  // Only cases that came in via this webhook accept relayed photos —
  // keeps the shared-secret surface scoped to its own creations.
  const isFormCase = await c.env.DB.prepare(
    `SELECT 1 FROM assr_activity
      WHERE assr_id = ? AND source_channel = 'google_form'
      LIMIT 1`
  )
    .bind(caseId)
    .first();
  if (!isFormCase) return c.json({ error: "not a form-intake case" }, 404);

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM assr_attachments WHERE assr_id = ? AND archived_at IS NULL`
  )
    .bind(caseId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ATTACHMENTS_PER_CASE) {
    return c.json({ error: "attachment limit reached" }, 413);
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "file exceeds 40MB limit" }, 413);
  }

  const key = assrAttachmentKey(caseId, "evidence", ext);
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });
  const attId = await saveAttachment(c.env, caseId, key, fileName, contentType, "evidence", null);

  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, source_channel)
     VALUES (?, 'note', NULL, ?, ?, 'google_form')`
  )
    .bind(caseId, String(attId), `Photo relayed from Google Form${fileName ? `: ${fileName}` : ""}`)
    .run();

  return c.json({ ok: true, id: attId }, 201);
});

// ── POST /attachments-by-so?so=&ts=&drive_id=&name= ─────────────
//
// One-off historical migration (Nick 2026-07-06): the Form Responses
// rows that predate the webhook carry Drive photo links whose cases
// were imported from Farra's tab — those cases have no google_form
// activity row and no case_id known to the sheet, so the relay above
// can't serve them. This variant matches the case by SO number
// (doc_no); when one SO has several cases, the one whose
// complained_date sits closest to the form-submission timestamp wins.
//
// The form's SO field is staff free-text, so matching is tiered
// (dump of all 242 historical photo rows, 2026-07-06): exact doc_no,
// then normalized alnum (SO011006 / so-008485 / "PG AKEMI DISPLAY
// SET B"), then digit-core (bare "008892", S0-typos), then ref_no
// (HC10931 / PG0678 / ZNT4860, and the ref half of mixed entries
// like "SO-007357 HC8245"). A lower tier never overrides a higher.
//
// Idempotent per Drive file per case via a `[gdrive:<drive_id>]`
// marker in the activity note, so the migration trigger can re-run
// from a cursor without duplicating uploads.

const normAlnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const digitCore = (s: string) => s.replace(/[^0-9]/g, "").replace(/^0+/, "");

app.post("/attachments-by-so", async (c) => {
  const denied = await badIntakeKey(c);
  if (denied) return denied;

  const so = (c.req.query("so") || "").trim();
  if (!so) return c.json({ error: "so is required" }, 400);
  const driveId = (c.req.query("drive_id") || "").trim().slice(0, 120);
  if (!driveId) return c.json({ error: "drive_id is required" }, 400);
  const ts = parseInt(c.req.query("ts") || "", 10); // form-submission epoch millis
  const fileName = (c.req.query("name") || "").slice(0, 200) || null;

  const contentType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[contentType];
  if (!ext) {
    return c.json({ error: `content-type '${contentType}' not allowed` }, 415);
  }

  // Pre-extract an SO-looking token (S0→SO typo folded in) and a
  // ref-looking token from the free text, for the mixed entries.
  const soToken = so.match(/S[O0]\s?-?\s?\d{3,}/i)?.[0].replace(/^S0/i, "SO") ?? null;
  const refToken = so.match(/(?:HC|PG|ZNT|EGT)\s?-?\s?\d{2,}/i)?.[0] ?? null;
  const norm = normAlnum(soToken ?? so);
  const core = refToken && !soToken ? "" : digitCore(soToken ?? so);
  const coreParam = core.length >= 3 ? core : "-";
  const refNorm = refToken ? normAlnum(refToken) : "-";

  const candidates = await c.env.DB.prepare(
    `SELECT id, doc_no, ref_no, complained_date,
            CASE
              WHEN doc_no = ? THEN 0
              WHEN UPPER(REGEXP_REPLACE(COALESCE(doc_no,''), '[^A-Za-z0-9]', '', 'g')) = ? THEN 1
              WHEN NULLIF(LTRIM(REGEXP_REPLACE(COALESCE(doc_no,''), '[^0-9]', '', 'g'), '0'), '') = ? THEN 2
              ELSE 3
            END AS tier
       FROM assr_cases
      WHERE doc_no = ?
         OR UPPER(REGEXP_REPLACE(COALESCE(doc_no,''), '[^A-Za-z0-9]', '', 'g')) = ?
         OR NULLIF(LTRIM(REGEXP_REPLACE(COALESCE(doc_no,''), '[^0-9]', '', 'g'), '0'), '') = ?
         OR UPPER(REGEXP_REPLACE(COALESCE(ref_no,''), '[^A-Za-z0-9]', '', 'g')) IN (?, ?)
      ORDER BY tier, id`
  )
    .bind(so, norm, coreParam, so, norm, coreParam, norm, refNorm)
    .all<{ id: number; complained_date: string | null; tier: number }>();
  if (!candidates.results.length) return c.json({ error: "no case for SO", skipped: "no_case" }, 404);

  // Best tier only; complained_date proximity breaks ties within it.
  const topTier = candidates.results[0].tier;
  const pool = candidates.results.filter((r) => r.tier === topTier);
  let caseId = pool[0].id;
  if (pool.length > 1 && !isNaN(ts)) {
    let best = Infinity;
    for (const cand of pool) {
      const d = cand.complained_date ? Math.abs(new Date(cand.complained_date).getTime() - ts) : Infinity;
      if (d < best || (d === best && cand.id < caseId)) {
        best = d;
        caseId = cand.id;
      }
    }
  }

  const dupe = await c.env.DB.prepare(
    `SELECT 1 FROM assr_activity WHERE assr_id = ? AND note LIKE ? LIMIT 1`
  )
    .bind(caseId, `%[gdrive:${driveId}]%`)
    .first();
  if (dupe) return c.json({ ok: true, duplicate: true, id: caseId });

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM assr_attachments WHERE assr_id = ? AND archived_at IS NULL`
  )
    .bind(caseId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ATTACHMENTS_PER_CASE) {
    return c.json({ error: "attachment limit reached", skipped: "limit" }, 413);
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "file exceeds 40MB limit", skipped: "size" }, 413);
  }

  const key = assrAttachmentKey(caseId, "evidence", ext);
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });
  const attId = await saveAttachment(c.env, caseId, key, fileName, contentType, "evidence", null);

  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, source_channel)
     VALUES (?, 'note', NULL, ?, ?, 'google_form')`
  )
    .bind(
      caseId,
      String(attId),
      `Photo migrated from Google Form history${fileName ? `: ${fileName}` : ""} [gdrive:${driveId}]`
    )
    .run();

  return c.json({ ok: true, id: attId, case_id: caseId }, 201);
});

// ── Sheet status export (Nick 2026-07-14) ─────────────────────
//
// The "ASSR Case (Farra)" tab of the same HC Delivery sheet keeps a
// hand-maintained ASSR STATUS column that has drifted from the ERP
// (it still shows retired stages like Pending Inspection / Item
// Pickup). A sheet-bound Apps Script time trigger (every 10 min) GETs
// this endpoint and rewrites column A from the ERP's live stage, so
// the sheet's own stats block stays honest without anyone re-keying.
//
// Same X-Intake-Key guard as the intake webhook — the script already
// holds that secret for the form POST. Read-only, no PII: just the
// match keys (assr/so/ref) + the display status + completion date.

// ERP stage → the sheet's ASSR STATUS vocabulary. The sheet's stats
// block counts these exact strings ("Pending Delivery/Service" has no
// spaces around the slash). Retired stages can't appear (migs 0105 /
// 0110 moved every row), but legacy values fall through prettified so
// a surprise never writes "undefined" into the sheet.
//
// The table itself is ASSR_SHEET_STATUS in scm/shared/assr-stage-labels.ts,
// imported above. It sits next to the app's stage wording and is explicitly NOT
// merged into it: this is the SHEET's vocabulary, and two of its strings
// ("Pending Delivery/Service", "Voided") deliberately differ from the words the
// ERP prints. It travels with them so the next person to unify a stage label
// sees, in the same file, which strings a spreadsheet's counters are keyed on.

// Sub-status detail (Nico 2026-08-07: Delivery triggers were messy on
// the coarse stage words). Stages with sub-states export the SUB label -
// the Delivery sheet's trigger map fires INSPECTION/PICKUP only on the
// actionable halves ("QC Issue Result" / "Pending Supplier Return" have
// no trigger entry, so they fire nothing). A null sub falls back to the
// stage's seeded first sub-state, matching transitionStage's seeding.
// The actionable halves additionally require WHO acts (Nico 2026-08-07:
// inspection fires only when Own team inspects; pickup fires only when
// our logistics collects from the customer). The words carry the choice —
// the Delivery sheet's trigger map keys on the parenthesised variants and
// the bare words fire nothing until ops picks a side.
function sheetDetailStatus(
  stage: string,
  sub: string | null,
  inspectionBy: string | null,
  pickupBy: string | null,
): string | undefined {
  if (stage === "under_verification") {
    const s = sub ?? "pending_inspection";
    if (s === "qc_issue_result") return "QC Issue Result";
    if (inspectionBy === "own") return "Pending Inspection (Own Team)";
    if (inspectionBy === "supplier") return "Pending Inspection (Supplier)";
    return "Pending Inspection";
  }
  if (stage === "pending_supplier_pickup") {
    const s = sub ?? "pending_supplier_pickup";
    if (s === "pending_supplier_return") return "Pending Supplier Return";
    if (s === "pending_customer_pickup") {
      // The customer-pickup leg (third sub, Nico 2026-09-01) owns the
      // collect-from-customer dispatch job, so the parenthesised trigger
      // words moved here — the sheet's trigger map is unchanged (PICKUP
      // still fires on the same "(Customer Pickup)" word). The bare leg
      // exports the stage's bare word: Nico ruled the sheet's column-A
      // vocabulary must not change, and an unknown word would be rejected
      // by that column's validation (the 2026-08-07 disease). The finer
      // "Pending Customer Pickup" label lives in the ERP UI only.
      if (pickupBy === "customer") return "Pending Supplier Pickup (Customer Pickup)";
      if (pickupBy === "supplier") return "Pending Supplier Pickup (Supplier Direct)";
      return "Pending Supplier Pickup";
    }
    return "Pending Supplier Pickup";
  }
  return undefined;
}

app.get("/status-export", async (c) => {
  // Accepts EITHER shared secret: FORM_INTAKE_KEY (the form-intake
  // script's key) or SHEET_SYNC_KEY (issued for the HC Delivery
  // sheet's own Apps Script, which lives in a different Google account
  // and never held the intake key).
  const keyCompanyCode = intakeKeyCompanyCode(c);
  if (!keyCompanyCode) {
    const limited = await checkRateLimit(c, "intake_badkey", clientIp(c), 10, 900);
    await new Promise((r) => setTimeout(r, 250));
    if (limited) return limited;
    return c.json({ error: "unauthorized" }, 401);
  }

  /* COMPANY SCOPE — see INTAKE_KEY_COMPANY above for why this is the SECRET's
     company and not a caller's. Without it this pre-auth endpoint returned
     customer_name, phone, addr1-4 and complaint_issue for every non-archived
     case in BOTH companies to whoever held either key. */
  const keyCo = await intakeCompany(c.env.DB, keyCompanyCode);
  if (keyCo.master && keyCo.id == null) {
    return c.json(
      {
        error: "company_unresolved",
        message: `No company is configured for code ${keyCompanyCode}, so this export cannot be scoped and is refused.`,
      },
      503,
    );
  }
  const coSql = keyCo.id != null ? ` AND company_id = ${keyCo.id}` : "";

  // Append fields (Nico 2026-08-07): with the Google Form closed, the
  // sheet's Apps Script now auto-APPENDS rows for ERP cases the sheet
  // doesn't have — so the export carries the columns a new row needs.
  // Same trust boundary: key-protected, and the sheet already owns
  // these customer columns for every existing row.
  const rows = await c.env.DB.prepare(
    `SELECT assr_no, doc_no, ref_no, complained_date, stage, sub_status, inspection_by, pickup_by, completion_date, closed_at,
            customer_name, phone, location, sales_agent, po_no, complaint_issue,
            addr1, addr2, addr3, addr4,
            (SELECT group_concat(i.item_code, ', ')
               FROM assr_items i
              WHERE i.assr_id = assr_cases.id
                AND i.item_code IS NOT NULL AND i.item_code != '') as items_codes
       FROM assr_cases
      WHERE archived_at IS NULL${coSql}`
  ).all<{
    assr_no: string;
    doc_no: string | null;
    ref_no: string | null;
    complained_date: string | null;
    stage: string;
    sub_status: string | null;
    inspection_by: string | null;
    pickup_by: string | null;
    completion_date: string | null;
    closed_at: string | null;
    customer_name: string | null;
    phone: string | null;
    location: string | null;
    sales_agent: string | null;
    po_no: string | null;
    complaint_issue: string | null;
    addr1: string | null;
    addr2: string | null;
    addr3: string | null;
    addr4: string | null;
    items_codes: string | null;
  }>();

  const cases = (rows.results ?? []).map((r) => ({
    assr_no: r.assr_no,
    so_no: r.doc_no,
    ref_no: r.ref_no,
    // Third discriminator for the sheet sync (added 2026-08-04). SO + Ref
    // cannot separate the cases that share both — SO-006443 carries three,
    // all ref HC8307 — and the sheet keeps the complaint date in col D, so
    // it settles them. Still no PII: the sheet already owns the customer
    // columns and this endpoint never sends them.
    complained_date: r.complained_date,
    status:
      sheetDetailStatus(r.stage, r.sub_status, r.inspection_by, r.pickup_by) ??
      ASSR_SHEET_STATUS[r.stage] ??
      r.stage.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
    completed_date: r.completion_date ?? r.closed_at ?? null,
    customer_name: r.customer_name,
    phone: r.phone,
    location: r.location,
    sales_agent: r.sales_agent,
    po_no: r.po_no,
    complaint_issue: r.complaint_issue,
    addr1: r.addr1,
    addr2: r.addr2,
    addr3: r.addr3,
    addr4: r.addr4,
    item_codes: r.items_codes,
    // The sheet's _appendNewAssrRow reads c.item_code (singular) — alias
    // so the existing script fills its Item column without an edit.
    item_code: r.items_codes,
  }));

  return c.json({ count: cases.length, cases });
});

// ── Delivery-date write-back (Nico 2026-08-12) ─────────────────
//
// The reverse leg of the status export: when dispatch schedules a
// case's job row in Delivery Details (INSPECTION / PICKUP / SERVICE),
// the sheet's Apps Script POSTs the scheduled date here so the ERP
// case carries it — shown on the detail page and the print copies.
// Same dual-key guard as /status-export. Idempotent: an unchanged
// date is acknowledged without touching the row or the timeline.

const SCHED_COL: Record<string, "sched_inspection_date" | "sched_pickup_date" | "sched_delivery_date"> = {
  INSPECTION: "sched_inspection_date",
  PICKUP: "sched_pickup_date",
  SERVICE: "sched_delivery_date",
};

// Sheet dates arrive as display text — "2026/08/15", "15/08/2026", an
// ISO string, or a Date serialised by Apps Script. Normalise to
// YYYY-MM-DD; anything unparseable is skipped (never guessed).
function normSheetDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

app.post("/delivery-dates", async (c) => {
  // company-scope: scoped, but by string-built SQL the checker cannot see. :620 builds `AND company_id = <resolved>` and refuses with company_unresolved when it cannot; :639 applies it to the READ; :654 writes on the id that scoped read returned. Verified 2026-08-19.
  const keyCompanyCode = intakeKeyCompanyCode(c);
  if (!keyCompanyCode) {
    const limited = await checkRateLimit(c, "intake_badkey", clientIp(c), 10, 900);
    await new Promise((r) => setTimeout(r, 250));
    if (limited) return limited;
    return c.json({ error: "unauthorized" }, 401);
  }

  /* COMPANY SCOPE, same rule as /status-export — and this leg is a WRITE. The
     lookup below resolves a case by assr_no, which is NOT unique across
     companies, so unscoped the HC sheet could stamp a scheduled inspection /
     pickup / delivery date onto the OTHER company's case and file an
     assr_activity note under it. The predicate goes on the SELECT; the UPDATE
     then keys on the id that scoped read returned. */
  const keyCo = await intakeCompany(c.env.DB, keyCompanyCode);
  if (keyCo.master && keyCo.id == null) {
    return c.json(
      {
        error: "company_unresolved",
        message: `No company is configured for code ${keyCompanyCode}, so this write cannot be scoped and is refused.`,
      },
      503,
    );
  }
  const coSql = keyCo.id != null ? ` AND company_id = ${keyCo.id}` : "";

  const body = await c.req
    .json<{ updates?: Array<{ assr_no?: string; job?: string; date?: string }> }>()
    .catch(() => null);
  const updates = Array.isArray(body?.updates) ? body!.updates! : [];
  if (!updates.length) return c.json({ error: "updates array is required" }, 400);
  if (updates.length > 300) return c.json({ error: "too many updates in one call" }, 413);

  const results: Array<Record<string, unknown>> = [];
  for (const u of updates) {
    const assrNo = String(u.assr_no ?? "").trim();
    const col = SCHED_COL[String(u.job ?? "").trim().toUpperCase()];
    const date = normSheetDate(u.date);
    if (!assrNo || !col || !date) {
      results.push({ assr_no: assrNo || null, skipped: "bad_input" });
      continue;
    }
    const row = await c.env.DB.prepare(
      `SELECT id, ${col} AS cur FROM assr_cases WHERE assr_no = ?${coSql}`
    )
      .bind(assrNo)
      .first<{ id: number; cur: string | null }>();
    if (!row) {
      results.push({ assr_no: assrNo, skipped: "no_case" });
      continue;
    }
    if ((row.cur ?? "").slice(0, 10) === date) {
      results.push({ assr_no: assrNo, ok: true, unchanged: true });
      continue;
    }
    await c.env.DB.prepare(
      `UPDATE assr_cases SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(date, row.id)
      .run();
    const jobWord = String(u.job).trim().toUpperCase();
    await c.env.DB.prepare(
      `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, category, source_channel)
       VALUES (?, 'note', ?, ?, ?, 'system', 'sheet_sync')`
    )
      .bind(
        row.id,
        row.cur,
        date,
        `Delivery sheet scheduled ${jobWord} on ${date}${row.cur ? ` (was ${row.cur.slice(0, 10)})` : ""}`
      )
      .run();
    results.push({ assr_no: assrNo, ok: true, [col]: date });
  }

  return c.json({ ok: true, results });
});

// ── 2990 SO → HC Delivery sheet export (Nico 2026-08-26) ───────
//
// Houzs orders reach the sheet's Delivery Details tab through the
// AutoCount pull (GetAutoCountData.gs). 2990's orders are born in the
// ERP's own SCM module and never touch AutoCount, so dispatch has been
// hand-typing them — 19 rows so far, with every AutoCount-fed column
// (Sales Location / Agent / Local Total / Balance) left blank. This
// export is the missing feed: every 2990 order whose stock has come
// good, with the columns a Delivery Details row needs.
//
// "Stock is ready" = the header status the ERP already derives in
// recomputeSoStockAllocation: READY_TO_SHIP, i.e. every MAIN line
// (SOFA / BEDFRAME / MATTRESS) allocated. Accessories do not block a
// delivery, so a main-ready order ships with `stock_remark` reading
// "READY (PARTIAL)" — the operator's existing Remarks-2 wording.
//
// Full-state export, not a cursor: the sheet's script appends only the
// Doc. Nos it doesn't already carry, so re-sending an order it already
// has is a no-op. Nothing to lose, nothing to replay — a missed sweep
// heals on the next one.
//
// Same dual-key guard as /status-export. This one DOES carry customer
// name / phone / address: the same columns the status-export append
// path already sends, into the same sheet, which has owned them on
// every row since long before either feed existed.
//
// Column map (Delivery Details), agreed with Nico 2026-08-26. The letters
// are the sheet's own — read off the header row's column ids, NOT counted by
// eye: the tab has a frozen-column freezebar that renders as an extra cell
// and shifts every letter from G on by one if you count cells.
//   B  Doc. No.                     doc_no          <- the sheet's dedupe key
//   C  Transfer To                  transfer_to     (DO no; usually still null)
//   D  Date                         so_date
//   E  Ref. No                      doc_no again - what dispatch already types
//                                   by hand on the 2990 rows, and it keeps the
//                                   odd essay-length `ref` out of the sheet
//   F  Branding                     branding, prefixed to "2990s ..." when the
//                                   stored value lacks it - the SCM list grew
//                                   two shapes ("2990s Sofa" / "2990s Mattress"
//                                   but bare "Bedframe" / "Accessories") and
//                                   Nico wants one shape in the sheet
//   G-L Debtor Name .. Balance      debtor_name / phone / venue / salesperson /
//                                   local_total / balance. venue is the STORE
//                                   ("2990s PJ"); sales_location holds the
//                                   warehouse, which dispatch cannot route on.
//                                   `agent` is null on every 2990 order - the
//                                   name lives behind salesperson_id.
//   M  Remarks 2                    stock_remark
//   N  Processing Date              processing_date
//   O  Sales Exemption Expiry Date  customer_delivery_date - 2990 never uses
//        the exemption field (NULL on every SCM order), so Nico repurposed the
//        column: dispatch reads the customer's requested date there.
//   Q  Delivery Date                left blank - scheduling owns it
//   V  Landed / Condo / Apartment   building_type
//   AA PO Doc No.                   the manufacturing PO(s) raised off this
//        order. The SO header has no PO column: the link runs SO line ->
//        purchase_order_items.so_item_id -> purchase_orders.po_number, and an
//        order can carry more than one (comma-joined, cancelled POs dropped).
//   AB-AE Address 1-4               address1 / address2 / postcode+city /
//                                   customer_state - matches how the AutoCount
//                                   feed fills the Houzs rows.

/** The sheet's Branding column wants every 2990 row under one prefix; the SCM
 *  branding list carries two shapes ("2990s Sofa" / "2990s Mattress" but bare
 *  "Bedframe" / "Accessories"). Normalise on the way out rather than rewriting
 *  stored data — the ERP's own screens keep showing what was picked. */
const brandingForSheet = (raw: string | null): string | null => {
  const b = (raw ?? "").trim();
  if (!b) return null;
  return /^2990s\b/i.test(b) ? b : `2990s ${b}`;
};

/* The 2990 feed carries 2990 customers' names, phones and addresses, so by the
   rule established 2026-08-18 (see INTAKE_KEY_COMPANY above) it needs its OWN
   secret: FORM_INTAKE_KEY and SHEET_SYNC_KEY both speak for HOUZS and must
   never be the key that opens 2990 data. The company id is then read from the
   companies master under this code rather than hardcoded — a renamed or
   re-seeded company must break loudly, not silently export the wrong tenant. */
const SO_EXPORT_KEY_COMPANY = "2990";

/** sen → the plain ringgit number the sheet's currency columns expect. */
const senToAmount = (sen: number | null | undefined): number =>
  Number((Number(sen ?? 0) / 100).toFixed(2));

/* The SCM tables have no generated types on this client (the service client is
   schema-pinned, not typed), so the REST rows land as `GenericStringError |
   Row`. These two shapes are the contract this handler reads. */
type ReadySoHead = {
  doc_no: string;
  so_date: string | null;
  branding: string | null;
  venue: string | null;
  debtor_name: string | null;
  phone: string | null;
  agent: string | null;
  salesperson_id: string | null;
  local_total_sen: number | null;
  balance_sen_live: number | null;
  processing_date: string | null;
  customer_delivery_date: string | null;
  building_type: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  transfer_to: string | null;
};
type ReadySoLine = {
  id: string;
  doc_no: string;
  item_group: string | null;
  item_code: string | null;
  stock_status: string;
  cancelled: boolean | null;
};

app.get("/so-export", async (c) => {
  const provided = c.req.header("X-Intake-Key") || "";
  const secret = c.env.SHEET_SYNC_KEY_2990 || "";
  if (!secret || !timingSafeEqualStr(provided, secret)) {
    const limited = await checkRateLimit(c, "intake_badkey", clientIp(c), 10, 900);
    await new Promise((r) => setTimeout(r, 250));
    if (limited) return limited;
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!isSupabaseConfigured(c.env)) {
    return c.json({ error: "supabase not configured" }, 503);
  }

  /* Scope from the master, and refuse when it cannot be read. The ASSR exports
     above may degrade to "no predicate" on a master-less install (single tenant,
     nothing to leak to); this one may not — an unscoped read HERE is the Houzs
     export, which is the whole thing the 2026-08-18 rule forbids. */
  const keyCo = await intakeCompany(c.env.DB, SO_EXPORT_KEY_COMPANY);
  if (keyCo.id == null) {
    return c.json(
      {
        error: "company_unresolved",
        message: `No company is configured for code ${SO_EXPORT_KEY_COMPANY}, so this export cannot be scoped and is refused.`,
      },
      503,
    );
  }

  const sb = getSupabaseService(c.env);
  const { data: heads, error } = await sb
    /* The VIEW, not the base table. mfg_sales_orders.balance_sen is a stored
       column nothing maintains - it still equals local_total on orders that
       were paid in full months ago - so reading it wrote "everything is
       outstanding" into the sheet. balance_sen_live is netted against the
       payments and is what the SO list itself shows. */
    .from("mfg_sales_orders_with_payment_totals")
    .select(
      "doc_no, so_date, branding, venue, debtor_name, phone, agent, salesperson_id, " +
        "local_total_sen, balance_sen_live, processing_date, customer_delivery_date, " +
        "building_type, address1, address2, address3, address4, " +
        "city, postcode, customer_state, transfer_to"
    )
    .eq("company_id", keyCo.id)
    .eq("status", "READY_TO_SHIP")
    .order("so_date", { ascending: true });
  if (error) return c.json({ error: error.message }, 502);

  const orders = (heads ?? []) as unknown as ReadySoHead[];
  const docNos = orders.map((o) => o.doc_no);

  // Lines exist only to re-derive the Remarks-2 wording. Chunked because the
  // REST edge caps a single `in.()` list, and this set only ever grows.
  const linesByDoc = new Map<string, ReadySoLine[]>();
  for (let i = 0; i < docNos.length; i += 100) {
    /* Bind the error: supabase-js does not throw, and a swallowed failure here
       reads as "this order has no lines" — summariseReadiness([]) then returns
       an empty remark, so a five-second blip would write a BLANK Remarks 2 into
       the sheet and call it ready. Refuse the whole export instead. */
    const { data, error: lineErr } = await sb
      .from("mfg_sales_order_items")
      .select("id, doc_no, item_group, item_code, stock_status, cancelled")
      .in("doc_no", docNos.slice(i, i + 100));
    if (lineErr) return c.json({ error: lineErr.message }, 502);
    for (const l of (data ?? []) as unknown as ReadySoLine[]) {
      const arr = linesByDoc.get(l.doc_no) ?? [];
      arr.push(l);
      linesByDoc.set(l.doc_no, arr);
    }
  }

  /* PO No. — the SO header carries no PO column; the link runs SO line ->
     purchase_order_items.so_item_id -> purchase_orders.po_number. Dispatch
     reads that column on the Houzs rows, so the 2990 rows should carry it too.
     An order can have several POs (and a PO can serve several orders), so this
     collects per order and joins. Cancelled POs are dropped. */
  const docBySoItem = new Map<string, string>();
  for (const [doc, lines] of linesByDoc) {
    for (const l of lines) if (l.id) docBySoItem.set(l.id, doc);
  }
  const soItemIdsByPo = new Map<string, string[]>();
  const soItemIds = [...docBySoItem.keys()];
  for (let i = 0; i < soItemIds.length; i += 100) {
    const { data, error: poiErr } = await sb
      .from("purchase_order_items")
      .select("so_item_id, purchase_order_id")
      .in("so_item_id", soItemIds.slice(i, i + 100));
    if (poiErr) return c.json({ error: poiErr.message }, 502);
    for (const r of (data ?? []) as unknown as Array<{ so_item_id: string; purchase_order_id: string }>) {
      const arr = soItemIdsByPo.get(r.purchase_order_id) ?? [];
      arr.push(r.so_item_id);
      soItemIdsByPo.set(r.purchase_order_id, arr);
    }
  }
  const posByDoc = new Map<string, Set<string>>();
  const poIds = [...soItemIdsByPo.keys()];
  for (let i = 0; i < poIds.length; i += 100) {
    const { data, error: poErr } = await sb
      .from("purchase_orders")
      .select("id, po_number, cancelled_at")
      .in("id", poIds.slice(i, i + 100));
    if (poErr) return c.json({ error: poErr.message }, 502);
    for (const po of (data ?? []) as unknown as Array<{ id: string; po_number: string | null; cancelled_at: string | null }>) {
      if (po.cancelled_at || !po.po_number) continue;
      for (const itemId of soItemIdsByPo.get(po.id) ?? []) {
        const doc = docBySoItem.get(itemId);
        if (!doc) continue;
        const set = posByDoc.get(doc) ?? new Set<string>();
        set.add(po.po_number);
        posByDoc.set(doc, set);
      }
    }
  }

  /* The Agent column wants a person, and 2990 orders carry only the id. */
  const staffById = new Map<string, string>();
  const staffIds = [...new Set(orders.map((o) => o.salesperson_id).filter(Boolean))] as string[];
  for (let i = 0; i < staffIds.length; i += 100) {
    /* Same reason: a swallowed failure here empties the Agent column instead
       of saying that anything went wrong. */
    const { data, error: staffErr } = await sb
      .from("staff")
      .select("id, name")
      .in("id", staffIds.slice(i, i + 100));
    if (staffErr) return c.json({ error: staffErr.message }, 502);
    for (const st of (data ?? []) as unknown as Array<{ id: string; name: string | null }>) {
      if (st.name) staffById.set(st.id, st.name);
    }
  }

  const rows = orders.map((o) => ({
    doc_no: o.doc_no,
    transfer_to: o.transfer_to,
    so_date: o.so_date,
    ref: o.doc_no,
    branding: brandingForSheet(o.branding),
    debtor_name: o.debtor_name,
    phone: o.phone,
    sales_location: o.venue,
    agent: o.agent ?? (o.salesperson_id ? staffById.get(o.salesperson_id) ?? null : null),
    local_total: senToAmount(o.local_total_sen),
    balance: senToAmount(o.balance_sen_live),
    stock_remark: summariseReadiness(linesByDoc.get(o.doc_no) ?? []).stockRemark,
    processing_date: o.processing_date,
    // Sheet col O — see the column map above.
    customer_delivery_date: o.customer_delivery_date,
    building_type: o.building_type,
    po_doc_no: [...(posByDoc.get(o.doc_no) ?? [])].sort().join(", ") || null,
    address1: o.address1,
    address2: o.address2,
    /* 2990 keeps town/state in their own columns while the sheet expects the
       AutoCount shape: "<postcode> <town>" on line 3, state on line 4. */
    address3: o.address3 ?? ([o.postcode, o.city].filter(Boolean).join(" ") || null),
    address4: o.address4 ?? o.customer_state,
  }));

  return c.json({ count: rows.length, orders: rows });
});

export default app;
