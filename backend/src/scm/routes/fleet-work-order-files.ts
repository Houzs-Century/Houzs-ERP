// ----------------------------------------------------------------------------
// /api/fleet-work-order-files - the workshop quotation, invoice and photos kept
// ON a Fleet Health work order (HC-0031).
//
// scm.lorry_work_orders has carried invoice_refs / quote_refs / photo_refs (R2
// keys, mig 0204) since it was built, but nothing ever uploaded a file into
// them: the "Workshop quotation or invoice" scan fills the editor and keeps no
// file. Own router because routes/fleet-maintenance.ts is at its size ceiling.
// Same contract as the compliance attachments there: raw body with
// ?kind=&ext=&name=, a server-minted key, POD_BUCKET, fleet.read / fleet.write.
// Unified fleet: owner-checked by work order id, not company-scoped.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { requireHouzsPerm } from "../lib/houzs-perms";
import {
  WORK_ORDER_FILE_KINDS, isWorkOrderFileKind, isWorkOrderFileKeyOf, workOrderFileKey,
} from "../lib/fleet-coerce";
import type { Env, Variables } from "../env";

export const fleetWorkOrderFiles = new Hono<{ Bindings: Env; Variables: Variables }>();
fleetWorkOrderFiles.use("*", supabaseAuth);

const FILE_MAX = 15 * 1024 * 1024; // a scanned invoice or a phone photo, not a video
const MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg",
  png: "image/png", webp: "image/webp", heic: "image/heic",
};

type Refs = Record<string, string[] | null>;
const loadRefs = (sb: Variables["supabase"], woId: string) =>
  sb.from("lorry_work_orders").select("id, invoice_refs, quote_refs, photo_refs").eq("id", woId).maybeSingle();

// PUT /:woId?kind=invoice|quote|photo&ext=pdf&name=inv.pdf
// ponytail: read-modify-write of the refs array; two uploads to the SAME work
// order in the same instant can drop one ref. The screen uploads one at a time.
// Move to a child table (like lorry_compliance_attachments) if that bites.
fleetWorkOrderFiles.put("/:woId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - one fleet shared by HOUZS and 2990 (see fleet-maintenance.ts inHouseLorries).
  const woId = c.req.param("woId");
  const sb = c.get("supabase");
  const kind = c.req.query("kind");
  if (!isWorkOrderFileKind(kind)) return c.json({ error: "bad_kind", reason: "kind must be invoice, quote or photo." }, 400);
  const ext = (c.req.query("ext") || "").toLowerCase();
  if (!MIME[ext]) return c.json({ error: "bad_extension", reason: `Attach a PDF or an image (got '${ext || "nothing"}').` }, 400);

  const { data: wo, error: loadErr } = await loadRefs(sb, woId);
  if (loadErr) return c.json({ error: "load_failed", reason: loadErr.message }, 500);
  if (!wo) return c.json({ error: "work_order_not_found" }, 404);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "empty_file" }, 400);
  if (body.byteLength > FILE_MAX) return c.json({ error: "file_too_large", reason: "Max 15MB." }, 400);

  const key = workOrderFileKey(woId, kind, ext, c.req.query("name") || null, Date.now());
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: MIME[ext] } });

  const col = WORK_ORDER_FILE_KINDS[kind];
  const refs = [...((wo as unknown as Refs)[col] ?? []), key];
  const { error } = await sb.from("lorry_work_orders").update({ [col]: refs, updated_at: new Date().toISOString() }).eq("id", woId);
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  return c.json({ key, kind }, 201);
});

// DELETE /:woId?key=... - drops the ref AND the R2 object.
fleetWorkOrderFiles.delete("/:woId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - one fleet shared by HOUZS and 2990 (see fleet-maintenance.ts inHouseLorries).
  const woId = c.req.param("woId");
  const key = c.req.query("key") || "";
  const sb = c.get("supabase");
  if (!isWorkOrderFileKeyOf(key, woId)) return c.json({ error: "not_found" }, 404);
  const { data: wo, error: loadErr } = await loadRefs(sb, woId);
  if (loadErr) return c.json({ error: "load_failed", reason: loadErr.message }, 500);
  if (!wo) return c.json({ error: "work_order_not_found" }, 404);

  const patch: Record<string, unknown> = {};
  for (const col of Object.values(WORK_ORDER_FILE_KINDS)) {
    const refs = (wo as unknown as Refs)[col] ?? [];
    if (refs.includes(key)) { const left = refs.filter((r) => r !== key); patch[col] = left.length ? left : null; }
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "not_found" }, 404);
  const { error } = await sb.from("lorry_work_orders").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", woId);
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  // Row first, object second: a failed object delete leaves a harmless orphan,
  // the reverse could leave a ref pointing at nothing.
  try { await c.env.POD_BUCKET.delete(key); } catch { /* see above */ }
  return c.json({ ok: true });
});

// GET /:woId/file?key=... - stream one file back.
fleetWorkOrderFiles.get("/:woId/file", requireHouzsPerm("fleet.read"), async (c) => {
  const key = c.req.query("key") || "";
  if (!isWorkOrderFileKeyOf(key, c.req.param("woId"))) return c.json({ error: "not_found" }, 404);
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

export default fleetWorkOrderFiles;
