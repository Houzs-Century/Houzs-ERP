// ---------------------------------------------------------------------------
// Memo register (owner 2026-09-08, "每个部门自动生成 memo reference number" —
// the register half of "两个都要"; mig 20260909T0500).
//
// A department writes a memo outside the ERP (Word / PDF) and needs the
// official number: register it here — title, department, date, the file —
// and the number is minted AT CREATION through the same mint the announcement
// approval uses (services/documentRefs.ts, series <DEPT>-MEMO-<YYMM>), so a
// memo registered here and a memo composed as a notice share ONE sequence per
// department and month.
//
//   GET  /api/memos                 — the register (any signed-in user);
//                                     ?departmentId=, ?includeVoided=1
//   PUT  /api/memos/upload?ext=     — the file (two-step, like the notices)
//   POST /api/memos                 — register + mint (own department, or any
//                                     department for memos.manage / *)
//   GET  /api/memos/:id/file        — stream the file (any signed-in user)
//   POST /api/memos/:id/void        — { reason } (the registrar, or
//                                     memos.manage / *); never DELETE
//
// Every route sits behind the /api/* auth middleware (src/index.ts). The
// attachment policy is the MEMO row of document_types (Settings → Documents),
// read by services/announcementFiles.ts exactly as the notices read theirs.
// Prepared SQL only (d1-compat): no `--` comments inside a statement.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../types";
import type { AuthUser } from "../services/auth";
import { hasPermission } from "../services/permissions";
import { mintDocumentRef, normaliseCode, voidDocumentRef } from "../services/documentRefs";
import { ANNOUNCEMENT_DOC_TYPE, attachmentRequiredForType, resolveDocType } from "../services/announcementFiles";
import { writeAudit } from "../services/audit";

// The default family. Since mig 20260909T0800 (owner 2026-09-09: 每个 memo,
// SOP, warning, notice 都按部门编号) a registration names its type — any ACTIVE
// registry row but ANN (an announcement is composed, never registered) — and
// the number is minted on that type's own department series.
const MEMO_TYPE = "MEMO";
const MEMO_ENTITY = "memo";
export const MEMOS_MANAGE = "memos.manage";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
/** Served inline: a PDF or a raster image; anything else downloads inertly. */
function isInlineMime(mime: string): boolean {
  return mime === "application/pdf" || mime.startsWith("image/");
}
const MAX_BYTES = 25 * 1024 * 1024;

const app = new Hono<{ Bindings: Env }>();

function canManage(user: AuthUser): boolean {
  const granted = user.permissions_set;
  return hasPermission(granted, "*") || hasPermission(granted, MEMOS_MANAGE);
}

function genId(): string {
  return `memo-${crypto.randomUUID().replace(/-/g, "").slice(0, 11)}`;
}

/** Today in Malaysia time as YYYY-MM-DD — the memo's default date. */
function todayMyt(now = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

type Row = {
  id: string;
  title: string;
  department_id?: number; departmentId?: number;
  department_name?: string | null; departmentName?: string | null;
  dept_code?: string; deptCode?: string;
  doc_type?: string; docType?: string;
  memo_date?: string; memoDate?: string;
  notes?: string | null;
  file_key?: string | null; fileKey?: string | null;
  file_name?: string | null; fileName?: string | null;
  file_mime?: string | null; fileMime?: string | null;
  file_size?: number | null; fileSize?: number | null;
  ref_no?: string | null; refNo?: string | null;
  created_by?: number | null; createdBy?: number | null;
  created_by_name?: string | null; createdByName?: string | null;
  created_at?: string; createdAt?: string;
  voided_by?: number | null; voidedBy?: number | null;
  voided_by_name?: string | null; voidedByName?: string | null;
  voided_at?: string | null; voidedAt?: string | null;
  void_reason?: string | null; voidReason?: string | null;
};

function toPublic(r: Row) {
  const fileKey = r.fileKey ?? r.file_key ?? null;
  return {
    id: r.id,
    refNo: r.refNo ?? r.ref_no ?? null,
    title: r.title,
    departmentId: Number(r.departmentId ?? r.department_id),
    departmentName: r.departmentName ?? r.department_name ?? null,
    deptCode: r.deptCode ?? r.dept_code ?? "",
    docType: String(r.docType ?? r.doc_type ?? MEMO_TYPE).toUpperCase(),
    memoDate: r.memoDate ?? r.memo_date ?? "",
    notes: r.notes ?? null,
    file: fileKey
      ? {
          name: r.fileName ?? r.file_name ?? null,
          mime: r.fileMime ?? r.file_mime ?? null,
          size: r.fileSize ?? r.file_size ?? null,
        }
      : null,
    createdBy: r.createdBy ?? r.created_by ?? null,
    createdByName: r.createdByName ?? r.created_by_name ?? null,
    createdAt: r.createdAt ?? r.created_at ?? "",
    voidedBy: r.voidedBy ?? r.voided_by ?? null,
    voidedByName: r.voidedByName ?? r.voided_by_name ?? null,
    voidedAt: r.voidedAt ?? r.voided_at ?? null,
    voidReason: r.voidReason ?? r.void_reason ?? null,
  };
}

const SELECT = `SELECT m.*, d.name AS department_name, u.name AS created_by_name, v.name AS voided_by_name
    FROM memos m
    LEFT JOIN departments d ON d.id = m.department_id
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN users v ON v.id = m.voided_by`;

async function loadOne(env: Env, id: string): Promise<Row | null> {
  // company-scope: a department document register keyed by primary key; departments are global, not per company.
  return env.DB.prepare(`${SELECT} WHERE m.id = ?`).bind(id).first<Row>();
}

app.get("/", async (c) => {
  const deptRaw = c.req.query("departmentId");
  const deptId = deptRaw ? Number(deptRaw) : null;
  const includeVoided = c.req.query("includeVoided") === "1";
  const where: string[] = [];
  const binds: unknown[] = [];
  if (deptId != null && Number.isFinite(deptId) && deptId > 0) {
    where.push("m.department_id = ?");
    binds.push(deptId);
  }
  if (!includeVoided) where.push("m.voided_at IS NULL");
  const typeFilter = normaliseCode(c.req.query("docType"));
  if (typeFilter) {
    where.push("m.doc_type = ?");
    binds.push(typeFilter);
  }
  // company-scope: a department document register; departments are global, not per company.
  const res = await c.env.DB.prepare(
    `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY m.created_at DESC LIMIT 500`,
  )
    .bind(...binds)
    .all<Row>();
  return c.json({ success: true, data: res.results.map(toPublic) });
});

app.put("/upload", async (c) => {
  const ext = (c.req.query("ext") || "").toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return c.json({ success: false, error: "Unsupported file type — PDF, Word, Excel or an image." }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ success: false, error: "Empty file." }, 400);
  if (body.byteLength > MAX_BYTES) return c.json({ success: false, error: "Max 25MB" }, 400);
  const key = `memos/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: mime } });
  return c.json({ success: true, r2Key: key, mime, size: body.byteLength });
});

app.post("/", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = String(body.title ?? "").trim();
  if (!title) return c.json({ success: false, error: "Title is required" }, 400);
  if (title.length > 200) return c.json({ success: false, error: "Title too long (200 max)" }, 400);
  const departmentId = Number(body.departmentId ?? user.department_id ?? NaN);
  if (!Number.isFinite(departmentId) || departmentId <= 0) {
    return c.json({ success: false, error: "Pick a department." }, 400);
  }
  if (!canManage(user) && departmentId !== (user.department_id ?? null)) {
    return c.json({ success: false, error: "You can register documents for your own department only." }, 403);
  }
  const typeRaw = body.docType == null || String(body.docType).trim() === "" ? MEMO_TYPE : body.docType;
  const resolved = await resolveDocType(c.env, typeRaw);
  if ("error" in resolved) return c.json({ success: false, error: resolved.error }, 400);
  const docType = resolved.code;
  if (docType === ANNOUNCEMENT_DOC_TYPE) {
    return c.json({ success: false, error: "An announcement is composed in Announcements, not registered here." }, 400);
  }
  // company-scope: departments are global master data.
  const dept = await c.env.DB.prepare("SELECT id, name, code FROM departments WHERE id = ?")
    .bind(departmentId)
    .first<{ id: number; name: string; code?: string | null }>();
  if (!dept) return c.json({ success: false, error: "Department not found." }, 404);
  const deptCode = String(dept.code ?? "").trim().toUpperCase();
  if (!deptCode) {
    return c.json(
      { success: false, error: `Department "${dept.name}" has no code yet, so it cannot number documents. Set one under Team → Departments.` },
      409,
    );
  }
  const memoDate = String(body.memoDate ?? "").trim() || todayMyt();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(memoDate) || Number.isNaN(Date.parse(memoDate))) {
    return c.json({ success: false, error: "Invalid memo date" }, 400);
  }
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) || null : null;
  const fileIn = body.file && typeof body.file === "object" ? (body.file as Record<string, unknown>) : null;
  const fileKey = fileIn ? String(fileIn.r2Key ?? "").trim() : "";
  if (fileIn && !fileKey.startsWith("memos/")) return c.json({ success: false, error: "forbidden key" }, 400);
  if (!fileKey && (await attachmentRequiredForType(c.env, docType))) {
    return c.json({ success: false, error: `An attachment is required for a ${docType} document (Settings → Documents). Upload the file first.` }, 400);
  }
  const id = genId();
  const now = Date.now();
  const ref = await mintDocumentRef(c.env, {
    deptCode,
    typeCode: docType,
    entityType: MEMO_ENTITY,
    entityId: id,
    createdBy: user.id,
    now,
  });
  // company-scope: a department document register; departments are global, not per company.
  await c.env.DB.prepare(
    `INSERT INTO memos
       (id, title, department_id, dept_code, doc_type, memo_date, notes, file_key, file_name, file_mime, file_size, ref_no, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      title,
      departmentId,
      deptCode,
      docType,
      memoDate,
      notes,
      fileKey || null,
      fileIn ? String(fileIn.name ?? "").trim() || null : null,
      fileIn ? String(fileIn.mime ?? "").trim() || null : null,
      fileIn && Number.isFinite(Number(fileIn.size)) ? Number(fileIn.size) : null,
      ref.refNo,
      user.id,
      new Date(now).toISOString(),
    )
    .run();
  await writeAudit(c.env, {
    action: "memo.create",
    entityType: MEMO_ENTITY,
    entityId: id,
    summary: `Registered ${docType} ${ref.refNo}: ${title}`,
    meta: { refNo: ref.refNo, docType, departmentId, memoDate, file: fileKey || null },
    actorId: user.id,
    actorEmail: user.email,
  });
  const row = await loadOne(c.env, id);
  return c.json({ success: true, data: row ? toPublic(row) : null }, 201);
});

app.get("/:id/file", async (c) => {
  const row = await loadOne(c.env, c.req.param("id"));
  const key = row ? (row.fileKey ?? row.file_key ?? null) : null;
  if (!row || !key) return c.json({ success: false, error: "Not found" }, 404);
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ success: false, error: "Not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  const mime = headers.get("content-type") ?? "application/octet-stream";
  const name = (row.fileName ?? row.file_name ?? "memo").replace(/["\r\n]/g, "");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-disposition",
    `${isInlineMime(mime) ? "inline" : "attachment"}; filename="${name}"`,
  );
  return new Response(obj.body, { headers });
});

app.post("/:id/void", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const row = await loadOne(c.env, id);
  if (!row) return c.json({ success: false, error: "Not found" }, 404);
  const createdBy = row.createdBy ?? row.created_by ?? null;
  if (!canManage(user) && createdBy !== user.id) {
    return c.json({ success: false, error: "Only the person who registered this memo (or a memo manager) can void it." }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const reason = String(body.reason ?? "").trim();
  if (!reason) return c.json({ success: false, error: "A reason is required to void a memo." }, 400);
  if (reason.length > 1000) return c.json({ success: false, error: "Reason too long (1000 max)." }, 400);
  if ((row.voidedAt ?? row.voided_at) != null) return c.json({ success: true, data: toPublic(row) });
  const refNo = row.refNo ?? row.ref_no ?? null;
  const now = Date.now();
  if (refNo) await voidDocumentRef(c.env, refNo, user.id, reason, now);
  // company-scope: a department document register keyed by primary key.
  await c.env.DB.prepare("UPDATE memos SET voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?")
    .bind(user.id, new Date(now).toISOString(), reason, id)
    .run();
  await writeAudit(c.env, {
    action: "memo.void",
    entityType: MEMO_ENTITY,
    entityId: id,
    summary: `Voided memo ${refNo ?? id}: ${reason}`,
    meta: { refNo, reason },
    actorId: user.id,
    actorEmail: user.email,
  });
  const fresh = await loadOne(c.env, id);
  return c.json({ success: true, data: fresh ? toPublic(fresh) : null });
});

export default app;
