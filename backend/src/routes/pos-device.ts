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
//   POST /sales/batch         the receipts (routes/lib/pos-ingest.ts books them)
//   GET  /report              the event bills for the all-terminals report (P13)
//   POST /pair                redeem the pairing code from POS Admin (no token yet)
//   POST /reconnect/request   a displaced device asks for its terminal back (its dead token proves it)
//   POST /reconnect/claim     ...and collects the new token once a supervisor approved
//   GET  /reconnect/requests  the open requests in the company, for a supervisor on another device
//   POST /reconnect/approve   that supervisor approves one with their PIN
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { pos_audit, pos_cashiers, pos_heartbeats, pos_terminals } from "../db/schema";
import { verifyPassword } from "../services/auth";
import { getBrandingForCompany } from "../services/branding";
import { deviceTokenHash, isDeviceToken, mintDeviceToken } from "./lib/pos-bundle";
import { isPairingCode, pairingCodeHash, pairingCodeLive } from "../scm/shared/pos-pairing";
import { loadPosBundle, type BundleCompany } from "./lib/pos-bundle-load";
import { parseIncomingSale, type BatchResult } from "./lib/pos-sync";
import { ingestSale, stockLocationFor } from "./lib/pos-ingest";
import { loadReportSales } from "./lib/pos-report-load";
import { reconnectPhase } from "./lib/pos-reconnect";

type Terminal = typeof pos_terminals.$inferSelect;
type Vars = { terminal: Terminal };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const posDevice = new Hono<{ Bindings: Env; Variables: Vars }>();

posDevice.get("/ping", (c) => c.json({ ok: true, at: new Date().toISOString() }));

/** The device guard: resolve the token to its active terminal or answer 401. */
posDevice.use("*", async (c, next) => {
  if (c.req.path.endsWith("/ping") || c.req.path.endsWith("/pair") || c.req.path.endsWith("/reconnect/request") || c.req.path.endsWith("/reconnect/claim")) return next();
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
  device_name?: string; app_version?: string; cashier?: string | null; last_sale_at?: string | null; db_empty?: boolean;
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
  const pendingNow = patch.pending_count ?? t.pending_count;
  patch.status = pendingNow > 0 ? "PENDING" : "SYNCED";
  /* DATA LOST (layout E7): the device says its local database is empty while
     the last heartbeat still had bills pending. Recorded here; step 7 raises
     the alert and the email from it. */
  if (body.db_empty === true && t.last_known_pending_count > 0 && pendingNow === 0) { patch.db_empty_at = now; patch.status = "DATA_LOST"; }
  else if (body.db_empty !== true) patch.db_empty_at = null;
  if (pendingNow > 0) { patch.last_known_pending_count = pendingNow; patch.last_known_pending_sen = patch.pending_amount_sen ?? t.pending_amount_sen; }
  else if (patch.status === "SYNCED") { patch.last_known_pending_count = 0; patch.last_known_pending_sen = 0; }
  await db.update(pos_terminals).set(patch).where(eq(pos_terminals.id, t.id));
  await db.insert(pos_heartbeats).values({ company_id: t.company_id, terminal_id: t.id, payload: { ...body, received_at: now } });
  const link = await db.execute<{ catalog_version: number }>(
    sql`SELECT catalog_version FROM pos_event_links WHERE company_id = ${t.company_id} AND project_id = ${t.project_id ?? -1}`,
  );
  const asking = await db.select({ reconnect_requested_at: pos_terminals.reconnect_requested_at, reconnect_approved_at: pos_terminals.reconnect_approved_at }).from(pos_terminals).where(and(eq(pos_terminals.company_id, t.company_id), eq(pos_terminals.active, true), isNotNull(pos_terminals.reconnect_requested_at)));
  const reconnectRequests = asking.filter((r) => reconnectPhase(r, Date.now()) === "waiting").length;
  return c.json({ ok: true, at: now, catalog_version: link.length ? link[0].catalog_version : null, event_project_id: t.project_id, reconnect_requests: reconnectRequests });
});

/* ── pairing: the device redeems the code POS Admin handed out ──────────── */

/** No token yet: the code identifies the terminal (hash match, not expired,
 *  active, event still linked). A fresh device token is minted, the code is
 *  spent, and the bundle comes back with the token. A wrong or stale code
 *  answers the same 404 either way. */
posDevice.post("/pair", async (c: Ctx) => {
  type PairBody = { code?: unknown; device_name?: unknown; platform?: unknown };
  const body = await c.req.json<PairBody>().catch(() => ({} as PairBody));
  const raw = typeof body.code === "string" ? body.code : "";
  if (!isPairingCode(raw)) return c.json({ error: "code_invalid", reason: "A pairing code has 8 letters and digits." }, 400);
  const db = getDb(c.env);
  const hash = await pairingCodeHash(raw);
  const now = new Date().toISOString();
  const found = await db.select().from(pos_terminals).where(and(eq(pos_terminals.pairing_code_hash, hash), eq(pos_terminals.active, true))).limit(1);
  const t = found.length ? found[0] : null;
  if (!t || !pairingCodeLive(t.pairing_expires_at, Date.now()) || t.project_id == null) return c.json({ error: "code_unknown", reason: "This code is not valid any more. Ask for a new one in POS Admin > Terminals." }, 404);
  const token = mintDeviceToken();
  const deviceName = typeof body.device_name === "string" && body.device_name.trim() ? body.device_name.trim().slice(0, 80) : null;
  const platform = typeof body.platform === "string" && body.platform.trim() ? body.platform.trim().slice(0, 40) : null;
  await db.update(pos_terminals).set({
    token_hash: await deviceTokenHash(token), prev_token_hash: t.token_hash, prepared_at: now, last_seen_at: now, status: "PREPARED", pairing_code_hash: null, pairing_expires_at: null,
    reconnect_requested_at: null, reconnect_device_name: null, reconnect_approved_at: null, reconnect_approved_by: null,
    device_name: deviceName ?? undefined, platform: platform ?? undefined, updated_at: now,
  }).where(eq(pos_terminals.id, t.id));
  const bundle = await loadPosBundle(db, t.company_id, t.id, await companyBlock(c.env, t.company_id));
  if (!bundle) return c.json({ error: "bundle_failed" }, 500);
  await db.insert(pos_audit).values({ company_id: t.company_id, entity: "pos_terminal", entity_id: String(t.id), field: "paired", from_value: null, to_value: `${t.code} -> project ${t.project_id}${deviceName ? ` (${deviceName})` : ""}`, by_name: "device" });
  return c.json({ token, bundle });
});

/* ── reconnect by approval (routes/lib/pos-reconnect.ts) ────────────────── */

/** The terminal a displaced device held just before the swap, by the token
 *  it still carries; null for any other caller. */
async function displacedTerminal(c: Ctx): Promise<Terminal | null> {
  const token = c.req.header("X-POS-Device");
  if (!isDeviceToken(token)) return null;
  const hash = await deviceTokenHash(token);
  const found = await getDb(c.env).select().from(pos_terminals).where(and(eq(pos_terminals.prev_token_hash, hash), eq(pos_terminals.active, true))).limit(1);
  return found.length ? found[0] : null;
}

const NOT_ELIGIBLE = { error: "not_eligible", reason: "This device cannot ask for its terminal back. Ask for a pairing link from POS Admin > Terminals." };

/** The displaced device asks. Asking again while a request is open changes
 *  nothing, so a device that polls does not flood the audit trail. */
posDevice.post("/reconnect/request", async (c: Ctx) => {
  const t = await displacedTerminal(c);
  if (!t) return c.json(NOT_ELIGIBLE, 404);
  const phase = reconnectPhase(t, Date.now());
  if (phase !== "none") return c.json({ status: phase, terminal: t.code });
  type RequestBody = { device_name?: unknown };
  const body = await c.req.json<RequestBody>().catch(() => ({} as RequestBody));
  const deviceName = typeof body.device_name === "string" && body.device_name.trim() ? body.device_name.trim().slice(0, 80) : null;
  const db = getDb(c.env);
  const now = new Date().toISOString();
  await db.update(pos_terminals).set({ reconnect_requested_at: now, reconnect_device_name: deviceName, reconnect_approved_at: null, reconnect_approved_by: null, updated_at: now }).where(and(eq(pos_terminals.id, t.id), eq(pos_terminals.company_id, t.company_id)));
  await db.insert(pos_audit).values({ company_id: t.company_id, entity: "pos_terminal", entity_id: String(t.id), field: "reconnect_requested", from_value: null, to_value: `${t.code}${deviceName ? ` (${deviceName})` : ""}`, by_name: "device" });
  return c.json({ status: "waiting", terminal: t.code });
});

/** The displaced device collects: once approved it gets a fresh token and
 *  the bundle. The device that held the terminal meanwhile is cut off and,
 *  unlike after a pairing, cannot ask for it back: the approval was a
 *  deliberate move, and two devices must not hand a terminal to and fro.
 *  The bills this device holds stay on it and sync next. */
posDevice.post("/reconnect/claim", async (c: Ctx) => {
  const t = await displacedTerminal(c);
  if (!t) return c.json(NOT_ELIGIBLE, 404);
  const phase = reconnectPhase(t, Date.now());
  if (phase !== "approved") return c.json({ status: phase, terminal: t.code });
  if (t.project_id == null) return c.json({ error: "terminal_has_no_event", reason: "Set the event of this terminal in POS Admin > Terminals first." }, 409);
  const db = getDb(c.env);
  const token = mintDeviceToken();
  const now = new Date().toISOString();
  await db.update(pos_terminals).set({
    token_hash: await deviceTokenHash(token), prev_token_hash: null, prepared_at: now, last_seen_at: now, status: "PREPARED",
    reconnect_requested_at: null, reconnect_device_name: null, reconnect_approved_at: null, reconnect_approved_by: null,
    device_name: t.reconnect_device_name ?? undefined, updated_at: now,
  }).where(and(eq(pos_terminals.id, t.id), eq(pos_terminals.company_id, t.company_id)));
  const bundle = await loadPosBundle(db, t.company_id, t.id, await companyBlock(c.env, t.company_id));
  if (!bundle) return c.json({ error: "bundle_failed" }, 500);
  await db.insert(pos_audit).values({ company_id: t.company_id, entity: "pos_terminal", entity_id: String(t.id), field: "reconnected", from_value: null, to_value: `${t.code}${t.reconnect_device_name ? ` (${t.reconnect_device_name})` : ""}, approved by ${t.reconnect_approved_by ?? "?"}`, by_name: "device" });
  return c.json({ status: "approved", token, bundle });
});

/** What a supervisor on another device sees: who asks, and which device
 *  holds the terminal now (approving disconnects that one). */
posDevice.get("/reconnect/requests", async (c: Ctx) => {
  const me = c.get("terminal");
  const rows = await getDb(c.env).select().from(pos_terminals).where(and(eq(pos_terminals.company_id, me.company_id), eq(pos_terminals.active, true), isNotNull(pos_terminals.reconnect_requested_at)));
  const nowMs = Date.now();
  return c.json({
    data: rows.filter((r) => reconnectPhase(r, nowMs) === "waiting").map((r) => ({
      terminal_id: r.id, code: r.code, asking_device: r.reconnect_device_name, requested_at: r.reconnect_requested_at,
      holder_device: r.device_name, holder_last_seen_at: r.last_seen_at, is_this_device: r.id === me.id,
    })),
  });
});

/** A supervisor approves with their own PIN, checked here against the
 *  active supervisors of the company (the device is not trusted to have checked). */
posDevice.post("/reconnect/approve", async (c: Ctx) => {
  const me = c.get("terminal");
  type ApproveBody = { terminal_id?: unknown; pin?: unknown };
  const body = await c.req.json<ApproveBody>().catch(() => ({} as ApproveBody));
  const terminalId = Number(body.terminal_id);
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!Number.isInteger(terminalId) || terminalId <= 0 || !/^\d{4,8}$/.test(pin)) return c.json({ error: "terminal_and_pin_required" }, 400);
  const db = getDb(c.env);
  const supervisors = await db.select({ name: pos_cashiers.name, pin_hash: pos_cashiers.pin_hash }).from(pos_cashiers).where(and(eq(pos_cashiers.company_id, me.company_id), eq(pos_cashiers.active, true), eq(pos_cashiers.role, "SUPERVISOR")));
  let approver: string | null = null;
  for (const s of supervisors) if (await verifyPassword(pin, s.pin_hash)) { approver = s.name; break; }
  if (!approver) return c.json({ error: "wrong_pin", reason: "That is not a supervisor PIN." }, 403);
  const found = await db.select().from(pos_terminals).where(and(eq(pos_terminals.id, terminalId), eq(pos_terminals.company_id, me.company_id), eq(pos_terminals.active, true))).limit(1);
  if (found.length === 0 || reconnectPhase(found[0], Date.now()) !== "waiting") return c.json({ error: "no_open_request", reason: "That request is no longer open." }, 409);
  const now = new Date().toISOString();
  const by = `${approver} (POS ${me.code})`;
  await db.update(pos_terminals).set({ reconnect_approved_at: now, reconnect_approved_by: by, updated_at: now }).where(and(eq(pos_terminals.id, terminalId), eq(pos_terminals.company_id, me.company_id)));
  await db.insert(pos_audit).values({ company_id: me.company_id, entity: "pos_terminal", entity_id: String(terminalId), field: "reconnect_approved", from_value: null, to_value: found[0].code, by_name: by });
  return c.json({ ok: true, terminal: found[0].code });
});

/* ── the event's bills for the device report, all terminals (layout P13) ── */

/** A supervisor's "all terminals" report: every bill of this terminal's
 *  event that reached the ERP, in the Malaysia-day range [from, to]. Bills
 *  still pending on other devices are not here yet, and the device says so. */
posDevice.get("/report", async (c: Ctx) => {
  const t = c.get("terminal");
  if (t.project_id == null) return c.json({ error: "no_event" }, 409);
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!day.test(from) || !day.test(to)) return c.json({ error: "from_and_to_required" }, 400);
  const sales = await loadReportSales(getDb(c.env), t.company_id, { projectId: t.project_id, fromIso: `${from}T00:00:00+08:00`, toIso: `${to}T23:59:59.999+08:00` });
  return c.json({ sales, at: new Date().toISOString() });
});

/* ── the sales batch (layout P14) ──────────────────────────────────────── */
posDevice.post("/sales/batch", async (c: Ctx) => {
  const t = c.get("terminal");
  type BatchBody = { sales?: unknown[]; remaining?: number; receipt_counter?: number };
  const body = await c.req.json<BatchBody>().catch(() => ({} as BatchBody));
  const incoming = Array.isArray(body.sales) ? body.sales.slice(0, 200) : [];
  const db = getDb(c.env);
  const warehouseId = await stockLocationFor(db, t.company_id, t.project_id);
  const results: BatchResult[] = [];
  for (const raw of incoming) {
    const parsed = parseIncomingSale(raw);
    if (!parsed.ok) { results.push({ uuid: raw && typeof raw === "object" ? String((raw as { uuid?: unknown }).uuid ?? "") : "", status: "rejected", reason: parsed.reason }); continue; }
    const sale = parsed.sale;
    if (sale.terminal_code !== t.code) { results.push({ uuid: sale.uuid, status: "rejected", reason: `receipt belongs to terminal ${sale.terminal_code}, this device is ${t.code}` }); continue; }
    results.push(await ingestSale(db, t.company_id, warehouseId, sale, `POS ${t.code}`));
  }
  const now = new Date().toISOString();
  const remaining = Number.isInteger(body.remaining) && body.remaining! >= 0 ? body.remaining! : Math.max(0, t.pending_count - results.filter((r) => r.status !== "rejected").length);
  const counter = Number.isInteger(body.receipt_counter) && body.receipt_counter! > t.receipt_counter ? body.receipt_counter! : t.receipt_counter;
  await db.update(pos_terminals).set({ last_sync_at: now, last_seen_at: now, pending_count: remaining, receipt_counter: counter, status: remaining > 0 ? "PENDING" : "SYNCED", updated_at: now }).where(eq(pos_terminals.id, t.id));
  return c.json({ results, at: now, accepted: results.filter((r) => r.status === "accepted").length, duplicates: results.filter((r) => r.status === "duplicate").length, rejected: results.filter((r) => r.status === "rejected").length });
});

export { posDevice };
