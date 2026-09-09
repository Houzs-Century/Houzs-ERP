// ---------------------------------------------------------------------------
// Document reference numbers + document types (owner 2026-09-06, plan A).
//
//   GET   /api/document-refs/next     — the number the next mint would give
//                                       (?typeCode=, ?deptCode= — the caller's
//                                       own department when omitted); a
//                                       preview, nothing claimed
//   GET   /api/document-refs/:refNo   — resolve a number to the record it
//                                       indexes (any signed-in user; the
//                                       record itself is still behind its own
//                                       module's gate — this only says what
//                                       kind of record and whether it is void)
//   GET   /api/document-types          — the type registry (active only unless
//                                       ?all=1)
//   POST  /api/document-types          — add a type            (settings.manage)
//   PATCH /api/document-types/:code    — label / attachment_required /
//                                       is_active               (settings.manage)
//
// Every route here sits behind the /api/* auth middleware (src/index.ts), so
// a caller is always a signed-in user.
//
// Minting is NOT a route: a number is minted by the module that owns the
// record (the announcement approval, next), through mintDocumentRef().
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import {
  findRef,
  getDocumentType,
  listDocumentTypes,
  normaliseCode,
  peekNextRefNo,
} from "../services/documentRefs";

const app = new Hono<{ Bindings: Env }>();

// Before /:refNo — a literal segment must not be swallowed by the param route.
app.get("/document-refs/next", async (c) => {
  const typeCode = normaliseCode(c.req.query("typeCode"));
  if (!typeCode) return c.json({ success: false, error: "typeCode must be 2–4 letters (e.g. ANN, MEMO)." }, 400);
  const deptGiven = c.req.query("deptCode");
  let deptCode: string | null;
  let deptName: string | null = null;
  if (deptGiven == null || deptGiven === "") {
    // The submitter's department — the [DEPT] segment an approval would use.
    const user = c.get("user");
    // company-scope: one user row by primary key, joined to the global departments table.
    const row = await c.env.DB.prepare(
      "SELECT d.name AS name, d.code AS code FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?",
    )
      .bind(user.id)
      .first<{ name?: string | null; code?: string | null }>();
    deptName = row?.name ?? null;
    deptCode = normaliseCode(row?.code ?? "");
    if (!deptCode) {
      return c.json({
        success: true,
        data: null,
        reason: deptName
          ? `${deptName} has no department code yet, so this cannot be numbered. Set one under Team → Departments.`
          : "You have no department, so this cannot be numbered. Team → Members assigns one.",
      });
    }
  } else {
    deptCode = normaliseCode(deptGiven);
    if (!deptCode) return c.json({ success: false, error: "deptCode must be 2–4 letters (e.g. OPS)." }, 400);
  }
  const next = await peekNextRefNo(c.env, { deptCode, typeCode });
  return c.json({ success: true, data: { ...next, deptName } });
});

app.get("/document-refs/:refNo", async (c) => {
  const ref = await findRef(c.env, c.req.param("refNo"));
  if (!ref) return c.json({ success: false, error: "No document carries that reference number." }, 404);
  return c.json({ success: true, data: ref });
});

app.get("/document-types", async (c) => {
  const all = c.req.query("all") === "1";
  return c.json({ success: true, data: await listDocumentTypes(c.env, all) });
});

app.post("/document-types", requirePermission("settings.manage"), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; label?: unknown; attachmentRequired?: unknown };
  const code = normaliseCode(body.code);
  const label = String(body.label ?? "").trim();
  if (!code) return c.json({ success: false, error: "Type code must be 2–4 letters (e.g. ANN, SOP)." }, 400);
  if (!label) return c.json({ success: false, error: "Label is required." }, 400);
  if (await getDocumentType(c.env, code)) {
    return c.json({ success: false, error: `Type ${code} already exists.` }, 409);
  }
  // company-scope: a global policy table (one row per document type), not per company.
  await c.env.DB.prepare(
    "INSERT INTO document_types (code, label, attachment_required, is_active, created_at) VALUES (?, ?, ?, 1, ?)",
  )
    .bind(code, label, body.attachmentRequired === true ? 1 : 0, new Date().toISOString())
    .run();
  return c.json({ success: true, data: await getDocumentType(c.env, code) }, 201);
});

app.patch("/document-types/:code", requirePermission("settings.manage"), async (c) => {
  const code = normaliseCode(c.req.param("code"));
  if (!code) return c.json({ success: false, error: "Type code must be 2–4 letters." }, 400);
  const current = await getDocumentType(c.env, code);
  if (!current) return c.json({ success: false, error: `Type ${code} does not exist.` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; attachmentRequired?: unknown; isActive?: unknown };
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.label === "string" && body.label.trim()) {
    sets.push("label = ?");
    binds.push(body.label.trim());
  }
  if (typeof body.attachmentRequired === "boolean") {
    sets.push("attachment_required = ?");
    binds.push(body.attachmentRequired ? 1 : 0);
  }
  if (typeof body.isActive === "boolean") {
    sets.push("is_active = ?");
    binds.push(body.isActive ? 1 : 0);
  }
  if (sets.length === 0) return c.json({ success: false, error: "Nothing to change." }, 400);
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(code);
  // company-scope: a global policy table (one row per document type), not per company.
  await c.env.DB.prepare(`UPDATE document_types SET ${sets.join(", ")} WHERE code = ?`)
    .bind(...binds)
    .run();
  return c.json({ success: true, data: await getDocumentType(c.env, code) });
});

export default app;
