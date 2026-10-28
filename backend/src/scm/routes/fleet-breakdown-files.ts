// ----------------------------------------------------------------------------
// /api/fleet-breakdown-files - the scene photos and videos kept ON a Fleet
// Health breakdown / incident case.
//
// scm.lorry_breakdown_cases.media_refs (mig 0204) has been written by the
// mobile report (one photo, via the SLIPS upload) but nothing ever showed it,
// and nothing could add a video. Same contract as fleet-work-order-files.ts:
// raw body with ?ext=&name=, a server-minted key, POD_BUCKET, fleet.read /
// fleet.write. Unified fleet: owner-checked by case id, not company-scoped.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { requireHouzsPerm } from "../lib/houzs-perms";
import { breakdownFileKey, isBreakdownFileKeyOf } from "../lib/fleet-coerce";
import type { Env, Variables } from "../env";

export const fleetBreakdownFiles = new Hono<{ Bindings: Env; Variables: Variables }>();
fleetBreakdownFiles.use("*", supabaseAuth);

const IMAGE_MAX = 15 * 1024 * 1024;
const VIDEO_MAX = 50 * 1024 * 1024; // owner, 2026-10-20: 50 MB per video
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
  pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime",
};

const loadRefs = async (sb: Variables["supabase"], caseId: string) => {
  const { data, error } = await sb.from("lorry_breakdown_cases").select("id, media_refs").eq("id", caseId).maybeSingle();
  return { found: !!data, refs: ((data as { media_refs: string[] | null } | null)?.media_refs ?? []), error };
};

// PUT /:caseId?ext=mp4&name=scene.mp4
// ponytail: read-modify-write of media_refs, same as work-order files; the
// screens upload one file at a time.
fleetBreakdownFiles.put("/:caseId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - one fleet shared by HOUZS and 2990 (see fleet-maintenance.ts inHouseLorries).
  const caseId = c.req.param("caseId");
  const sb = c.get("supabase");
  const ext = (c.req.query("ext") || "").toLowerCase();
  if (!MIME[ext]) return c.json({ error: "bad_extension", reason: `Attach a photo, an MP4/MOV video or a PDF (got '${ext || "nothing"}').` }, 400);

  const bd = await loadRefs(sb, caseId);
  if (bd.error) return c.json({ error: "load_failed", reason: bd.error.message }, 500);
  if (!bd.found) return c.json({ error: "breakdown_not_found" }, 404);

  const isVideo = MIME[ext].startsWith("video/");
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "empty_file" }, 400);
  if (body.byteLength > (isVideo ? VIDEO_MAX : IMAGE_MAX)) {
    return c.json({ error: "file_too_large", reason: isVideo ? "A video can be at most 50 MB." : "Max 15 MB." }, 400);
  }

  const key = breakdownFileKey(caseId, ext, c.req.query("name") || null, Date.now());
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType: MIME[ext] } });
  const { error } = await sb.from("lorry_breakdown_cases")
    .update({ media_refs: [...bd.refs, key], updated_at: new Date().toISOString() }).eq("id", caseId);
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  return c.json({ key }, 201);
});

// DELETE /:caseId?key=... - drops the ref; the R2 object too when it is ours.
fleetBreakdownFiles.delete("/:caseId", requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - one fleet shared by HOUZS and 2990 (see fleet-maintenance.ts inHouseLorries).
  const caseId = c.req.param("caseId");
  const key = c.req.query("key") || "";
  const sb = c.get("supabase");
  const bd = await loadRefs(sb, caseId);
  if (bd.error) return c.json({ error: "load_failed", reason: bd.error.message }, 500);
  if (!bd.found || !bd.refs.includes(key)) return c.json({ error: "not_found" }, 404);
  const left = bd.refs.filter((r) => r !== key);
  const { error } = await sb.from("lorry_breakdown_cases")
    .update({ media_refs: left.length ? left : null, updated_at: new Date().toISOString() }).eq("id", caseId);
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  // A legacy slips/ key is left in SLIPS: that bucket has its own reaper.
  if (isBreakdownFileKeyOf(key, caseId)) { try { await c.env.POD_BUCKET.delete(key); } catch { /* harmless orphan */ } }
  return c.json({ ok: true });
});

// GET /:caseId/file?key=... - stream one file back; the key must be on the case.
fleetBreakdownFiles.get("/:caseId/file", requireHouzsPerm("fleet.read"), async (c) => {
  // company-scope: unified fleet - one fleet shared by HOUZS and 2990 (see fleet-maintenance.ts inHouseLorries).
  const caseId = c.req.param("caseId");
  const key = c.req.query("key") || "";
  const bd = await loadRefs(c.get("supabase"), caseId);
  if (bd.error) return c.json({ error: "load_failed", reason: bd.error.message }, 500);
  if (!bd.found || !bd.refs.includes(key)) return c.json({ error: "not_found" }, 404);
  const bucket = isBreakdownFileKeyOf(key, caseId) ? c.env.POD_BUCKET : c.env.SLIPS;
  const obj = bucket ? await bucket.get(key) : null;
  if (!obj) return c.json({ error: "not_found", reason: "The file is missing from storage." }, 404);
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

export default fleetBreakdownFiles;
