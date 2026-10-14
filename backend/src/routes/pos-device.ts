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
import { pos_audit, pos_event_links, pos_heartbeats, pos_payments, pos_sale_lines, pos_sales, pos_settings, pos_terminals } from "../db/schema";
import { normalizePosSettingsGroup } from "../scm/shared/pos-settings";
import { getBrandingForCompany } from "../services/branding";
import { deviceTokenHash, isDeviceToken } from "./lib/pos-bundle";
import { loadPosBundle, type BundleCompany } from "./lib/pos-bundle-load";
import { classifyIncoming, movementsFor, parseIncomingSale, voidMovementsFor, type BatchResult, type MovementRow } from "./lib/pos-sync";

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
  return c.json({ ok: true, at: now, catalog_version: link.length ? link[0].catalog_version : null, event_project_id: t.project_id });
});

/* ── the sales batch (layout P14) ──────────────────────────────────────── */

/** Where this terminal's event takes stock from: the event's booth allocation,
 *  else the General setting's POS store; null = no location (flagged). */
async function stockLocationFor(db: ReturnType<typeof getDb>, companyId: number, projectId: number | null): Promise<string | null> {
  if (projectId != null) {
    const link = await db.select({ w: pos_event_links.stock_source_warehouse_id }).from(pos_event_links).where(and(eq(pos_event_links.company_id, companyId), eq(pos_event_links.project_id, projectId))).limit(1);
    if (link.length && link[0].w) return link[0].w;
  }
  const rows = await db.select({ value: pos_settings.value }).from(pos_settings).where(and(eq(pos_settings.company_id, companyId), eq(pos_settings.group, "general"))).limit(1);
  return rows.length ? normalizePosSettingsGroup("general", rows[0].value).pos_store_warehouse_id : null;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** The inventory movements of one receipt (or its void), logged against the
 *  receipt number. The FIFO trigger consumes lots on OUT and records a short
 *  when there are none (over-sell allowed offline); the balance that goes
 *  negative is the warning the Sync Status page shows. Idempotent per
 *  (doc type, receipt no): a second run writes nothing. */
async function bookMovements(tx: Tx, companyId: number, warehouseId: string | null, rows: MovementRow[], who: string): Promise<string | null> {
  if (rows.length === 0) return null;
  if (!warehouseId) return "no stock location: set the event's stock source or the POS store in General";
  const docType = rows[0].source_doc_type;
  const docNo = rows[0].source_doc_no;
  const existing = await tx.execute<{ n: number | string }>(sql`SELECT COUNT(*)::int AS n FROM scm.inventory_movements WHERE company_id = ${companyId} AND source_doc_type = ${docType} AND source_doc_no = ${docNo}`);
  if ((existing.length ? Number(existing[0].n) : 0) > 0) return null;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  for (const m of rows) {
    let unitCost = 0;
    if (m.movement_type === "IN") {
      /* A return or void brings the unit back at the cost its sale took it out at. */
      const prior = await tx.execute<{ c: number | string | null }>(sql`
        SELECT unit_cost_sen AS c FROM scm.inventory_movements
         WHERE company_id = ${companyId} AND item_code = ${m.item_code} AND movement_type = 'OUT' AND source_doc_type IN ('POS_SALE', 'POS_RETURN')
         ORDER BY created_at DESC LIMIT 1`);
      unitCost = prior.length ? Number(prior[0].c ?? 0) : 0;
    }
    await tx.execute(sql`
      INSERT INTO scm.inventory_movements (movement_type, warehouse_id, item_code, product_name, variant_key, qty, unit_cost_sen, source_doc_type, source_doc_no, notes, movement_date, company_id, reason_code)
      VALUES (${m.movement_type}::scm.inventory_movement_type, ${warehouseId}::uuid, ${m.item_code}, ${m.product_name}, '', ${m.qty}, ${unitCost}, ${m.source_doc_type}, ${m.source_doc_no}, ${`${m.notes} (${who})`}, ${today}::date, ${companyId}, 'POS')`);
  }
  const neg = await tx.execute<{ item_code: string; qty: number | string }>(sql`
    SELECT item_code, qty FROM scm.inventory_balances WHERE company_id = ${companyId} AND warehouse_id = ${warehouseId}::uuid AND item_code IN ${rows.map((r) => r.item_code)} AND qty < 0`);
  return neg.length ? `stock negative at the POS location: ${neg.map((n) => `${n.item_code} ${Number(n.qty)}`).join(", ")}` : null;
}

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
    try {
      const r = await db.transaction(async (tx) => {
        const stored = await tx.select({ id: pos_sales.id, status: pos_sales.status, salesman_id: pos_sales.salesman_id, salesman_name: pos_sales.salesman_name, terminal_code: pos_sales.terminal_code, receipt_no: pos_sales.receipt_no }).from(pos_sales).where(and(eq(pos_sales.company_id, t.company_id), eq(pos_sales.uuid, sale.uuid))).limit(1);
        const clash = stored.length ? [] : await tx.select({ id: pos_sales.id }).from(pos_sales).where(and(eq(pos_sales.company_id, t.company_id), eq(pos_sales.terminal_code, sale.terminal_code), eq(pos_sales.receipt_no, sale.receipt_no))).limit(1);
        const cls = classifyIncoming(sale, stored.length ? { ...stored[0], status: stored[0].status === "VOID" ? "VOID" : "PAID" } : null, clash.length > 0);
        if (cls.kind === "conflict") return { uuid: sale.uuid, status: "rejected", reason: cls.reason } as BatchResult;
        if (cls.kind === "duplicate") return { uuid: sale.uuid, status: "duplicate" } as BatchResult;
        if (cls.kind === "salesman") {
          await tx.update(pos_sales).set({ salesman_id: sale.salesman_id, salesman_name: sale.salesman_name, updated_at: new Date().toISOString() }).where(eq(pos_sales.id, cls.stored.id));
          await tx.insert(pos_audit).values({ company_id: t.company_id, entity: "pos_sale", entity_id: String(cls.stored.id), field: "salesman", from_value: cls.stored.salesman_name, to_value: sale.salesman_name, by_name: `${sale.cashier_name} (POS ${t.code})` });
          return { uuid: sale.uuid, status: "updated" } as BatchResult;
        }
        if (cls.kind === "void") {
          const warning = sale.status === "VOID" ? await bookMovements(tx, t.company_id, warehouseId, voidMovementsFor(sale), sale.void_by ?? sale.cashier_name) : null;
          await tx.update(pos_sales).set({ status: "VOID", void_reason: sale.void_reason, void_by: sale.void_by, voided_at: sale.voided_at ?? new Date().toISOString(), stock_warning: warning, updated_at: new Date().toISOString() }).where(eq(pos_sales.id, cls.stored.id));
          await tx.insert(pos_audit).values({ company_id: t.company_id, entity: "pos_sale", entity_id: String(cls.stored.id), field: "status", from_value: "PAID", to_value: "VOID", by_name: `${sale.void_by ?? sale.cashier_name} (POS ${t.code})` });
          return { uuid: sale.uuid, status: "updated", stock_warning: warning } as BatchResult;
        }
        const warning = sale.status === "PAID" ? await bookMovements(tx, t.company_id, warehouseId, movementsFor(sale), sale.cashier_name) : null;
        const [row] = await tx.insert(pos_sales).values({
          uuid: sale.uuid, company_id: t.company_id, project_id: sale.project_id, terminal_code: sale.terminal_code, receipt_no: sale.receipt_no, type: sale.type, ref_sale_uuid: sale.ref_sale_uuid,
          cashier_id: sale.cashier_id, cashier_name: sale.cashier_name, salesman_id: sale.salesman_id, salesman_name: sale.salesman_name, customer_name: sale.customer_name, customer_phone: sale.customer_phone,
          sold_at: sale.sold_at, subtotal_sen: sale.subtotal_sen, item_discount_sen: sale.item_discount_sen, bill_discount_sen: sale.bill_discount_sen, sst_applied: sale.sst_applied, sst_rate: String(sale.sst_rate),
          sst_amount_sen: sale.sst_amount_sen, rounding_sen: sale.rounding_sen, total_sen: sale.total_sen, status: sale.status, void_reason: sale.void_reason, void_by: sale.void_by, voided_at: sale.voided_at,
          is_test: false, source: "NORMAL", local_seq: sale.local_seq, stock_warning: warning,
        }).returning({ id: pos_sales.id });
        await tx.insert(pos_sale_lines).values(sale.lines.map((l) => ({
          sale_id: row.id, line_no: l.line_no, item_id: l.item_id, item_code: l.code, description: l.description, uom: l.uom, qty: String(l.qty), unit_price_sen: l.unit_price_sen,
          original_price_sen: l.original_price_sen, override_by: l.override_by, override_reason: l.override_reason, discount_source: l.discount_source, discount_type: l.discount_type,
          discount_value: l.discount_value == null ? null : String(l.discount_value), discount_amount_sen: l.discount_amount_sen, is_foc: l.is_foc, amount_sen: l.amount_sen,
        })));
        if (sale.payments.length) await tx.insert(pos_payments).values(sale.payments.map((p) => ({ sale_id: row.id, method: p.method, amount_sen: p.amount_sen, reference: p.reference, tendered_sen: p.tendered_sen, change_sen: p.change_sen })));
        return { uuid: sale.uuid, status: "accepted", stock_warning: warning } as BatchResult;
      });
      results.push(r);
    } catch (e) {
      results.push({ uuid: sale.uuid, status: "rejected", reason: e instanceof Error ? e.message.slice(0, 200) : "write failed" });
    }
  }
  const now = new Date().toISOString();
  const remaining = Number.isInteger(body.remaining) && body.remaining! >= 0 ? body.remaining! : Math.max(0, t.pending_count - results.filter((r) => r.status !== "rejected").length);
  const counter = Number.isInteger(body.receipt_counter) && body.receipt_counter! > t.receipt_counter ? body.receipt_counter! : t.receipt_counter;
  await db.update(pos_terminals).set({ last_sync_at: now, last_seen_at: now, pending_count: remaining, receipt_counter: counter, status: remaining > 0 ? "PENDING" : "SYNCED", updated_at: now }).where(eq(pos_terminals.id, t.id));
  return c.json({ results, at: now, accepted: results.filter((r) => r.status === "accepted").length, duplicates: results.filter((r) => r.status === "duplicate").length, rejected: results.filter((r) => r.status === "rejected").length });
});

export { posDevice };
