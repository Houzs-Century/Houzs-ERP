// ----------------------------------------------------------------------------
// pos-ingest.ts — ONE way a POS receipt enters the ERP, whether it arrives
// from the device's sync engine (POST /api/pos-device/sales/batch) or from a
// backup file dropped on POS Admin > Import backup (layout E8). Both paths
// classify the same way (new / duplicate / void / salesman / conflict), write
// the same rows (pos_sales, pos_sale_lines, pos_payments, pos_audit) and book
// the same inventory movements, so the Inventory never sees two versions of
// a receipt. Everything here is scoped by the company the caller resolved.
// ----------------------------------------------------------------------------
import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db/client";
import { pos_audit, pos_event_links, pos_payments, pos_sale_lines, pos_sales, pos_settings } from "../../db/schema";
import { normalizePosSettingsGroup } from "../../scm/shared/pos-settings";
import { auditEntriesFor, classifyIncoming, movementsFor, voidMovementsFor, type BatchResult, type IncomingSale, type MovementRow } from "./pos-sync";

export type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Where this terminal's event takes stock from: the event's booth allocation,
 *  else the General setting's POS store; null = no location (flagged). */
export async function stockLocationFor(db: Db, companyId: number, projectId: number | null): Promise<string | null> {
  if (projectId != null) {
    const link = await db.select({ w: pos_event_links.stock_source_warehouse_id }).from(pos_event_links).where(and(eq(pos_event_links.company_id, companyId), eq(pos_event_links.project_id, projectId))).limit(1);
    if (link.length && link[0].w) return link[0].w;
  }
  const rows = await db.select({ value: pos_settings.value }).from(pos_settings).where(and(eq(pos_settings.company_id, companyId), eq(pos_settings.group, "general"))).limit(1);
  return rows.length ? normalizePosSettingsGroup("general", rows[0].value).pos_store_warehouse_id : null;
}

/** The inventory movements of one receipt (or its void), logged against the
 *  receipt number. The FIFO trigger consumes lots on OUT and records a short
 *  when there are none (over-sell allowed offline); the balance that goes
 *  negative is the warning the Sync Status page shows. Idempotent per
 *  (doc type, receipt no): a second run writes nothing. */
export async function bookMovements(tx: Tx, companyId: number, warehouseId: string | null, rows: MovementRow[], who: string): Promise<string | null> {
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

type StoredRow = { id: number; status: string; salesman_id: number | null; salesman_name: string | null; terminal_code: string; receipt_no: string };

async function lookup(tx: Tx | Db, companyId: number, sale: IncomingSale): Promise<{ stored: StoredRow | null; clash: boolean }> {
  const stored = await tx.select({ id: pos_sales.id, status: pos_sales.status, salesman_id: pos_sales.salesman_id, salesman_name: pos_sales.salesman_name, terminal_code: pos_sales.terminal_code, receipt_no: pos_sales.receipt_no }).from(pos_sales).where(and(eq(pos_sales.company_id, companyId), eq(pos_sales.uuid, sale.uuid))).limit(1);
  const clash = stored.length ? [] : await tx.select({ id: pos_sales.id }).from(pos_sales).where(and(eq(pos_sales.company_id, companyId), eq(pos_sales.terminal_code, sale.terminal_code), eq(pos_sales.receipt_no, sale.receipt_no))).limit(1);
  return { stored: stored.length ? stored[0] : null, clash: clash.length > 0 };
}

const asStored = (s: StoredRow) => ({ ...s, status: s.status === "VOID" ? ("VOID" as const) : ("PAID" as const) });

export type PreviewKind = "NEW" | "DUPLICATE" | "UPDATE" | "CONFLICT";

/** What importing this receipt WOULD do (the Import backup preview). */
export async function previewSale(db: Db, companyId: number, sale: IncomingSale): Promise<{ kind: PreviewKind; reason?: string }> {
  const { stored, clash } = await lookup(db, companyId, sale);
  const cls = classifyIncoming(sale, stored ? asStored(stored) : null, clash);
  if (cls.kind === "conflict") return { kind: "CONFLICT", reason: cls.reason };
  if (cls.kind === "duplicate") return { kind: "DUPLICATE" };
  if (cls.kind === "new") return { kind: "NEW" };
  return { kind: "UPDATE", reason: cls.kind === "void" ? "marks the stored receipt VOID" : "updates the salesman" };
}

/** Write one receipt: insert, mark void, or update the salesman, booking the
 *  inventory movements in the same transaction. `source` is the audit trail's
 *  word for where it came from ("POS T02" or "import T02"). */
export async function ingestSale(db: Db, companyId: number, warehouseId: string | null, sale: IncomingSale, source: string): Promise<BatchResult> {
  try {
    return await db.transaction(async (tx) => {
      const { stored, clash } = await lookup(tx, companyId, sale);
      const cls = classifyIncoming(sale, stored ? asStored(stored) : null, clash);
      if (cls.kind === "conflict") return { uuid: sale.uuid, status: "rejected", reason: cls.reason } as BatchResult;
      if (cls.kind === "duplicate") return { uuid: sale.uuid, status: "duplicate" } as BatchResult;
      if (cls.kind === "salesman") {
        await tx.update(pos_sales).set({ salesman_id: sale.salesman_id, salesman_name: sale.salesman_name, updated_at: new Date().toISOString() }).where(eq(pos_sales.id, cls.stored.id));
        await tx.insert(pos_audit).values({ company_id: companyId, entity: "pos_sale", entity_id: String(cls.stored.id), field: "salesman", from_value: cls.stored.salesman_name, to_value: sale.salesman_name, by_name: `${sale.cashier_name} (${source})` });
        return { uuid: sale.uuid, status: "updated" } as BatchResult;
      }
      if (cls.kind === "void") {
        const warning = sale.status === "VOID" ? await bookMovements(tx, companyId, warehouseId, voidMovementsFor(sale), sale.void_by ?? sale.cashier_name) : null;
        await tx.update(pos_sales).set({ status: "VOID", void_reason: sale.void_reason, void_by: sale.void_by, voided_at: sale.voided_at ?? new Date().toISOString(), stock_warning: warning, updated_at: new Date().toISOString() }).where(eq(pos_sales.id, cls.stored.id));
        await tx.insert(pos_audit).values({ company_id: companyId, entity: "pos_sale", entity_id: String(cls.stored.id), field: "status", from_value: "PAID", to_value: "VOID", by_name: `${sale.void_by ?? sale.cashier_name} (${source})` });
        return { uuid: sale.uuid, status: "updated", stock_warning: warning } as BatchResult;
      }
      const warning = sale.status === "PAID" ? await bookMovements(tx, companyId, warehouseId, movementsFor(sale), sale.cashier_name) : null;
      const [row] = await tx.insert(pos_sales).values({
        uuid: sale.uuid, company_id: companyId, project_id: sale.project_id, terminal_code: sale.terminal_code, receipt_no: sale.receipt_no, type: sale.type, ref_sale_uuid: sale.ref_sale_uuid,
        cashier_id: sale.cashier_id, cashier_name: sale.cashier_name, salesman_id: sale.salesman_id, salesman_name: sale.salesman_name, customer_name: sale.customer_name, customer_phone: sale.customer_phone,
        sold_at: sale.sold_at, subtotal_sen: sale.subtotal_sen, item_discount_sen: sale.item_discount_sen, bill_discount_sen: sale.bill_discount_sen, bill_discount_by: sale.bill_discount_by, sst_applied: sale.sst_applied, sst_rate: String(sale.sst_rate),
        sst_amount_sen: sale.sst_amount_sen, rounding_sen: sale.rounding_sen, total_sen: sale.total_sen, status: sale.status, void_reason: sale.void_reason, void_by: sale.void_by, voided_at: sale.voided_at,
        is_test: false, source: source.startsWith("import") ? "IMPORT" : "NORMAL", local_seq: sale.local_seq, stock_warning: warning,
      }).returning({ id: pos_sales.id });
      await tx.insert(pos_sale_lines).values(sale.lines.map((l) => ({
        sale_id: row.id, line_no: l.line_no, item_id: l.item_id, item_code: l.code, description: l.description, uom: l.uom, qty: String(l.qty), unit_price_sen: l.unit_price_sen,
        original_price_sen: l.original_price_sen, override_by: l.override_by, override_reason: l.override_reason, discount_source: l.discount_source, discount_type: l.discount_type,
        discount_value: l.discount_value == null ? null : String(l.discount_value), discount_by: l.discount_by, discount_amount_sen: l.discount_amount_sen, is_foc: l.is_foc, amount_sen: l.amount_sen,
      })));
      if (sale.payments.length) await tx.insert(pos_payments).values(sale.payments.map((p) => ({ sale_id: row.id, method: p.method, amount_sen: p.amount_sen, reference: p.reference, tendered_sen: p.tendered_sen, change_sen: p.change_sen })));
      const audits = auditEntriesFor(sale, source);
      if (audits.length) await tx.insert(pos_audit).values(audits.map((a) => ({ company_id: companyId, entity: "pos_sale", entity_id: String(row.id), ...a })));
      return { uuid: sale.uuid, status: "accepted", stock_warning: warning } as BatchResult;
    });
  } catch (e) {
    return { uuid: sale.uuid, status: "rejected", reason: e instanceof Error ? e.message.slice(0, 200) : "write failed" };
  }
}
