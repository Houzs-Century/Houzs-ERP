/**
 * company-scope-file: every route here is a CAPABILITY token, not a session, and
 * the token is a STRONGER scope than a company predicate — it resolves to exactly
 * ONE case. Verified 2026-08-19 rather than taken from the paragraph below, which
 * is the shape CLAUDE.md warns about:
 *
 *   · services/supplierPortal.ts resolveSupplierToken() reads
 *     assr_supplier_tokens by token and returns a single { assr_id, creditor_code },
 *     refusing a revoked or expired row;
 *   · middleware/supplierTrack.ts 401s when that resolve fails, so no handler runs
 *     without a scope;
 *   · every write below binds `assr_id` FROM THAT SCOPE and never a route param.
 *     Checked on all nine routes: the five the gate flags carry no
 *     `c.req.param(...)` at all, and the two `/attachments/:attId` routes bind
 *     attId AND assr_id together, so the attachment id cannot escape the case.
 *
 * A company predicate would add nothing: the caller is a supplier, has no company
 * session, and cannot name a second case. If a route here ever binds an id that
 * came from the REQUEST, this exemption stops being true — delete it.
 *
 * Supplier Portal API — proposal §6.3.
 *
 * All routes are gated by the supplierTrack middleware (see
 * src/index.ts), which resolves the bearer token to one case +
 * supplier scope. Every query is already scoped — no cross-case
 * access is possible from a single token.
 *
 * Every response field is hand-picked. The supplier sees the action
 * block (item, issue, agreed lead time, pickup/delivery windows) but
 * NOT customer phone/address detail (only address line 1 + postcode
 * for delivery routing) or internal cost.
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { checkRateLimit } from "../middleware/rateLimit";
import { assrAttachmentKey, saveAttachment } from "../services/assr";

const app = new Hono<{ Bindings: Env }>();

// Mirrors the customer-portal upload route — same allow-list and limits
// so the supplier can't slip in a bigger file than the customer can.
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ATTACHMENTS_PER_CASE = 20;

// The PictureBlock slots map to existing category values so the
// assr_attachments CHECK constraint accepts them without a migration.
//   "Service Issue"        → evidence    (proof of the problem)
//   "Operation QC Checked" → completion  (proof of finished work)
const SUPPLIER_CATEGORY = new Set(["evidence", "completion"]);

// ── GET /case ───────────────────────────────────────────────────────
//
// One-shot bundle for the supplier portal page. Returns the slim case
// view + items + supplier-visible attachments + stage history (for the
// Workflow Progress Tracker).

app.get("/case", async (c) => {
  const { assr_id } = c.get("supplierScope");

  // Hand-picked columns for the supplier view — no customer phone,
  // full address, or internal cost. addr1 + addr4 (line 1 + postcode)
  // are for delivery routing only. Mig 106 added supplier_service_note
  // (supplier owns) + goods_returned_note (Houzs writes, supplier
  // reads).
  //
  // NB: keep this SELECT free of SQL `--` comments. The d1-compat
  // shim over Hyperdrive collapses the prepared statement to a
  // single line before sending it to Postgres, so a `--` anywhere
  // in the middle comments out the entire tail (including the FROM
  // clause), producing "syntax error at end of input". Prose stays
  // in JS comments here; the SQL is a column list, nothing more.
  const cs = await c.env.DB.prepare(
    `SELECT id, assr_no, stage, complained_date, complaint_issue,
            issue_category, resolution_method, service_category,
            po_no, ref_no,
            addr1, addr4, location,
            customer_name,
            supplier_pickup_at, items_ready_at,
            do_date, delivery_order,
            creditor_code,
            stage_entered_at, stage_target_days,
            supplier_service_note, goods_returned_note,
            supplier_accepted_at, supplier_quote_labour,
            supplier_quote_materials, supplier_quote_at
       FROM assr_cases WHERE id = ?`
  )
    .bind(assr_id)
    .first<any>();
  if (!cs) return c.json({ error: "Not found" }, 404);

  const items = await c.env.DB.prepare(
    `SELECT id, item_code, item_description, qty FROM assr_items
      WHERE assr_id = ? ORDER BY id`
  )
    .bind(assr_id)
    .all();

  // visible_to_customer = 1 is the only "safe to show outside Houzs"
  // flag the schema has: it defaults to 1 and staff flip it to 0 on the
  // case page precisely to mark a photo internal. Without this
  // predicate the supplier portal served EVERY attachment on the case,
  // including the ones staff had explicitly hidden. The customer portal
  // has had the filter since mig 016 (routes/portal.ts) — this router
  // was cloned from it and dropped the line.
  //
  // Reusing the customer flag for a supplier audience is a deliberate
  // fail-closed choice, not a shortcut: a photo marked internal stays
  // internal to BOTH outside parties. The cost is that hiding a
  // supplier's own upload also hides it from that supplier — the safe
  // direction to be wrong in, and the one to revisit only if staff ask
  // for a separate visible_to_supplier flag.
  const attachments = await c.env.DB.prepare(
    `SELECT id, category, file_name, content_type, created_at
       FROM assr_attachments
      WHERE assr_id = ?
        AND visible_to_customer = 1
        AND archived_at IS NULL
      ORDER BY created_at DESC`
  )
    .bind(assr_id)
    .all();

  const history = await c.env.DB.prepare(
    `SELECT id, stage, entered_at, exited_at, target_days,
            status, skipped, skip_reason
       FROM assr_stage_history
      WHERE assr_id = ?
      ORDER BY entered_at ASC, id ASC`
  )
    .bind(assr_id)
    .all();

  // Supplier name from the creditors mirror
  const supplierName = cs.creditor_code
    ? (
        await c.env.DB.prepare(
          `SELECT company_name FROM creditors WHERE creditor_code = ?`
        )
          .bind(cs.creditor_code)
          .first<{ company_name: string | null }>()
      )?.company_name ?? null
    : null;

  return c.json({
    case: cs,
    supplier_name: supplierName,
    items: items.results ?? [],
    attachments: attachments.results ?? [],
    stage_history: history.results ?? [],
  });
});

// ── POST /stage — REMOVED (design handoff 2026-07-02) ───────────────
//
// The supplier job progress is READ-ONLY and set by Houzs; suppliers
// can no longer advance the workflow from the portal. Their levers are
// Accept job, Submit quote, photos, service note, and remarks. The
// endpoint returns 410 so any stale portal tab gets a clear error
// instead of a silent 404.

app.post("/stage", (c) =>
  c.json(
    { error: "Stage updates were removed from the supplier portal — Houzs Operations advances the case." },
    410
  )
);

// ── POST /accept ────────────────────────────────────────────────────
//
// Supplier presses "Accept job". Idempotent — a second call returns
// the original acceptance timestamp instead of overwriting it.

app.post("/accept", async (c) => {
  // company-scope: capability token, not a session — the bearer resolves to exactly ONE assr_id and every write binds THAT id, never a route param. Evidence in this file's header, verified 2026-08-19.
  const { assr_id } = c.get("supplierScope");
  const existing = await c.env.DB.prepare(
    `SELECT supplier_accepted_at FROM assr_cases WHERE id = ?`
  )
    .bind(assr_id)
    .first<{ supplier_accepted_at: string | null }>();
  if (existing?.supplier_accepted_at) {
    return c.json({ ok: true, accepted_at: existing.supplier_accepted_at });
  }
  await c.env.DB.prepare(
    `UPDATE assr_cases SET supplier_accepted_at = datetime('now') WHERE id = ?`
  )
    .bind(assr_id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel)
     VALUES (?, 'note', 'Supplier accepted the job', 'supplier', 'supplier_portal')`
  )
    .bind(assr_id)
    .run();
  const row = await c.env.DB.prepare(
    `SELECT supplier_accepted_at FROM assr_cases WHERE id = ?`
  )
    .bind(assr_id)
    .first<{ supplier_accepted_at: string | null }>();
  return c.json({ ok: true, accepted_at: row?.supplier_accepted_at ?? null });
});

// ── POST /quote ─────────────────────────────────────────────────────
//
// Labour + materials quote (RM). Houzs reviews before any price
// reaches the customer. Re-submitting overwrites the stored pair and
// refreshes supplier_quote_at; each submission is also logged to the
// activity stream so ops keeps the full history.

app.post("/quote", async (c) => {
  // company-scope: capability token, not a session — the bearer resolves to exactly ONE assr_id and every write binds THAT id, never a route param. Evidence in this file's header, verified 2026-08-19.
  const { assr_id } = c.get("supplierScope");
  const body = await c.req
    .json<{ labour?: number; materials?: number }>()
    .catch(() => ({} as { labour?: number; materials?: number }));
  const labour = Number(body.labour);
  const materials = Number(body.materials);
  if (!Number.isFinite(labour) || labour < 0 || !Number.isFinite(materials) || materials < 0) {
    return c.json({ error: "labour and materials must be numbers ≥ 0" }, 400);
  }
  if (labour > 1_000_000 || materials > 1_000_000) {
    return c.json({ error: "quote amount out of range" }, 400);
  }
  await c.env.DB.prepare(
    `UPDATE assr_cases
        SET supplier_quote_labour = ?,
            supplier_quote_materials = ?,
            supplier_quote_at = datetime('now')
      WHERE id = ?`
  )
    .bind(labour, materials, assr_id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel)
     VALUES (?, 'note', ?, 'supplier', 'supplier_portal')`
  )
    .bind(
      assr_id,
      `Supplier quote: labour RM ${labour.toFixed(2)} + materials RM ${materials.toFixed(2)} = RM ${(labour + materials).toFixed(2)}`
    )
    .run();
  return c.json({ ok: true });
});

// ── POST /remarks ───────────────────────────────────────────────────
//
// Free-text supplier remark — logged to the activity stream with
// source_channel='supplier_portal' so the timeline distinguishes it
// from staff notes.

app.post("/remarks", async (c) => {
  // company-scope: capability token, not a session — the bearer resolves to exactly ONE assr_id and every write binds THAT id, never a route param. Evidence in this file's header, verified 2026-08-19.
  const { assr_id } = c.get("supplierScope");
  // Spam brake — same treatment as the customer portal's comments.
  const limited = await checkRateLimit(c, "supplier_remark", String(assr_id), 20, 3600);
  if (limited) return limited;
  const body = await c.req.json<{ note?: string }>();
  const note = (body.note || "").trim();
  if (!note) return c.json({ error: "note is required" }, 400);
  const clipped = note.slice(0, 2000);
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel)
     VALUES (?, 'note', ?, 'supplier', 'supplier_portal')`
  )
    .bind(assr_id, clipped)
    .run();
  // Mig 106 — main case page's "Supplier status update" (action_remark)
  // mirrors the latest supplier-portal note so ops don't have to hunt
  // through the activity log to see the current status. Ops can still
  // hand-edit action_remark on the main page; the next supplier note
  // overwrites it. Full history stays in assr_activity.
  await c.env.DB.prepare(
    `UPDATE assr_cases SET action_remark = ? WHERE id = ?`
  )
    .bind(clipped, assr_id)
    .run();
  return c.json({ ok: true });
});

// ── PUT /service-note ───────────────────────────────────────────────
//
// Mig 106 — persistent service record the supplier writes when
// they've serviced the item. Unlike /remarks (which fires one-off
// notes into the activity log), this field is the current-state
// blob the supplier owns and can rewrite. Ops sees the same value
// on the main case page's QC Inspection card.

app.put("/service-note", async (c) => {
  // company-scope: capability token, not a session — the bearer resolves to exactly ONE assr_id and every write binds THAT id, never a route param. Evidence in this file's header, verified 2026-08-19.
  const { assr_id } = c.get("supplierScope");
  const body = await c.req.json<{ note?: string | null }>();
  const raw = typeof body.note === "string" ? body.note.trim() : "";
  const clipped = raw ? raw.slice(0, 2000) : null;
  await c.env.DB.prepare(
    `UPDATE assr_cases SET supplier_service_note = ? WHERE id = ?`
  )
    .bind(clipped, assr_id)
    .run();
  return c.json({ ok: true });
});

// ── PUT /attachments ────────────────────────────────────────────────
//
// Photo upload from the supplier — used by the PictureBlock slots on
// the supplier-portal page. Mirrors POD's customer-portal route (mig 016
// + routes/portal.ts) but writes the attachment with source_channel
// stamped in the activity log so audit can tell supplier uploads apart
// from staff and customer ones.

app.put("/attachments", async (c) => {
  const { assr_id } = c.get("supplierScope");
  // Upload brake — bounds churn around the 20-per-case attachment cap.
  const limited = await checkRateLimit(c, "supplier_upload", String(assr_id), 15, 3600);
  if (limited) return limited;

  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const fileName = c.req.query("name") || null;
  const category = (c.req.query("category") || "evidence").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return c.json({ error: `Extension '${ext}' not allowed` }, 415);
  }
  if (!SUPPLIER_CATEGORY.has(category)) {
    return c.json({ error: "category must be 'evidence' or 'completion'" }, 400);
  }

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM assr_attachments WHERE assr_id = ? AND archived_at IS NULL`
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
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
      ? "image/png"
      : "image/webp";

  const key = assrAttachmentKey(assr_id, category, ext);
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });
  const attId = await saveAttachment(c.env, assr_id, key, fileName, contentType, category, null);

  // Audit entry — `source_channel` differentiates this from staff /
  // customer uploads in the timeline.
  await c.env.DB.prepare(
    `INSERT INTO assr_activity
       (assr_id, action, from_value, to_value, note, category, source_channel)
     VALUES (?, 'supplier_upload', NULL, ?, ?, ?, 'supplier_portal')`
  )
    .bind(assr_id, String(attId), fileName, category)
    .run();

  return c.json({ id: attId, category }, 201);
});

// ── GET /attachments/:attId ─────────────────────────────────────────
//
// Stream an attachment binary back. Re-checks scope on every request
// so a stolen attachment URL with a stale token is rejected.
//
// The visibility predicate is repeated here and NOT left to the listing
// above: this route takes an attachment id straight from the URL, so
// filtering only the list would hide internal photos from the page
// while still serving their bytes to anyone walking the id space —
// ids are sequential. Mirrors routes/portal.ts's customer equivalent,
// which guards both places for the same reason.

app.get("/attachments/:attId", async (c) => {
  const { assr_id } = c.get("supplierScope");
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

// ── POST /attachments/:attId/archive ────────────────────────────────
//
// Suppliers can retract a photo they uploaded by mistake, as long as
// it was theirs (matched by the latest supplier_upload activity row).
// Anything authored by staff or customer is off-limits.

app.post("/attachments/:attId/archive", async (c) => {
  const { assr_id } = c.get("supplierScope");
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Not found" }, 404);

  const wasSupplier = await c.env.DB.prepare(
    `SELECT 1 FROM assr_activity
      WHERE assr_id = ?
        AND action = 'supplier_upload'
        AND to_value = ?
        AND source_channel = 'supplier_portal'
      LIMIT 1`
  )
    .bind(assr_id, String(attId))
    .first();
  if (!wasSupplier) return c.json({ error: "Not found" }, 404);

  const r = await c.env.DB.prepare(
    `UPDATE assr_attachments
        SET archived_at = datetime('now')
      WHERE id = ?
        AND assr_id = ?
        AND archived_at IS NULL`
  )
    .bind(attId, assr_id)
    .run();
  if (!(r.meta.changes ?? 0)) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

export default app;
