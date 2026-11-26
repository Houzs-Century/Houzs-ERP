import { Hono } from "hono";
import type { Env } from "../types";
import { createAssrCase, assrAttachmentKey, saveAttachment } from "../services/assr";
import { timingSafeEqualStr } from "../services/auth";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { intakeCompany } from "../lib/intake-company";
import { ASSR_SHEET_STATUS } from "../scm/shared/assr-stage-labels";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { summariseReadiness } from "../scm/lib/so-readiness";
import { soStreetTail, soTownLines } from "../services/autocount-address-fit";
import { caseAddressFourLines } from "../scm/shared/assr-case-address";
import { reopenedLegSets } from "../scm/shared/assr-leg-reopen";

const app = new Hono<{ Bindings: Env }>();

async function badIntakeKey(c: any): Promise<Response | null> {
  const provided = c.req.header("X-Intake-Key") || "";
  const expected = c.env.FORM_INTAKE_KEY || "";
  if (expected && timingSafeEqualStr(provided, expected)) return null;
  const limited = await checkRateLimit(c, "intake_badkey", clientIp(c), 10, 900);
  await new Promise((r) => setTimeout(r, 250));
  if (limited) return limited;
  return c.json({ error: "unauthorized" }, 401);
}

const INTAKE_KEY_COMPANY = "HOUZS";

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

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
};
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;
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

  const complaint =
    [description, photos ? `[Photos] ${photos}` : null].filter(Boolean).join("\n\n") ||
    "(no description on form)";

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


const normAlnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const digitCore = (s: string) => s.replace(/[^0-9]/g, "").replace(/^0+/, "");

app.post("/attachments-by-so", async (c) => {
  const denied = await badIntakeKey(c);
  if (denied) return denied;

  const so = (c.req.query("so") || "").trim();
  if (!so) return c.json({ error: "so is required" }, 400);
  const driveId = (c.req.query("drive_id") || "").trim().slice(0, 120);
  if (!driveId) return c.json({ error: "drive_id is required" }, 400);
  const ts = parseInt(c.req.query("ts") || "", 10);
  const fileName = (c.req.query("name") || "").slice(0, 200) || null;

  const contentType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[contentType];
  if (!ext) {
    return c.json({ error: `content-type '${contentType}' not allowed` }, 415);
  }

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



function sheetDetailStatus(
  stage: string,
  sub: string | null,
  inspectionBy: string | null,
  pickupBy: string | null,
  deliveryBy: string | null,
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
      // The own-team pickup leg (third sub, Nico 2026-09-01) owns the
      // collect-from-customer dispatch job. pickup_by = 'customer' is the
      // stored value for "our own team collects" — the ERP button reads
      // "Own team pickup" — so it emits the parenthesised (Own Team Pickup)
      // word the sheet's PICKUP job fires on (owner 2026-09-20: the leg is
      // our team's, so the sheet word must say Own Team, not Customer). The
      // bare leg exports the stage's bare word, which fires nothing.
      if (pickupBy === "customer") return "Pending Supplier Pickup (Own Team Pickup)";
      if (pickupBy === "supplier") return "Pending Supplier Pickup (Supplier Direct)";
      return "Pending Supplier Pickup";
    }
    return "Pending Supplier Pickup";
  }
  if (stage === "pending_delivery_service") {
    if (deliveryBy === "own") return "Pending Delivery/Service (Own Team)";
    if (deliveryBy === "supplier") return "Pending Delivery/Service (Supplier)";
    return undefined;
  }
  return undefined;
}

app.get("/status-export", async (c) => {
  const keyCompanyCode = intakeKeyCompanyCode(c);
  if (!keyCompanyCode) {
    const limited = await checkRateLimit(c, "intake_badkey", clientIp(c), 10, 900);
    await new Promise((r) => setTimeout(r, 250));
    if (limited) return limited;
    return c.json({ error: "unauthorized" }, 401);
  }

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

  const rows = await c.env.DB.prepare(
    `SELECT assr_no, doc_no, ref_no, complained_date, stage, sub_status, inspection_by, pickup_by, delivery_by, completion_date, closed_at,
            customer_name, phone, location, sales_agent, po_no, complaint_issue,
            addr1, addr2, addr3, addr4, ca.postcode, ca.city, ca.state,
            (SELECT group_concat(i.item_code, ', ')
               FROM assr_items i
              WHERE i.assr_id = assr_cases.id
                AND i.item_code IS NOT NULL AND i.item_code != '') as items_codes
       FROM assr_cases LEFT JOIN assr_case_address ca ON ca.assr_id = assr_cases.id
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
    delivery_by: string | null;
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
    postcode: string | null;
    city: string | null;
    state: string | null;
    items_codes: string | null;
  }>();

  // Address 1-4 in the SO's shape: lines, "<postcode> <city>", state (owner 2026-11-17).
  const cases = (rows.results ?? []).map((r) => ({ r, a: caseAddressFourLines(r) })).map(({ r, a }) => ({
    assr_no: r.assr_no,
    so_no: r.doc_no,
    ref_no: r.ref_no,
    complained_date: r.complained_date,
    status:
      sheetDetailStatus(r.stage, r.sub_status, r.inspection_by, r.pickup_by, r.delivery_by) ??
      ASSR_SHEET_STATUS[r.stage] ??
      r.stage.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
    completed_date: r.completion_date ?? r.closed_at ?? null,
    customer_name: r.customer_name,
    phone: r.phone,
    location: r.location,
    sales_agent: r.sales_agent,
    po_no: r.po_no,
    complaint_issue: r.complaint_issue,
    addr1: a[0],
    addr2: a[1],
    addr3: a[2],
    addr4: a[3],
    item_codes: r.items_codes,
    item_code: r.items_codes,
  }));

  return c.json({ count: cases.length, cases });
});


const SCHED_COL: Record<string, "sched_inspection_date" | "sched_pickup_date" | "sched_delivery_date"> = {
  INSPECTION: "sched_inspection_date",
  PICKUP: "sched_pickup_date",
  SERVICE: "sched_delivery_date",
};

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
      `UPDATE assr_cases SET ${[`${col} = ?`, ...reopenedLegSets({ [col]: row.cur }, { [col]: date })].join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
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


const brandingForSheet = (raw: string | null): string | null => {
  const b = (raw ?? "").trim();
  if (!b) return null;
  return /^2990s\b/i.test(b) ? b : `2990s ${b}`;
};

const SO_EXPORT_KEY_COMPANY = "2990";

const senToAmount = (sen: number | null | undefined): number =>
  Number((Number(sen ?? 0) / 100).toFixed(2));

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

  const linesByDoc = new Map<string, ReadySoLine[]>();
  for (let i = 0; i < docNos.length; i += 100) {
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

  const staffById = new Map<string, string>();
  const staffIds = [...new Set(orders.map((o) => o.salesperson_id).filter(Boolean))] as string[];
  for (let i = 0; i < staffIds.length; i += 100) {
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
    customer_delivery_date: o.customer_delivery_date,
    building_type: o.building_type,
    po_doc_no: [...(posByDoc.get(o.doc_no) ?? [])].sort().join(", ") || null,
    address1: o.address1,
    address2: [o.address2, ...soStreetTail(o)].filter(Boolean).join(", ") || null,
    address3: soTownLines(o)[0],
    address4: soTownLines(o)[1],
  }));

  return c.json({ count: rows.length, orders: rows });
});

export default app;
