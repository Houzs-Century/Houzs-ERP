// ----------------------------------------------------------------------------
// pos-admin — the ERP's POS Admin menu for the Houzs POS booth app (layouts
// E1 POS Items, E1b Barcode labels, E2 Cashiers, E3 Events, E4 SST & Receipt,
// E5 Terminals / Printer & Scanner / General). Owner / admin only: every route
// sits behind `pos.manage` (Owner + IT Admin hold it via "*").
//
//   GET  /settings                      PUT  /settings/:group
//   GET  /items  POST /items  PATCH /items/:id  DELETE /items/:id (deactivate)
//   POST /items/:id/barcodes  DELETE /items/:id/barcodes/:bid  POST /items/import
//   GET  /inventory/search?q=           the SKU picker behind "+ Add from Inventory"
//   GET  /labels?search=&missing=1&ids= POST /labels/generate {product_ids}
//   GET  /cashiers  POST /cashiers  PATCH /cashiers/:id  POST /cashiers/:id/pin
//   GET  /events  GET /events/candidates?q=  PUT /events/:projectId
//   POST /events/:projectId/push  DELETE /events/:projectId
//   GET  /terminals  POST /terminals  PATCH /terminals/:id
//
// Its own prefix, NOT /api/pos: that router is the older 2990 tablet-POS auth
// (pre-auth mount). Drizzle throughout; the furniture SKU master
// (scm.mfg_products) and stock (scm.inventory_balances) are read through
// db.execute in their own helpers, never mixed into a builder query.
//
// COMPANY SCOPE: every table here carries company_id and every read and write
// requires the active company (409 company_unresolved otherwise) — the POS
// masters of one company must never show in, or be edited from, the other.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  pos_alerts,
  pos_audit,
  pos_cashiers,
  pos_event_cashiers,
  pos_event_items,
  pos_event_links,
  pos_event_prices,
  pos_generated_barcodes,
  pos_item_barcodes,
  pos_items,
  pos_settings,
  pos_terminals,
} from "../db/schema";
import { requireActiveCompanyId } from "../scm/lib/companyScope";
import { hashPassword } from "../services/auth";
import { internalEan13 } from "../scm/shared/ean13";
import { POS_SETTINGS_GROUPS, normalizePosSettings, normalizePosSettingsGroup, type PosSettingsGroup } from "../scm/shared/pos-settings";
import { skuByCodes, skuFactsByIds, skuSearch } from "./lib/pos-sku";
import { deviceTokenHash, mintDeviceToken } from "./lib/pos-bundle";
import { loadPosBundle } from "./lib/pos-bundle-load";
import { companyBlock } from "./pos-device";
import { ALERT_WORDS, terminalStatusWord, type AlertType } from "./lib/pos-alerts";
import { ingestSale, previewSale, stockLocationFor, type PreviewKind } from "./lib/pos-ingest";
import { parseIncomingSale, type BatchResult, type IncomingSale } from "./lib/pos-sync";
import { generalSettings, loadTerminalFacts } from "../services/posAlerts";
import { loadReportSales } from "./lib/pos-report-load";
import { aggregateSales } from "../scm/shared/pos-report";
import { posReceiptStatusLabel } from "../scm/shared/pos-vocabulary";
import { decryptBackupPayload, isPosBackupFile, type PosBackupFile } from "../scm/shared/pos-backup-crypto";
import { PAIRING_MINUTES, formatPairingCode, mintPairingCode, pairingCodeHash } from "../scm/shared/pos-pairing";
import {
  isCashierRole,
  isPosCashierPin,
  nextCode,
  posEventStatus,
  parseImportRow,
  type ImportRowInput,
} from "./lib/pos-admin-rules";

type Vars = { user?: { id: number; name?: string | null; email?: string }; companyId?: number };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;
type Db = ReturnType<typeof getDb>;

const CASH_CARRY_SLUG = "cash_carry";

const posAdmin = new Hono<{ Bindings: Env; Variables: Vars }>();

function intParam(c: Ctx, name: string): number | null {
  const n = Number(c.req.param(name));
  return Number.isInteger(n) && n > 0 ? n : null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const nowIso = () => new Date().toISOString();

async function audit(db: Db, companyId: number, c: Ctx, entity: string, entityId: string | number, field: string, from: unknown, to: unknown) {
  const u = c.get("user");
  await db.insert(pos_audit).values({
    company_id: companyId,
    entity,
    entity_id: String(entityId),
    field,
    from_value: from == null ? null : String(from),
    to_value: to == null ? null : String(to),
    by_user_id: u?.id ?? null,
    by_name: u?.name ?? u?.email ?? null,
  });
}

/* ── SKU master facts (scm schema) live in ./lib/pos-sku.ts ──────────────── */

type LabelRow = { product_id: string; code: string; name: string; category: string | null; factory_barcode: string | null; sell_price_sen: number | null; total: number };

async function labelRows(db: Db, companyId: number, opts: { search: string; missingOnly: boolean; ids: string[]; page: number; pageSize: number }): Promise<LabelRow[]> {
  const like = `%${opts.search.replace(/[%_]/g, "")}%`;
  const offset = (opts.page - 1) * opts.pageSize;
  return db.execute<LabelRow>(sql`
    SELECT p.id AS product_id, p.code, p.name, p.category::text AS category, p.barcode AS factory_barcode,
           COALESCE(p.sell_price_sen, p.price1_sen, p.base_price_sen) AS sell_price_sen,
           COUNT(*) OVER()::int AS total
      FROM scm.mfg_products p
      LEFT JOIN pos_generated_barcodes g ON g.company_id = p.company_id AND g.product_id = p.id
     WHERE p.company_id = ${companyId} AND p.status = 'ACTIVE'
       ${opts.ids.length > 0 ? sql`AND p.id IN ${opts.ids}` : sql``}
       ${opts.search ? sql`AND (p.code ILIKE ${like} OR p.name ILIKE ${like})` : sql``}
       ${opts.missingOnly ? sql`AND p.barcode IS NULL AND g.barcode IS NULL` : sql``}
     ORDER BY p.code
     LIMIT ${opts.pageSize} OFFSET ${offset}`);
}

/** Write a generated own barcode onto the SKU's own barcode field when it has
 *  none, so the ERP's other screens scan it too (layout E1b). */
async function stampSkuBarcodeIfEmpty(db: Db, companyId: number, productId: string, barcode: string): Promise<void> {
  await db.execute(sql`UPDATE scm.mfg_products SET barcode = ${barcode} WHERE company_id = ${companyId} AND id = ${productId} AND barcode IS NULL`);
}

async function nextEan13(db: Db): Promise<string> {
  const rows = await db.execute<{ n: number | string }>(sql`SELECT nextval('pos_ean13_seq') AS n`);
  return internalEan13(rows.length ? Number(rows[0].n) : NaN);
}

/* ── settings ──────────────────────────────────────────────────────────── */

posAdmin.get("/settings", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const rows = await db.select().from(pos_settings).where(eq(pos_settings.company_id, co.companyId));
  const raw: Partial<Record<PosSettingsGroup, unknown>> = {};
  for (const r of rows) raw[r.group as PosSettingsGroup] = r.value;
  return c.json({ settings: normalizePosSettings(raw), updated: Object.fromEntries(rows.map((r) => [r.group, r.updated_at])) });
});

posAdmin.put("/settings/:group", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const group = c.req.param("group") as PosSettingsGroup;
  if (!POS_SETTINGS_GROUPS.includes(group)) return c.json({ error: "unknown_group" }, 400);
  const body = await c.req.json<{ value?: unknown }>().catch(() => ({} as { value?: unknown }));
  const value = normalizePosSettingsGroup(group, body.value);
  const db = getDb(c.env);
  await db
    .insert(pos_settings)
    .values({ company_id: co.companyId, group, value, updated_by: c.get("user")?.id ?? null, updated_at: nowIso() })
    .onConflictDoUpdate({ target: [pos_settings.company_id, pos_settings.group], set: { value, updated_by: c.get("user")?.id ?? null, updated_at: nowIso() } });
  await audit(db, co.companyId, c, "pos_settings", group, "value", null, JSON.stringify(value));
  return c.json({ ok: true, value });
});

/* ── POS items ─────────────────────────────────────────────────────────── */

type ItemOut = {
  id: number; product_id: string; item_code: string; name: string; category: string | null; uom: string;
  price_sen: number; cost_sen: number | null; preset_discount_type: string | null; preset_discount_value: number | null;
  foc_allowed: boolean; max_manual_disc_pct: number | null; stock_source_warehouse_id: string | null; receipt_name: string | null;
  active: boolean; barcodes: { barcode: string; kind: "FACTORY" | "GENERATED" | "EXTRA"; id: number | null }[]; stock_qty: number;
  sku_price_sen: number | null; event_prices: { project_id: number; price_sen: number }[]; updated_at: string;
};

async function listItems(db: Db, companyId: number): Promise<ItemOut[]> {
  const rows = await db.select().from(pos_items).where(eq(pos_items.company_id, companyId)).orderBy(asc(pos_items.item_code));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [extra, generated, facts, prices] = await Promise.all([
    db.select().from(pos_item_barcodes).where(inArray(pos_item_barcodes.pos_item_id, ids)),
    db.select().from(pos_generated_barcodes).where(and(eq(pos_generated_barcodes.company_id, companyId), inArray(pos_generated_barcodes.product_id, rows.map((r) => r.product_id)))),
    skuFactsByIds(db, companyId, rows.map((r) => r.product_id)),
    db
      .select({ pos_item_id: pos_event_prices.pos_item_id, price_sen: pos_event_prices.price_sen, project_id: pos_event_links.project_id })
      .from(pos_event_prices)
      .innerJoin(pos_event_links, eq(pos_event_links.id, pos_event_prices.link_id))
      .where(inArray(pos_event_prices.pos_item_id, ids)),
  ]);
  const genByProduct = new Map(generated.map((g) => [g.product_id, g.barcode]));
  return rows.map((r) => {
    const f = facts.get(r.product_id);
    const barcodes: ItemOut["barcodes"] = [];
    if (f?.barcode) barcodes.push({ barcode: f.barcode, kind: "FACTORY", id: null });
    const g = genByProduct.get(r.product_id);
    if (g && g !== f?.barcode) barcodes.push({ barcode: g, kind: "GENERATED", id: null });
    for (const b of extra.filter((x) => x.pos_item_id === r.id)) {
      if (!barcodes.some((x) => x.barcode === b.barcode)) barcodes.push({ barcode: b.barcode, kind: "EXTRA", id: b.id });
    }
    return {
      id: r.id, product_id: r.product_id, item_code: r.item_code, name: r.name, category: f?.category ?? null, uom: r.uom,
      price_sen: r.price_sen, cost_sen: r.cost_sen, preset_discount_type: r.preset_discount_type,
      preset_discount_value: r.preset_discount_value == null ? null : Number(r.preset_discount_value),
      foc_allowed: r.foc_allowed, max_manual_disc_pct: r.max_manual_disc_pct == null ? null : Number(r.max_manual_disc_pct),
      stock_source_warehouse_id: r.stock_source_warehouse_id, receipt_name: r.receipt_name, active: r.active, barcodes,
      stock_qty: f?.stock_qty ?? 0, sku_price_sen: f?.sell_price_sen ?? null,
      event_prices: prices.filter((p) => p.pos_item_id === r.id).map((p) => ({ project_id: p.project_id, price_sen: p.price_sen })),
      updated_at: r.updated_at,
    };
  });
}

posAdmin.get("/items", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  return c.json({ data: await listItems(getDb(c.env), co.companyId) });
});

posAdmin.get("/inventory/search", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ data: [] });
  const db = getDb(c.env);
  const found = await skuSearch(db, co.companyId, q, 30);
  const tagged = found.length
    ? await db.select({ product_id: pos_items.product_id, id: pos_items.id, active: pos_items.active }).from(pos_items).where(and(eq(pos_items.company_id, co.companyId), inArray(pos_items.product_id, found.map((f) => f.product_id))))
    : [];
  const byProduct = new Map(tagged.map((t) => [t.product_id, t]));
  return c.json({ data: found.map((f) => ({ ...f, pos_item_id: byProduct.get(f.product_id)?.id ?? null, pos_active: byProduct.get(f.product_id)?.active ?? null })) });
});

type ItemBody = {
  product_id?: string; uom?: string; price_sen?: number; cost_sen?: number | null; preset_discount_type?: string | null;
  preset_discount_value?: number | null; foc_allowed?: boolean; max_manual_disc_pct?: number | null;
  stock_source_warehouse_id?: string | null; receipt_name?: string | null; active?: boolean;
};

function itemPatchFrom(body: ItemBody): Partial<typeof pos_items.$inferInsert> {
  const p: Partial<typeof pos_items.$inferInsert> = {};
  if (body.uom !== undefined) p.uom = str(body.uom) ?? "UNIT";
  if (body.price_sen !== undefined) p.price_sen = Math.max(0, Math.round(num(body.price_sen) ?? 0));
  if (body.cost_sen !== undefined) p.cost_sen = body.cost_sen == null ? null : Math.max(0, Math.round(num(body.cost_sen) ?? 0));
  if (body.preset_discount_type !== undefined) p.preset_discount_type = body.preset_discount_type === "PCT" || body.preset_discount_type === "RM" ? body.preset_discount_type : null;
  if (body.preset_discount_value !== undefined) p.preset_discount_value = body.preset_discount_value == null ? null : String(Math.max(0, num(body.preset_discount_value) ?? 0));
  if (body.foc_allowed !== undefined) p.foc_allowed = bool(body.foc_allowed, false);
  if (body.max_manual_disc_pct !== undefined) p.max_manual_disc_pct = body.max_manual_disc_pct == null ? null : String(Math.min(100, Math.max(0, num(body.max_manual_disc_pct) ?? 0)));
  if (body.stock_source_warehouse_id !== undefined) p.stock_source_warehouse_id = str(body.stock_source_warehouse_id);
  if (body.receipt_name !== undefined) p.receipt_name = str(body.receipt_name)?.slice(0, 24) ?? null;
  if (body.active !== undefined) p.active = bool(body.active, true);
  if (p.preset_discount_type === null) p.preset_discount_value = null;
  return p;
}

posAdmin.post("/items", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json<ItemBody>().catch(() => ({} as ItemBody));
  const productId = str(body.product_id);
  if (!productId) return c.json({ error: "product_required" }, 400);
  const db = getDb(c.env);
  const fact = (await skuFactsByIds(db, co.companyId, [productId])).get(productId);
  if (!fact) return c.json({ error: "Not found" }, 404);
  const existing = await db.select({ id: pos_items.id }).from(pos_items).where(and(eq(pos_items.company_id, co.companyId), eq(pos_items.product_id, productId)));
  if (existing.length > 0) return c.json({ error: "already_pos_item", id: existing[0].id }, 409);
  const patch = itemPatchFrom(body);
  const [row] = await db
    .insert(pos_items)
    .values({
      company_id: co.companyId, product_id: productId, item_code: fact.code, name: fact.name,
      price_sen: patch.price_sen ?? fact.sell_price_sen ?? 0, cost_sen: patch.cost_sen ?? fact.cost_price_sen ?? null,
      ...patch,
    })
    .returning({ id: pos_items.id });
  return c.json({ ok: true, id: row.id }, 201);
});

posAdmin.patch("/items/:id", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "invalid_id" }, 400);
  const body = await c.req.json<ItemBody>().catch(() => ({} as ItemBody));
  const db = getDb(c.env);
  const res = await db.update(pos_items).set({ ...itemPatchFrom(body), updated_at: nowIso() }).where(and(eq(pos_items.id, id), eq(pos_items.company_id, co.companyId))).returning({ id: pos_items.id });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

posAdmin.delete("/items/:id", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "invalid_id" }, 400);
  const db = getDb(c.env);
  const res = await db.update(pos_items).set({ active: false, updated_at: nowIso() }).where(and(eq(pos_items.id, id), eq(pos_items.company_id, co.companyId))).returning({ id: pos_items.id });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

posAdmin.post("/items/:id/barcodes", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "invalid_id" }, 400);
  const body = await c.req.json<{ barcode?: string }>().catch(() => ({} as { barcode?: string }));
  const barcode = str(body.barcode);
  if (!barcode || !/^[0-9A-Za-z-]{4,32}$/.test(barcode)) return c.json({ error: "barcode_invalid" }, 400);
  const db = getDb(c.env);
  const item = await db.select({ id: pos_items.id }).from(pos_items).where(and(eq(pos_items.id, id), eq(pos_items.company_id, co.companyId)));
  if (item.length === 0) return c.json({ error: "Not found" }, 404);
  const clash = await db.select({ id: pos_item_barcodes.id, pos_item_id: pos_item_barcodes.pos_item_id }).from(pos_item_barcodes).where(and(eq(pos_item_barcodes.company_id, co.companyId), eq(pos_item_barcodes.barcode, barcode)));
  if (clash.length > 0) return c.json({ error: "barcode_taken", pos_item_id: clash[0].pos_item_id }, 409);
  const [row] = await db.insert(pos_item_barcodes).values({ company_id: co.companyId, pos_item_id: id, barcode }).returning({ id: pos_item_barcodes.id });
  return c.json({ ok: true, id: row.id }, 201);
});

posAdmin.delete("/items/:id/barcodes/:bid", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  const bid = intParam(c, "bid");
  if (!id || !bid) return c.json({ error: "invalid_id" }, 400);
  const db = getDb(c.env);
  const res = await db.delete(pos_item_barcodes).where(and(eq(pos_item_barcodes.id, bid), eq(pos_item_barcodes.pos_item_id, id), eq(pos_item_barcodes.company_id, co.companyId))).returning({ id: pos_item_barcodes.id });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/** Excel import (layout E1): one row per item code; an unknown code is
 *  skipped with its reason, a known one is created or updated. */
posAdmin.post("/items/import", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json<{ rows?: ImportRowInput[] }>().catch(() => ({} as { rows?: ImportRowInput[] }));
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
  if (rows.length === 0) return c.json({ error: "no_rows" }, 400);
  const db = getDb(c.env);
  const parsed = rows.map((r, i) => ({ line: i + 2, ...parseImportRow(r) }));
  const codes = Array.from(new Set(parsed.flatMap((p) => (p.ok ? [p.item_code] : []))));
  const skus = await skuByCodes(db, co.companyId, codes);
  const existing = await db.select({ id: pos_items.id, product_id: pos_items.product_id }).from(pos_items).where(eq(pos_items.company_id, co.companyId));
  const existingByProduct = new Map(existing.map((e) => [e.product_id, e.id]));
  const result = { created: 0, updated: 0, skipped: [] as { line: number; item_code: string | null; reason: string }[] };
  for (const p of parsed) {
    if (!p.ok) { result.skipped.push({ line: p.line, item_code: p.item_code, reason: p.reason }); continue; }
    const sku = skus.get(p.item_code.toUpperCase());
    if (!sku) { result.skipped.push({ line: p.line, item_code: p.item_code, reason: "item code not in inventory" }); continue; }
    const patch = itemPatchFrom(p.fields);
    const id = existingByProduct.get(sku.product_id);
    if (id) {
      await db.update(pos_items).set({ ...patch, updated_at: nowIso() }).where(eq(pos_items.id, id));
      result.updated += 1;
    } else {
      const [row] = await db.insert(pos_items).values({ company_id: co.companyId, product_id: sku.product_id, item_code: sku.code, name: sku.name, price_sen: patch.price_sen ?? sku.sell_price_sen ?? 0, cost_sen: patch.cost_sen ?? sku.cost_price_sen ?? null, ...patch }).returning({ id: pos_items.id });
      existingByProduct.set(sku.product_id, row.id);
      result.created += 1;
    }
    if (p.barcode && p.barcode !== sku.barcode) {
      const itemId = existingByProduct.get(sku.product_id)!;
      const clash = await db.select({ id: pos_item_barcodes.id }).from(pos_item_barcodes).where(and(eq(pos_item_barcodes.company_id, co.companyId), eq(pos_item_barcodes.barcode, p.barcode)));
      if (clash.length === 0) await db.insert(pos_item_barcodes).values({ company_id: co.companyId, pos_item_id: itemId, barcode: p.barcode });
    }
  }
  return c.json(result);
});

/* ── barcode labels (E1b) ──────────────────────────────────────────────── */

posAdmin.get("/labels", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
  const rows = await labelRows(db, co.companyId, { search: (c.req.query("search") ?? "").trim(), missingOnly: c.req.query("missing") === "1", ids, page, pageSize: ids.length > 0 ? 500 : 50 });
  const gen = rows.length ? await db.select().from(pos_generated_barcodes).where(and(eq(pos_generated_barcodes.company_id, co.companyId), inArray(pos_generated_barcodes.product_id, rows.map((r) => r.product_id)))) : [];
  const genBy = new Map(gen.map((g) => [g.product_id, g.barcode]));
  const posTagged = rows.length ? await db.select({ product_id: pos_items.product_id }).from(pos_items).where(and(eq(pos_items.company_id, co.companyId), inArray(pos_items.product_id, rows.map((r) => r.product_id)))) : [];
  const tagged = new Set(posTagged.map((t) => t.product_id));
  return c.json({
    total: rows[0]?.total ?? 0,
    page,
    data: rows.map((r) => {
      const own = genBy.get(r.product_id) ?? null;
      const status = r.factory_barcode && r.factory_barcode !== own ? "FACTORY" : own ? "GENERATED" : "NONE";
      return { product_id: r.product_id, code: r.code, name: r.name, category: r.category, factory_barcode: r.factory_barcode, own_barcode: own, status, sell_price_sen: r.sell_price_sen, is_pos_item: tagged.has(r.product_id) };
    }),
  });
});

posAdmin.post("/labels/generate", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json<{ product_ids?: string[] }>().catch(() => ({} as { product_ids?: string[] }));
  const ids = Array.isArray(body.product_ids) ? body.product_ids.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  if (ids.length === 0) return c.json({ error: "no_items" }, 400);
  const db = getDb(c.env);
  const facts = await skuFactsByIds(db, co.companyId, ids);
  const have = new Map((await db.select().from(pos_generated_barcodes).where(and(eq(pos_generated_barcodes.company_id, co.companyId), inArray(pos_generated_barcodes.product_id, ids)))).map((g) => [g.product_id, g.barcode]));
  const generated: { product_id: string; barcode: string }[] = [];
  for (const id of ids) {
    if (!facts.has(id) || have.has(id)) continue;
    const barcode = await nextEan13(db);
    await db.insert(pos_generated_barcodes).values({ company_id: co.companyId, product_id: id, barcode, generated_by: c.get("user")?.id ?? null });
    await stampSkuBarcodeIfEmpty(db, co.companyId, id, barcode);
    generated.push({ product_id: id, barcode });
  }
  return c.json({ generated, already: ids.filter((id) => have.has(id)).length, unknown: ids.filter((id) => !facts.has(id)).length });
});

/* ── cashiers (E2) ─────────────────────────────────────────────────────── */

type CashierBody = { code?: string; name?: string; phone?: string | null; pin?: string; role?: string; max_discount_pct?: number; working_hours_note?: string | null; bank_note?: string | null; event_ids?: number[]; active?: boolean };

async function cashierEvents(db: Db, companyId: number, cashierIds: number[]) {
  if (cashierIds.length === 0) return [] as { cashier_id: number; project_id: number; name: string }[];
  return db.execute<{ cashier_id: number; project_id: number; name: string }>(sql`
    SELECT ec.cashier_id, l.project_id, p.name
      FROM pos_event_cashiers ec
      JOIN pos_event_links l ON l.id = ec.link_id AND l.company_id = ${companyId}
      JOIN projects p ON p.id = l.project_id
     WHERE ec.cashier_id IN ${cashierIds}
     ORDER BY p.start_date DESC NULLS LAST`);
}

posAdmin.get("/cashiers", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const rows = await db.select().from(pos_cashiers).where(eq(pos_cashiers.company_id, co.companyId)).orderBy(asc(pos_cashiers.code));
  const ev = await cashierEvents(db, co.companyId, rows.map((r) => r.id));
  return c.json({
    data: rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, phone: r.phone, role: r.role, max_discount_pct: Number(r.max_discount_pct),
      working_hours_note: r.working_hours_note, bank_note: r.bank_note, active: r.active, last_login_at: r.last_login_at,
      events: ev.filter((e) => Number(e.cashier_id) === r.id).map((e) => ({ project_id: Number(e.project_id), name: e.name })),
      created_at: r.created_at,
    })),
  });
});

async function setCashierEvents(db: Db, companyId: number, cashierId: number, projectIds: number[]) {
  const links = projectIds.length ? await db.select({ id: pos_event_links.id, project_id: pos_event_links.project_id }).from(pos_event_links).where(and(eq(pos_event_links.company_id, companyId), inArray(pos_event_links.project_id, projectIds))) : [];
  await db.delete(pos_event_cashiers).where(eq(pos_event_cashiers.cashier_id, cashierId));
  if (links.length) await db.insert(pos_event_cashiers).values(links.map((l) => ({ link_id: l.id, cashier_id: cashierId })));
}

posAdmin.post("/cashiers", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json<CashierBody>().catch(() => ({} as CashierBody));
  const name = str(body.name);
  if (!name) return c.json({ error: "name_required" }, 400);
  if (!isPosCashierPin(body.pin)) return c.json({ error: "pin_invalid", reason: "PIN must be 4 to 6 digits" }, 400);
  const role = isCashierRole(body.role) ? body.role : "PARTTIME";
  const db = getDb(c.env);
  const existingCodes = (await db.select({ code: pos_cashiers.code }).from(pos_cashiers).where(eq(pos_cashiers.company_id, co.companyId))).map((r) => r.code);
  const code = str(body.code)?.toUpperCase() ?? nextCode("C", existingCodes);
  if (existingCodes.includes(code)) return c.json({ error: "code_taken" }, 409);
  const [row] = await db
    .insert(pos_cashiers)
    .values({
      company_id: co.companyId, code, name, phone: str(body.phone), pin_hash: await hashPassword(body.pin!), role,
      max_discount_pct: String(Math.min(100, Math.max(0, num(body.max_discount_pct) ?? 0))),
      working_hours_note: str(body.working_hours_note), bank_note: str(body.bank_note), active: bool(body.active, true),
    })
    .returning({ id: pos_cashiers.id });
  if (Array.isArray(body.event_ids)) await setCashierEvents(db, co.companyId, row.id, body.event_ids.filter((n) => Number.isInteger(n)));
  await audit(db, co.companyId, c, "pos_cashier", row.id, "created", null, code);
  return c.json({ ok: true, id: row.id, code }, 201);
});

posAdmin.patch("/cashiers/:id", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "invalid_id" }, 400);
  const body = await c.req.json<CashierBody>().catch(() => ({} as CashierBody));
  const db = getDb(c.env);
  const patch: Partial<typeof pos_cashiers.$inferInsert> = { updated_at: nowIso() };
  if (body.name !== undefined) { const n = str(body.name); if (!n) return c.json({ error: "name_required" }, 400); patch.name = n; }
  if (body.phone !== undefined) patch.phone = str(body.phone);
  if (isCashierRole(body.role)) patch.role = body.role;
  if (body.max_discount_pct !== undefined) patch.max_discount_pct = String(Math.min(100, Math.max(0, num(body.max_discount_pct) ?? 0)));
  if (body.working_hours_note !== undefined) patch.working_hours_note = str(body.working_hours_note);
  if (body.bank_note !== undefined) patch.bank_note = str(body.bank_note);
  if (body.active !== undefined) patch.active = bool(body.active, true);
  const res = await db.update(pos_cashiers).set(patch).where(and(eq(pos_cashiers.id, id), eq(pos_cashiers.company_id, co.companyId))).returning({ id: pos_cashiers.id });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  if (Array.isArray(body.event_ids)) await setCashierEvents(db, co.companyId, id, body.event_ids.filter((n) => Number.isInteger(n)));
  if (body.active === false) await audit(db, co.companyId, c, "pos_cashier", id, "active", "true", "false");
  return c.json({ ok: true });
});

posAdmin.post("/cashiers/:id/pin", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "invalid_id" }, 400);
  const body = await c.req.json<{ pin?: string }>().catch(() => ({} as { pin?: string }));
  if (!isPosCashierPin(body.pin)) return c.json({ error: "pin_invalid", reason: "PIN must be 4 to 6 digits" }, 400);
  const db = getDb(c.env);
  const res = await db.update(pos_cashiers).set({ pin_hash: await hashPassword(body.pin!), updated_at: nowIso() }).where(and(eq(pos_cashiers.id, id), eq(pos_cashiers.company_id, co.companyId))).returning({ id: pos_cashiers.id });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  await audit(db, co.companyId, c, "pos_cashier", id, "pin", null, "reset");
  return c.json({ ok: true });
});

/* ── events (E3) ───────────────────────────────────────────────────────── */

type EventProjectRow = { id: number; code: string | null; name: string; start_date: string | null; end_date: string | null; event_type_slug: string | null; event_type_name: string | null; venue: string | null };

async function eventProjects(db: Db, companyId: number, opts: { linkedProjectIds: number[]; search: string | null; limit: number }): Promise<EventProjectRow[]> {
  const like = opts.search ? `%${opts.search.replace(/[%_]/g, "")}%` : null;
  return db.execute<EventProjectRow>(sql`
    SELECT p.id, p.code, p.name, p.start_date, p.end_date, et.slug AS event_type_slug, et.name AS event_type_name, p.venue
      FROM projects p
      LEFT JOIN project_event_types et ON et.id = p.event_type_id
     WHERE p.company_id = ${companyId} AND p.archived_at IS NULL
       AND (et.slug = ${CASH_CARRY_SLUG} ${opts.linkedProjectIds.length ? sql`OR p.id IN ${opts.linkedProjectIds}` : sql``} ${like ? sql`OR p.name ILIKE ${like} OR p.code ILIKE ${like}` : sql``})
     ORDER BY p.start_date DESC NULLS LAST, p.id DESC
     LIMIT ${opts.limit}`);
}

async function eventPayload(db: Db, companyId: number, projects: EventProjectRow[]) {
  const ids = projects.map((p) => Number(p.id));
  const links = ids.length ? await db.select().from(pos_event_links).where(and(eq(pos_event_links.company_id, companyId), inArray(pos_event_links.project_id, ids))) : [];
  const linkIds = links.map((l) => l.id);
  const [cashiers, items, prices, terminals] = await Promise.all([
    linkIds.length ? db.select({ link_id: pos_event_cashiers.link_id, cashier_id: pos_event_cashiers.cashier_id, name: pos_cashiers.name, code: pos_cashiers.code }).from(pos_event_cashiers).innerJoin(pos_cashiers, eq(pos_cashiers.id, pos_event_cashiers.cashier_id)).where(inArray(pos_event_cashiers.link_id, linkIds)) : [],
    linkIds.length ? db.select().from(pos_event_items).where(inArray(pos_event_items.link_id, linkIds)) : [],
    linkIds.length ? db.select().from(pos_event_prices).where(inArray(pos_event_prices.link_id, linkIds)) : [],
    ids.length ? db.select().from(pos_terminals).where(and(eq(pos_terminals.company_id, companyId), inArray(pos_terminals.project_id, ids))) : [],
  ]);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return projects.map((p) => {
    const pid = Number(p.id);
    const link = links.find((l) => l.project_id === pid) ?? null;
    return {
      project_id: pid, code: p.code, name: p.name, start_date: p.start_date, end_date: p.end_date, venue: p.venue,
      event_type_slug: p.event_type_slug, event_type_name: p.event_type_name,
      type_label: p.event_type_slug === CASH_CARRY_SLUG ? "Cash & Carry" : "Fair + SO",
      status: posEventStatus({ linked: !!link, start_date: p.start_date, end_date: p.end_date }, today),
      link: link
        ? {
            id: link.id, catalog_scope: link.catalog_scope, stock_source_warehouse_id: link.stock_source_warehouse_id, sst_default: link.sst_default,
            receipt_header: link.receipt_header, catalog_version: link.catalog_version, pushed_at: link.pushed_at,
            cashiers: cashiers.filter((x) => x.link_id === link.id).map((x) => ({ id: x.cashier_id, name: x.name, code: x.code })),
            item_ids: items.filter((x) => x.link_id === link.id).map((x) => x.pos_item_id),
            price_overrides: prices.filter((x) => x.link_id === link.id).map((x) => ({ pos_item_id: x.pos_item_id, price_sen: x.price_sen })),
          }
        : null,
      terminals: terminals.filter((t) => t.project_id === pid).map((t) => ({ id: t.id, code: t.code, device_name: t.device_name, prepared_at: t.prepared_at, last_sync_at: t.last_sync_at, active: t.active })),
    };
  });
}

posAdmin.get("/events", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const linked = (await db.select({ project_id: pos_event_links.project_id }).from(pos_event_links).where(eq(pos_event_links.company_id, co.companyId))).map((l) => l.project_id);
  const projects = await eventProjects(db, co.companyId, { linkedProjectIds: linked, search: null, limit: 300 });
  return c.json({ data: await eventPayload(db, co.companyId, projects) });
});

posAdmin.get("/events/candidates", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ data: [] });
  const db = getDb(c.env);
  const rows = await eventProjects(db, co.companyId, { linkedProjectIds: [], search: q, limit: 20 });
  return c.json({ data: rows.map((p) => ({ project_id: Number(p.id), code: p.code, name: p.name, start_date: p.start_date, end_date: p.end_date, event_type_name: p.event_type_name })) });
});

type EventBody = { catalog_scope?: string; stock_source_warehouse_id?: string | null; sst_default?: boolean; receipt_header?: string | null; cashier_ids?: number[]; terminal_ids?: number[]; item_ids?: number[]; price_overrides?: { pos_item_id: number; price_sen: number }[] };

posAdmin.put("/events/:projectId", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const projectId = intParam(c, "projectId");
  if (!projectId) return c.json({ error: "invalid_project_id" }, 400);
  const body = await c.req.json<EventBody>().catch(() => ({} as EventBody));
  const db = getDb(c.env);
  const proj = await db.execute<{ id: number }>(sql`SELECT id FROM projects WHERE id = ${projectId} AND company_id = ${co.companyId} AND archived_at IS NULL`);
  if (proj.length === 0) return c.json({ error: "Not found" }, 404);
  const values = {
    catalog_scope: body.catalog_scope === "PICK" ? "PICK" : "ALL",
    stock_source_warehouse_id: body.stock_source_warehouse_id === undefined ? undefined : str(body.stock_source_warehouse_id),
    sst_default: body.sst_default === undefined ? undefined : bool(body.sst_default, false),
    receipt_header: body.receipt_header === undefined ? undefined : str(body.receipt_header),
    updated_at: nowIso(),
  };
  const [link] = await db
    .insert(pos_event_links)
    .values({ company_id: co.companyId, project_id: projectId, catalog_scope: values.catalog_scope, stock_source_warehouse_id: values.stock_source_warehouse_id ?? null, sst_default: values.sst_default ?? false, receipt_header: values.receipt_header ?? null })
    .onConflictDoUpdate({ target: [pos_event_links.company_id, pos_event_links.project_id], set: values })
    .returning({ id: pos_event_links.id });
  const ownCashiers = (await db.select({ id: pos_cashiers.id }).from(pos_cashiers).where(eq(pos_cashiers.company_id, co.companyId))).map((r) => r.id);
  const ownItems = (await db.select({ id: pos_items.id }).from(pos_items).where(eq(pos_items.company_id, co.companyId))).map((r) => r.id);
  if (Array.isArray(body.cashier_ids)) {
    const ids = body.cashier_ids.filter((n) => ownCashiers.includes(n));
    await db.delete(pos_event_cashiers).where(eq(pos_event_cashiers.link_id, link.id));
    if (ids.length) await db.insert(pos_event_cashiers).values(ids.map((cashier_id) => ({ link_id: link.id, cashier_id })));
  }
  if (Array.isArray(body.item_ids)) {
    const ids = body.item_ids.filter((n) => ownItems.includes(n));
    await db.delete(pos_event_items).where(eq(pos_event_items.link_id, link.id));
    if (ids.length) await db.insert(pos_event_items).values(ids.map((pos_item_id) => ({ link_id: link.id, pos_item_id })));
  }
  if (Array.isArray(body.price_overrides)) {
    const rows = body.price_overrides.filter((o) => ownItems.includes(Number(o.pos_item_id)) && Number.isFinite(Number(o.price_sen)) && Number(o.price_sen) >= 0);
    await db.delete(pos_event_prices).where(eq(pos_event_prices.link_id, link.id));
    if (rows.length) await db.insert(pos_event_prices).values(rows.map((o) => ({ link_id: link.id, pos_item_id: Number(o.pos_item_id), price_sen: Math.round(Number(o.price_sen)) })));
  }
  if (Array.isArray(body.terminal_ids)) {
    const ids = body.terminal_ids.filter((n) => Number.isInteger(n));
    await db.update(pos_terminals).set({ project_id: null, updated_at: nowIso() }).where(and(eq(pos_terminals.company_id, co.companyId), eq(pos_terminals.project_id, projectId)));
    if (ids.length) await db.update(pos_terminals).set({ project_id: projectId, updated_at: nowIso() }).where(and(eq(pos_terminals.company_id, co.companyId), inArray(pos_terminals.id, ids)));
  }
  await audit(db, co.companyId, c, "pos_event_link", projectId, "saved", null, JSON.stringify({ scope: values.catalog_scope, cashiers: body.cashier_ids?.length ?? null, terminals: body.terminal_ids?.length ?? null }));
  return c.json({ ok: true, link_id: link.id });
});

posAdmin.post("/events/:projectId/push", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const projectId = intParam(c, "projectId");
  if (!projectId) return c.json({ error: "invalid_project_id" }, 400);
  const db = getDb(c.env);
  const res = await db
    .update(pos_event_links)
    .set({ catalog_version: sql`${pos_event_links.catalog_version} + 1`, pushed_at: nowIso(), updated_at: nowIso() })
    .where(and(eq(pos_event_links.company_id, co.companyId), eq(pos_event_links.project_id, projectId)))
    .returning({ catalog_version: pos_event_links.catalog_version });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true, catalog_version: res[0].catalog_version });
});

posAdmin.delete("/events/:projectId", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const projectId = intParam(c, "projectId");
  if (!projectId) return c.json({ error: "invalid_project_id" }, 400);
  const db = getDb(c.env);
  const res = await db.delete(pos_event_links).where(and(eq(pos_event_links.company_id, co.companyId), eq(pos_event_links.project_id, projectId))).returning({ id: pos_event_links.id });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  await db.update(pos_terminals).set({ project_id: null, updated_at: nowIso() }).where(and(eq(pos_terminals.company_id, co.companyId), eq(pos_terminals.project_id, projectId)));
  await audit(db, co.companyId, c, "pos_event_link", projectId, "unlinked", "linked", null);
  return c.json({ ok: true });
});

/* ── terminals (E5) ────────────────────────────────────────────────────── */

type TerminalBody = { code?: string; device_name?: string | null; platform?: string | null; project_id?: number | null; active?: boolean };

posAdmin.get("/terminals", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const rows = await db.select().from(pos_terminals).where(eq(pos_terminals.company_id, co.companyId)).orderBy(asc(pos_terminals.code));
  const pids = Array.from(new Set(rows.map((r) => r.project_id).filter((v): v is number => v != null)));
  const names = pids.length ? await db.execute<{ id: number; name: string }>(sql`SELECT id, name FROM projects WHERE id IN ${pids} AND company_id = ${co.companyId}`) : [];
  const nameBy = new Map(names.map((n) => [Number(n.id), n.name]));
  return c.json({
    data: rows.map((r) => ({
      id: r.id, code: r.code, device_name: r.device_name, platform: r.platform, project_id: r.project_id, project_name: r.project_id ? nameBy.get(r.project_id) ?? null : null,
      printer: r.printer, prepared_at: r.prepared_at, last_seen_at: r.last_seen_at, last_sync_at: r.last_sync_at, pending_count: r.pending_count,
      pending_amount_sen: r.pending_amount_sen, receipt_counter: r.receipt_counter, app_version: r.app_version, status: r.status, active: r.active,
    })),
  });
});

posAdmin.post("/terminals", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json<TerminalBody>().catch(() => ({} as TerminalBody));
  const db = getDb(c.env);
  const existing = (await db.select({ code: pos_terminals.code }).from(pos_terminals).where(eq(pos_terminals.company_id, co.companyId))).map((r) => r.code);
  const code = str(body.code)?.toUpperCase() ?? nextCode("T", existing);
  if (!/^[A-Z0-9-]{2,12}$/.test(code)) return c.json({ error: "code_invalid" }, 400);
  if (existing.includes(code)) return c.json({ error: "code_taken" }, 409);
  const [row] = await db.insert(pos_terminals).values({ company_id: co.companyId, code, device_name: str(body.device_name), platform: str(body.platform), project_id: num(body.project_id) ?? null }).returning({ id: pos_terminals.id });
  return c.json({ ok: true, id: row.id, code }, 201);
});

posAdmin.patch("/terminals/:id", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "invalid_id" }, 400);
  const body = await c.req.json<TerminalBody>().catch(() => ({} as TerminalBody));
  const patch: Partial<typeof pos_terminals.$inferInsert> = { updated_at: nowIso() };
  if (body.device_name !== undefined) patch.device_name = str(body.device_name);
  if (body.platform !== undefined) patch.platform = str(body.platform);
  if (body.project_id !== undefined) patch.project_id = num(body.project_id) ?? null;
  if (body.active !== undefined) { patch.active = bool(body.active, true); if (!patch.active) patch.status = "INACTIVE"; }
  const db = getDb(c.env);
  const res = await db.update(pos_terminals).set(patch).where(and(eq(pos_terminals.id, id), eq(pos_terminals.company_id, co.companyId))).returning({ id: pos_terminals.id });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/* ── device registration (layout P15 "Prepare device") ─────────────────── */

/** An admin signed in on the device picks a terminal + event: the terminal is
 *  bound to the event, a fresh device token is minted (its hash stored; the
 *  token itself shown to the device once) and the bundle comes back with it.
 *  Re-preparing a terminal rotates its token, so a lost device stops talking. */
posAdmin.post("/device/register", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  type RegisterBody = { terminal_id?: number; project_id?: number; device_name?: string | null; platform?: string | null };
  const body = await c.req.json<RegisterBody>().catch(() => ({} as RegisterBody));
  const terminalId = num(body.terminal_id);
  const projectId = num(body.project_id);
  if (!terminalId || !projectId) return c.json({ error: "terminal_and_event_required" }, 400);
  const db = getDb(c.env);
  const link = await db.select({ id: pos_event_links.id }).from(pos_event_links).where(and(eq(pos_event_links.company_id, co.companyId), eq(pos_event_links.project_id, projectId)));
  if (link.length === 0) return c.json({ error: "event_not_linked", reason: "Link the project to POS in POS Admin > Events first." }, 409);
  const token = mintDeviceToken();
  const now = nowIso();
  const res = await db
    .update(pos_terminals)
    .set({ project_id: projectId, token_hash: await deviceTokenHash(token), prepared_at: now, last_seen_at: now, status: "PREPARED", device_name: str(body.device_name) ?? undefined, platform: str(body.platform) ?? undefined, updated_at: now })
    .where(and(eq(pos_terminals.id, terminalId), eq(pos_terminals.company_id, co.companyId), eq(pos_terminals.active, true)))
    .returning({ id: pos_terminals.id, code: pos_terminals.code });
  if (res.length === 0) return c.json({ error: "Not found" }, 404);
  const bundle = await loadPosBundle(db, co.companyId, terminalId, await companyBlock(c.env, co.companyId));
  if (!bundle) return c.json({ error: "bundle_failed" }, 500);
  await audit(db, co.companyId, c, "pos_terminal", terminalId, "prepared", null, `${res[0].code} -> project ${projectId}`);
  return c.json({ token, bundle });
});


/* ── Sync Status (layout E7) ───────────────────────────────────────────── */

posAdmin.get("/status", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const db = getDb(c.env);
  const now = Date.now();
  const [general, facts, extra, alerts] = await Promise.all([
    generalSettings(db, co.companyId),
    loadTerminalFacts(db, co.companyId),
    db.select({ id: pos_terminals.id, platform: pos_terminals.platform, printer: pos_terminals.printer, app_version: pos_terminals.app_version, receipt_counter: pos_terminals.receipt_counter }).from(pos_terminals).where(eq(pos_terminals.company_id, co.companyId)),
    db.select().from(pos_alerts).where(eq(pos_alerts.company_id, co.companyId)).orderBy(desc(pos_alerts.created_at)).limit(200),
  ]);
  const extraBy = new Map(extra.map((e) => [e.id, e]));
  const termBy = new Map(facts.map((t) => [t.id, t]));
  const terminals = facts.map((t) => ({ ...t, ...(extraBy.get(t.id) ?? { platform: null, printer: null, app_version: null, receipt_counter: 0 }), status_word: terminalStatusWord(t, general.alert_pending_days, now) }));
  const active = facts.filter((t) => t.active);
  const open = alerts.filter((a) => !a.resolved_at);
  return c.json({
    thresholds: { pending_days: general.alert_pending_days, event_end_days: general.alert_event_end_days, alert_email: general.alert_email, heartbeat_minutes: general.heartbeat_minutes },
    kpis: {
      terminals_active: active.filter((t) => t.prepared_at).length,
      terminals_total: active.length,
      pending_count: active.reduce((n, t) => n + t.pending_count, 0),
      pending_sen: active.reduce((n, t) => n + t.pending_amount_sen, 0),
      open_alerts: open.length,
      critical_alerts: open.filter((a) => a.type === "DATA_LOST").length,
    },
    terminals,
    alerts: alerts.map((a) => {
      const t = a.terminal_id == null ? undefined : termBy.get(a.terminal_id);
      const words = a.type in ALERT_WORDS ? ALERT_WORDS[a.type as AlertType] : { title: a.type, level: "AMBER" as const };
      return { id: a.id, type: a.type, title: words.title, level: words.level, terminal_id: a.terminal_id, terminal_code: t?.code ?? null, project_id: a.project_id, event_name: t?.event_name ?? null, detail: a.detail, email_sent_at: a.email_sent_at, last_resent_at: a.last_resent_at, resolved_at: a.resolved_at, created_at: a.created_at };
    }),
    at: new Date(now).toISOString(),
  });
});

/** Acknowledge an alert by hand: the bills were recovered (Import backup) or
 *  the device is written off. The terminal's pending figures and the
 *  data-lost mark are cleared, so the watchdog does not reopen it. */
posAdmin.post("/alerts/:id/acknowledge", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "invalid_id" }, 400);
  const db = getDb(c.env);
  const rows = await db.select().from(pos_alerts).where(and(eq(pos_alerts.id, id), eq(pos_alerts.company_id, co.companyId))).limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const a = rows[0];
  const now = nowIso();
  if (!a.resolved_at) await db.update(pos_alerts).set({ resolved_at: now }).where(eq(pos_alerts.id, id));
  if (a.terminal_id != null) {
    await db.update(pos_terminals).set({ pending_count: 0, pending_amount_sen: 0, last_known_pending_count: 0, last_known_pending_sen: 0, db_empty_at: null, status: "SYNCED", updated_at: now }).where(and(eq(pos_terminals.id, a.terminal_id), eq(pos_terminals.company_id, co.companyId)));
  }
  await audit(db, co.companyId, c, "pos_alert", id, "acknowledged", a.type, now);
  return c.json({ ok: true });
});

/* ── Import backup (layout E8) ─────────────────────────────────────────── */

type BackupRow = { uuid: string; receipt_no: string; type: string; status: string; sold_at: string; total_sen: number; cashier_name: string; kind: PreviewKind | "INVALID"; reason?: string };

/** Open the dropped file with the terminal's stored token hash and classify
 *  every receipt; shared by the preview and the import. */
async function openBackup(db: Db, companyId: number, raw: unknown): Promise<{ ok: true; terminal: typeof pos_terminals.$inferSelect; file: PosBackupFile; sales: IncomingSale[]; rows: BackupRow[] } | { ok: false; error: string; reason: string }> {
  if (!isPosBackupFile(raw)) return { ok: false, error: "not_a_backup", reason: "This is not a Houzs POS backup file (houzs_pos_T0x_backup.json)." };
  const found = await db.select().from(pos_terminals).where(and(eq(pos_terminals.company_id, companyId), eq(pos_terminals.code, raw.terminal))).limit(1);
  if (found.length === 0) return { ok: false, error: "terminal_unknown", reason: `Terminal ${raw.terminal} does not exist in this company.` };
  const terminal = found[0];
  if (!terminal.token_hash) return { ok: false, error: "terminal_never_prepared", reason: `Terminal ${raw.terminal} was never prepared, so no key can open its backup.` };
  let parsedList: unknown[];
  try {
    const json: unknown = JSON.parse(await decryptBackupPayload(raw, terminal.token_hash));
    if (!Array.isArray(json)) return { ok: false, error: "backup_malformed", reason: "The file opened but holds no receipt list." };
    parsedList = json;
  } catch {
    return { ok: false, error: "cannot_decrypt", reason: `The file cannot be opened with the current key of ${raw.terminal}. A re-prepared terminal gets a new key; backups written before that need the old device.` };
  }
  const sales: IncomingSale[] = [];
  const rows: BackupRow[] = [];
  for (const r of parsedList) {
    const p = parseIncomingSale(r);
    const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    if (!p.ok) { rows.push({ uuid: String(o.uuid ?? ""), receipt_no: String(o.receipt_no ?? ""), type: String(o.type ?? ""), status: String(o.status ?? ""), sold_at: String(o.sold_at ?? ""), total_sen: Number(o.total_sen ?? 0), cashier_name: String(o.cashier_name ?? ""), kind: "INVALID", reason: p.reason }); continue; }
    const s = p.sale;
    if (s.terminal_code !== terminal.code) { rows.push({ uuid: s.uuid, receipt_no: s.receipt_no, type: s.type, status: s.status, sold_at: s.sold_at, total_sen: s.total_sen, cashier_name: s.cashier_name, kind: "INVALID", reason: `receipt belongs to terminal ${s.terminal_code}` }); continue; }
    const pv = await previewSale(db, companyId, s);
    sales.push(s);
    rows.push({ uuid: s.uuid, receipt_no: s.receipt_no, type: s.type, status: s.status, sold_at: s.sold_at, total_sen: s.total_sen, cashier_name: s.cashier_name, kind: pv.kind, reason: pv.reason });
  }
  return { ok: true, terminal, file: raw, sales, rows };
}

const backupSummary = (rows: BackupRow[]) => ({
  new: rows.filter((r) => r.kind === "NEW").length, update: rows.filter((r) => r.kind === "UPDATE").length, duplicate: rows.filter((r) => r.kind === "DUPLICATE").length,
  conflict: rows.filter((r) => r.kind === "CONFLICT").length, invalid: rows.filter((r) => r.kind === "INVALID").length,
  new_sen: rows.filter((r) => r.kind === "NEW" && r.status === "PAID").reduce((n, r) => n + r.total_sen, 0),
});

posAdmin.post("/backup/preview", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json<{ file?: unknown }>().catch(() => ({} as { file?: unknown }));
  const db = getDb(c.env);
  const opened = await openBackup(db, co.companyId, body.file);
  if (!opened.ok) return c.json({ error: opened.error, reason: opened.reason }, 422);
  const ev = await db.execute<{ name: string }>(sql`SELECT name FROM projects WHERE id = ${opened.file.project_id} AND company_id = ${co.companyId}`);
  return c.json({
    terminal: { id: opened.terminal.id, code: opened.terminal.code, device_name: opened.terminal.device_name, pending_count: opened.terminal.pending_count, db_empty_at: opened.terminal.db_empty_at },
    file: { exported_at: opened.file.exported_at, count: opened.file.count, total_sen: opened.file.total_sen, receipt_counter: opened.file.receipt_counter, project_id: opened.file.project_id, event_name: ev.length ? ev[0].name : null },
    rows: opened.rows, summary: backupSummary(opened.rows),
  });
});

/** Import: every NEW and UPDATE receipt goes through the same ingest as the
 *  device sync (stock booked, audit written); DUPLICATE, CONFLICT and INVALID
 *  rows are left alone and reported. `uuids` narrows it to a selection. */
posAdmin.post("/backup/import", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const body = await c.req.json<{ file?: unknown; uuids?: unknown }>().catch(() => ({} as { file?: unknown; uuids?: unknown }));
  const db = getDb(c.env);
  const opened = await openBackup(db, co.companyId, body.file);
  if (!opened.ok) return c.json({ error: opened.error, reason: opened.reason }, 422);
  const only = Array.isArray(body.uuids) ? new Set(body.uuids.filter((u): u is string => typeof u === "string")) : null;
  const warehouseId = await stockLocationFor(db, co.companyId, opened.file.project_id);
  const u = c.get("user");
  const who = `import ${opened.terminal.code} by ${u?.name ?? u?.email ?? "admin"}`;
  const results: BatchResult[] = [];
  for (const s of opened.sales) {
    const row = opened.rows.find((r) => r.uuid === s.uuid);
    if (!row || row.kind === "CONFLICT" || row.kind === "DUPLICATE" || row.kind === "INVALID") continue;
    if (only && !only.has(s.uuid)) continue;
    results.push(await ingestSale(db, co.companyId, warehouseId, s, who));
  }
  const accepted = results.filter((r) => r.status === "accepted").length;
  const updated = results.filter((r) => r.status === "updated").length;
  const rejected = results.filter((r) => r.status === "rejected");
  const counter = opened.file.receipt_counter > opened.terminal.receipt_counter ? opened.file.receipt_counter : opened.terminal.receipt_counter;
  await db.update(pos_terminals).set({ receipt_counter: counter, updated_at: nowIso() }).where(eq(pos_terminals.id, opened.terminal.id));
  await audit(db, co.companyId, c, "pos_terminal", opened.terminal.id, "backup_import", null, `${accepted} new, ${updated} updated, ${rejected.length} rejected (file ${opened.file.exported_at})`);
  return c.json({ ok: true, accepted, updated, rejected, skipped: backupSummary(opened.rows), results });
});


/* ── Sales Report (layout E6) ──────────────────────────────────────────── */

/** The report over one event: filters date range (Malaysia days), terminal,
 *  salesman, status; the shared aggregation; and the stock left per item at
 *  the event's stock location (else the POS store). */
posAdmin.get("/report", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const projectId = num(c.req.query("project_id"));
  if (!projectId) return c.json({ error: "project_id_required" }, 400);
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const terminal = str(c.req.query("terminal"));
  const salesman = str(c.req.query("salesman"));
  const status = str(c.req.query("status"))?.toUpperCase() ?? null;
  const db = getDb(c.env);
  const all = await loadReportSales(db, co.companyId, { projectId, terminalCode: terminal, fromIso: day.test(from) ? `${from}T00:00:00+08:00` : null, toIso: day.test(to) ? `${to}T23:59:59.999+08:00` : null });
  const sales = all.filter((s) => (!salesman || (s.salesman_name ?? "Booth") === salesman) && (!status || posReceiptStatusLabel(s) === status));
  const totals = aggregateSales(sales);
  const warehouseId = await stockLocationFor(db, co.companyId, projectId);
  const codes = totals.by_item.map((i) => i.item_code);
  const stock = codes.length
    ? await db.execute<{ item_code: string; qty: number | string }>(warehouseId
      ? sql`SELECT item_code, SUM(qty)::float8 AS qty FROM scm.inventory_balances WHERE company_id = ${co.companyId} AND warehouse_id = ${warehouseId}::uuid AND item_code IN ${codes} GROUP BY item_code`
      : sql`SELECT item_code, SUM(qty)::float8 AS qty FROM scm.inventory_balances WHERE company_id = ${co.companyId} AND item_code IN ${codes} GROUP BY item_code`)
    : [];
  const stockBy = new Map(stock.map((r) => [r.item_code, Number(r.qty)]));
  const ev = await db.execute<{ name: string; start_date: string | null; end_date: string | null }>(sql`SELECT name, start_date, end_date FROM projects WHERE id = ${projectId} AND company_id = ${co.companyId}`);
  return c.json({
    project: ev.length ? { id: projectId, ...ev[0] } : null,
    filter: { from: day.test(from) ? from : null, to: day.test(to) ? to : null, terminal, salesman, status },
    options: {
      terminals: Array.from(new Set(all.map((s) => s.terminal_code))).sort(),
      salesmen: Array.from(new Set(all.map((s) => s.salesman_name ?? "Booth"))).sort(),
    },
    totals,
    stock_left: Object.fromEntries(stockBy),
    stock_location: warehouseId,
    count: sales.length,
  });
});


/* ── pairing a device from the ERP (POS Admin > Terminals > Pair device) ── */

/** Hand out a one-time pairing code for a terminal whose event is set. The
 *  device redeems it at POST /api/pos-device/pair (no ERP sign-in on the
 *  device); the code lives PAIRING_MINUTES and is stored only as a hash. */
posAdmin.post("/terminals/:id/pairing", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = intParam(c, "id");
  if (!id) return c.json({ error: "invalid_id" }, 400);
  const db = getDb(c.env);
  const rows = await db.select({ id: pos_terminals.id, code: pos_terminals.code, project_id: pos_terminals.project_id, active: pos_terminals.active }).from(pos_terminals).where(and(eq(pos_terminals.id, id), eq(pos_terminals.company_id, co.companyId))).limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const t = rows[0];
  if (!t.active) return c.json({ error: "terminal_inactive", reason: "Reactivate the terminal first." }, 409);
  if (t.project_id == null) return c.json({ error: "event_required", reason: "Set the terminal's event first; the device downloads that event's catalog." }, 409);
  const link = await db.select({ id: pos_event_links.id }).from(pos_event_links).where(and(eq(pos_event_links.company_id, co.companyId), eq(pos_event_links.project_id, t.project_id))).limit(1);
  if (link.length === 0) return c.json({ error: "event_not_linked", reason: "Link that event to POS in POS Admin > Events first." }, 409);
  const code = mintPairingCode();
  const expires = new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString();
  await db.update(pos_terminals).set({ pairing_code_hash: await pairingCodeHash(code), pairing_expires_at: expires, updated_at: nowIso() }).where(eq(pos_terminals.id, id));
  await audit(db, co.companyId, c, "pos_terminal", id, "pairing_code_issued", null, expires);
  const origin = (c.env.POS_APP_ORIGIN ?? "https://pos.houzscentury.com").replace(/\/$/, "");
  return c.json({ code: formatPairingCode(code), expires_at: expires, url: `${origin}/?pair=${code}`, terminal: t.code });
});


/* ── the manager sign-in on the POS front (owner / admin with pos.manage) ── */

/** What an ERP account signed in on the POS needs before the device is set
 *  up: who they are, the company block for the receipt header, the settings.
 *  The mount already requires pos.manage, so a plain staff account gets 403. */
posAdmin.get("/device/context", async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const u = c.get("user");
  const db = getDb(c.env);
  const rows = await db.select().from(pos_settings).where(eq(pos_settings.company_id, co.companyId));
  const raw: Partial<Record<PosSettingsGroup, unknown>> = {};
  for (const r of rows) raw[r.group as PosSettingsGroup] = r.value;
  return c.json({ user: { id: u?.id ?? 0, name: u?.name ?? u?.email ?? "Manager" }, company: await companyBlock(c.env, co.companyId), settings: normalizePosSettings(raw) });
});

export { posAdmin };
