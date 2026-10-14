// ----------------------------------------------------------------------------
// pos-device — what a PREPARED booth terminal calls on its own, with the
// device token minted at Prepare device (POST /api/pos-admin/device/register)
// in the `X-POS-Device` header. No staff session: cashiers are not ERP users.
//
//   GET  /ping                 reachability (the sync engine's captive-portal check)
//   GET  /prepare              the bundle again (Refresh catalog / re-prepare)
//   POST /heartbeat            terminal vitals (layout P14 / E7)
//
// Mounted BEFORE the global /api/* auth gate (like /api/pos); every route
// below re-applies its own guard: the token's hash must match an ACTIVE
// terminal, and that terminal's company is the scope of everything read.
// The sales batch, void and backup import join in the later build steps.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { pos_terminals } from "../db/schema";
import { getBrandingForCompany } from "../services/branding";
import { deviceTokenHash, isDeviceToken } from "./lib/pos-bundle";
import { loadPosBundle, type BundleCompany } from "./lib/pos-bundle-load";

type Terminal = typeof pos_terminals.$inferSelect;
type Vars = { terminal: Terminal };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const posDevice = new Hono<{ Bindings: Env; Variables: Vars }>();

posDevice.get("/ping", (c) => c.json({ ok: true, at: new Date().toISOString() }));

/** The device guard: resolve the token to its active terminal or answer 401. */
posDevice.use("*", async (c, next) => {
  if (c.req.path.endsWith("/ping")) return next();
  const token = c.req.header("X-POS-Device");
  if (!isDeviceToken(token)) return c.json({ error: "device_token_required" }, 401);
  const hash = await deviceTokenHash(token);
  const db = getDb(c.env);
  const found = await db.select().from(pos_terminals).where(and(eq(pos_terminals.token_hash, hash), eq(pos_terminals.active, true))).limit(1);
  if (found.length === 0) return c.json({ error: "device_not_registered" }, 401);
  c.set("terminal", found[0]);
  await next();
});

export async function companyBlock(env: Env, companyId: number): Promise<BundleCompany> {
  const b = await getBrandingForCompany(env, companyId);
  return { id: companyId, name: b.companyName, registration_no: b.registrationNo, address: [b.address, b.postcode].filter(Boolean).join(" "), phone: b.phone };
}

posDevice.get("/prepare", async (c: Ctx) => {
  const t = c.get("terminal");
  const db = getDb(c.env);
  const bundle = await loadPosBundle(db, t.company_id, t.id, await companyBlock(c.env, t.company_id));
  if (!bundle) return c.json({ error: "terminal_has_no_event", reason: "Assign this terminal to an event in POS Admin > Events, then refresh." }, 409);
  await db.update(pos_terminals).set({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() }).where(eq(pos_terminals.id, t.id));
  return c.json({ bundle });
});

type HeartbeatBody = {
  device_name?: string; app_version?: string; cashier?: string | null; last_sale_at?: string | null;
  pending_count?: number; pending_amount_sen?: number; last_sync_at?: string | null; receipt_counter?: number;
  storage?: { persisted?: boolean; usage?: number; quota?: number }; catalog_version?: number; platform?: string;
};

posDevice.post("/heartbeat", async (c: Ctx) => {
  const t = c.get("terminal");
  const body = await c.req.json<HeartbeatBody>().catch(() => ({} as HeartbeatBody));
  const db = getDb(c.env);
  const now = new Date().toISOString();
  const patch: Partial<typeof pos_terminals.$inferInsert> = { last_seen_at: now, updated_at: now };
  if (typeof body.device_name === "string" && body.device_name.trim()) patch.device_name = body.device_name.trim().slice(0, 80);
  if (typeof body.platform === "string" && body.platform.trim()) patch.platform = body.platform.trim().slice(0, 40);
  if (typeof body.app_version === "string") patch.app_version = body.app_version.slice(0, 40);
  if (Number.isInteger(body.pending_count) && body.pending_count! >= 0) patch.pending_count = body.pending_count!;
  if (Number.isFinite(body.pending_amount_sen) && body.pending_amount_sen! >= 0) patch.pending_amount_sen = Math.round(body.pending_amount_sen!);
  if (Number.isInteger(body.receipt_counter) && body.receipt_counter! >= t.receipt_counter) patch.receipt_counter = body.receipt_counter!;
  if (typeof body.last_sync_at === "string" && !Number.isNaN(Date.parse(body.last_sync_at))) patch.last_sync_at = new Date(body.last_sync_at).toISOString();
  patch.status = (patch.pending_count ?? t.pending_count) > 0 ? "PENDING" : "SYNCED";
  await db.update(pos_terminals).set(patch).where(eq(pos_terminals.id, t.id));
  const link = await db.execute<{ catalog_version: number }>(
    sql`SELECT catalog_version FROM pos_event_links WHERE company_id = ${t.company_id} AND project_id = ${t.project_id ?? -1}`,
  );
  return c.json({ ok: true, at: now, catalog_version: link.length ? link[0].catalog_version : null, event_project_id: t.project_id });
});

export { posDevice };
