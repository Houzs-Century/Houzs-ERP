/* GET /api/fleet-maintenance/work-orders/:woId/photo/:n — the n-th photo on a
   work order (photo_refs: the reporter's photos and a Lorry service job's
   POD). Nothing showed them. Kept out of fleet-maintenance.ts, which is at its
   file-size ceiling; mounted on the same prefix in index.ts. */
import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { requireHouzsPerm } from "../lib/houzs-perms";
import { streamPhoto } from "./delivery-job-progress";
import type { Env, Variables } from "../env";

export const fleetWorkOrderPhotos = new Hono<{ Bindings: Env; Variables: Variables }>();
// Auth on THIS route only: a use("*") here would run for every fleet request mounted after it.
fleetWorkOrderPhotos.get("/work-orders/:woId/photo/:n", supabaseAuth, requireHouzsPerm("fleet.read"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries (fleet-maintenance.ts).
  const { data, error } = await c.get("supabase").from("lorry_work_orders").select("photo_refs").eq("id", c.req.param("woId")).maybeSingle();
  if (error) return c.json({ error: "load_failed", reason: error.message }, 500);
  const refs = (data as { photo_refs: string[] | null } | null)?.photo_refs ?? [];
  return streamPhoto(c, refs[Number(c.req.param("n"))]);
});
