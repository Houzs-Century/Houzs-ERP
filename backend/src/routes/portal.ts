import { Hono } from "hono";
import type { Env } from "../types";
import { customerStatusFor } from "../services/caseTracking";
import { assrAttachmentKey, saveAttachment, ALL_STAGES } from "../services/assr";
import { checkRateLimit } from "../middleware/rateLimit";


const app = new Hono<{ Bindings: Env }>();

app.get("/case", async (c) => {
  const { assr_id, source: viewer } = c.get("trackedCase");
  const isSales = viewer === "sales";

  const cs = await c.env.DB.prepare(
    `SELECT id, assr_no, stage, complained_date, complaint_issue,
            service_category, deadline_at, completion_date, closed_at,
            satisfaction_rating, customer_name, resolution_method,
            doc_no, ref_no
       FROM assr_cases WHERE id = ?`
  )
    .bind(assr_id)
    .first<any>();
  if (!cs) return c.json({ error: "Not found" }, 404);
  const status = customerStatusFor(cs.stage);

  const items = await c.env.DB.prepare(
    `SELECT id, item_code, item_description, qty
       FROM assr_items WHERE assr_id = ? ORDER BY id`
  )
    .bind(assr_id)
    .all();

  const atts = await c.env.DB.prepare(
    `SELECT id, category, file_name, content_type, source, created_at
       FROM assr_attachments
      WHERE assr_id = ?
        AND visible_to_customer = 1
        AND archived_at IS NULL
      ORDER BY created_at DESC`
  )
    .bind(assr_id)
    .all();

  const activityRaw = await c.env.DB.prepare(
    `SELECT id, action, from_value, to_value, note, source, category, created_at
       FROM assr_activity
      WHERE assr_id = ? AND archived_at IS NULL
      ORDER BY created_at ASC`
  )
    .bind(assr_id)
    .all<any>();
  const timeline = (activityRaw.results ?? [])
    .filter((a: any) => {
      if (a.source === "customer") return true;
      if (a.source === "sales") return isSales;
      if (a.action === "stage_change") return true;
      if (a.action === "created") return true;
      if (a.action === "survey_submitted") return true;
      if (a.action === "note" && a.category === "customer") return true;
      return false;
    })
    .map((a: any) => {
      const base: any = {
        id: a.id,
        action: a.action,
        at: a.created_at,
        source: a.source ?? "staff",
      };
      if (a.action === "stage_change") {
        const to = customerStatusFor(a.to_value);
        base.label = `Status updated to ${to.label}`;
      } else if (a.action === "customer_comment") {
        base.label = "Comment";
        base.note = a.note;
      } else if (a.action === "sales_comment") {
        base.label = "Comment (Sales)";
        base.note = a.note;
      } else if (a.action === "created") {
        base.label = "Case received";
      } else if (a.action === "customer_upload") {
        base.label = "Photo uploaded";
      } else if (a.action === "sales_upload") {
        base.label = "Photo uploaded (Sales)";
      } else if (a.action === "survey_submitted") {
        base.label = "Satisfaction survey submitted";
      } else if (a.action === "note" && a.category === "customer") {
        base.label = "Note from Houzs";
        base.note = a.note;
      } else {
        base.label = a.action;
      }
      return base;
    });

  let stages: any[] | undefined;
  if (isSales) {
    const hist = await c.env.DB.prepare(
      `SELECT stage, MIN(entered_at) AS entered_at
         FROM assr_stage_history
        WHERE assr_id = ?
        GROUP BY stage`
    )
      .bind(assr_id)
      .all<{ stage: string; entered_at: string }>();
    const enteredAt = new Map((hist.results ?? []).map((h) => [h.stage, h.entered_at]));
    const curIdx = ALL_STAGES.indexOf(cs.stage);
    stages = ALL_STAGES.map((s, i) => ({
      stage: s,
      label: customerStatusFor(s).label,
      entered_at: enteredAt.get(s) ?? null,
      done: curIdx >= 0 && (i < curIdx || (i === curIdx && cs.stage === "completed")),
      current: i === curIdx && cs.stage !== "completed",
    }));
  }

  return c.json({
    viewer,
    stages,
    case: {
      id: cs.id,
      assr_no: cs.assr_no,
      customer_name: cs.customer_name,
      doc_no: isSales ? cs.doc_no : undefined,
      ref_no: isSales ? cs.ref_no : undefined,
      complained_date: cs.complained_date,
      complaint_issue: cs.complaint_issue,
      category: cs.service_category,
      status_label: status.label,
      status_color: status.color,
      stage: cs.stage,
      expected_resolution_at: cs.deadline_at,
      completion_date: cs.completion_date,
      closed_at: cs.closed_at,
      satisfaction_rating: cs.satisfaction_rating,
      resolution_method: cs.resolution_method,
    },
    items: items.results ?? [],
    attachments: atts.results ?? [],
    timeline,
  });
});

app.post("/case/comments", async (c) => {
  const { assr_id, source } = c.get("trackedCase");
  const asSales = source === "sales";
  const limited = await checkRateLimit(c, "portal_comment", `${assr_id}:${source}`, 20, 3600);
  if (limited) return limited;
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  const text = (body.text || "").trim();
  if (!text) return c.json({ error: "Comment cannot be empty" }, 400);
  if (text.length > 2000) return c.json({ error: "Comment is too long" }, 400);

  await c.env.DB.prepare(
    `INSERT INTO assr_activity
       (assr_id, action, from_value, to_value, note, customer_id, source, user_id)
     VALUES (?, ?, NULL, NULL, ?, NULL, ?, NULL)`
  )
    .bind(assr_id, asSales ? "sales_comment" : "customer_comment", text, asSales ? "sales" : "customer")
    .run();
  return c.json({ ok: true });
});

const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_CASE = 20;

app.put("/case/attachments", async (c) => {
  const { assr_id, source } = c.get("trackedCase");
  const asSales = source === "sales";
  const limited = await checkRateLimit(c, "portal_upload", `${assr_id}:${source}`, 15, 3600);
  if (limited) return limited;

  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const fileName = c.req.query("name") || null;
  if (!ALLOWED_EXT.has(ext)) {
    return c.json({ error: `Extension '${ext}' not allowed` }, 415);
  }

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM assr_attachments WHERE assr_id = ?`
  )
    .bind(assr_id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ATTACHMENTS_PER_CASE) {
    return c.json({ error: "Attachment limit reached for this case" }, 413);
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_SIZE) {
    return c.json({ error: "File exceeds 10MB limit" }, 413);
  }

  const contentType =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "png" ? "image/png"
      : "image/webp";

  const key = assrAttachmentKey(assr_id, "evidence", ext);
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });
  const attId = await saveAttachment(c.env, assr_id, key, fileName, contentType, "evidence", null);

  await c.env.DB.prepare(
    `UPDATE assr_attachments
        SET source = ?, visible_to_customer = 1
      WHERE id = ?`
  )
    .bind(asSales ? "sales" : "customer", attId)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO assr_activity
       (assr_id, action, from_value, to_value, note, customer_id, source, user_id)
     VALUES (?, ?, NULL, ?, ?, NULL, ?, NULL)`
  )
    .bind(assr_id, asSales ? "sales_upload" : "customer_upload", String(attId), fileName, asSales ? "sales" : "customer")
    .run();

  return c.json({ id: attId }, 201);
});

app.get("/case/attachments/:attId", async (c) => {
  const { assr_id } = c.get("trackedCase");
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Not found" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT r2_key, content_type
       FROM assr_attachments
      WHERE id = ?
        AND assr_id = ?
        AND visible_to_customer = 1
        AND archived_at IS NULL`
  )
    .bind(attId, assr_id)
    .first<{ r2_key: string; content_type: string | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.POD_BUCKET.get(row.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
});


app.post("/case/comments/:actId/archive", async (c) => {
  const { assr_id, source } = c.get("trackedCase");
  const asSales = source === "sales";
  const actId = parseInt(c.req.param("actId"), 10);
  if (isNaN(actId)) return c.json({ error: "Not found" }, 404);
  const r = await c.env.DB.prepare(
    `UPDATE assr_activity
        SET archived_at = datetime('now')
      WHERE id = ?
        AND assr_id = ?
        AND action = ?
        AND source = ?
        AND archived_at IS NULL`
  )
    .bind(actId, assr_id, asSales ? "sales_comment" : "customer_comment", asSales ? "sales" : "customer")
    .run();
  if (!(r.meta.changes ?? 0)) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.post("/case/attachments/:attId/archive", async (c) => {
  const { assr_id, source } = c.get("trackedCase");
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Not found" }, 404);
  const r = await c.env.DB.prepare(
    `UPDATE assr_attachments
        SET archived_at = datetime('now')
      WHERE id = ?
        AND assr_id = ?
        AND source = ?
        AND archived_at IS NULL`
  )
    .bind(attId, assr_id, source === "sales" ? "sales" : "customer")
    .run();
  if (!(r.meta.changes ?? 0)) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

export default app;
