// ----------------------------------------------------------------------------
// project-pos-sales — the Houzs POS bills synced from the booth terminals of
// ONE event, read from inside the project page (layout E9).
//
// WHY. A Cash & Carry fair has no Sales Order module: the part-timers at the
// booth sell through the POS app, every bill is saved on the device and then
// pushed into pos_sales / pos_sale_lines / pos_payments in the ERP's own
// database. This read is how the office sees those bills per event — grouped
// by receipt, filterable, with the totals the project's Total Sales is set
// from.
//
//   GET /api/project-pos-sales/:projectId?date=&terminal=&cashier=&method=&status=
//     { project: { id, name, event_type_slug }, pos_enabled,
//       data: [...receipts], totals, options: { terminals, cashiers, methods } }
//
// GATE. index.ts puts `requirePageAccessOrSalesView("sales")` in front of this
// prefix — the SAME read gate as the project's Sales section — so the people
// who see the section see its POS half. No row scope: a booth bill belongs to
// the event, not to the person reading it.
//
// COMPANY SCOPE. The project is resolved under the caller's active company and
// pos_sales carries its own company_id, so both reads carry the predicate.
//
// Its own prefix, not /api/projects: routes/projects.ts is at its size ceiling.
// Drizzle throughout (getDb); the grouping and totals are pure in
// routes/lib/pos-sales-list.ts and tested there.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { pos_sales, pos_sale_lines, pos_payments } from "../db/schema";
import { activeCompanyId } from "../scm/lib/companyScope";
import {
  filterPosReceipts,
  groupPosReceipts,
  parsePosSalesFilter,
  posSalesTotals,
  type PosPaymentRow,
  type PosSaleHeader,
  type PosSaleLineRow,
} from "./lib/pos-sales-list";

type Vars = { user?: { id: number }; companyId?: number; access_level?: string };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;
type Db = ReturnType<typeof getDb>;

/** The project type whose page carries POS Sales instead of Sales Orders. */
export const CASH_CARRY_SLUG = "cash_carry";

type ProjectHead = { id: number; name: string; event_type_slug: string | null };

/** The project under the caller's company, with its event type's slug (the
 *  shared project_event_types master is not in the Drizzle schema). Degrades
 *  to no company predicate when the company is unresolved, like every read. */
async function loadProject(db: Db, projectId: number, companyId: number | undefined): Promise<ProjectHead | null> {
  const companyPred = companyId != null ? sql` AND p.company_id = ${companyId}` : sql``;
  const rows = await db.execute<{ id: number | string; name: string; event_type_slug: string | null }>(sql`
    SELECT p.id, p.name, et.slug AS event_type_slug
      FROM projects p
      LEFT JOIN project_event_types et ON et.id = p.event_type_id
     WHERE p.id = ${projectId}${companyPred}
     LIMIT 1`);
  const r = rows[0];
  return r ? { id: Number(r.id), name: r.name, event_type_slug: r.event_type_slug ?? null } : null;
}

async function loadReceipts(db: Db, projectId: number, companyId: number | undefined) {
  const where = companyId != null
    ? and(eq(pos_sales.project_id, projectId), eq(pos_sales.company_id, companyId), eq(pos_sales.is_test, false))
    : and(eq(pos_sales.project_id, projectId), eq(pos_sales.is_test, false));
  const headers = (await db
    .select({
      id: pos_sales.id,
      uuid: pos_sales.uuid,
      receipt_no: pos_sales.receipt_no,
      type: pos_sales.type,
      ref_sale_uuid: pos_sales.ref_sale_uuid,
      terminal_code: pos_sales.terminal_code,
      cashier_id: pos_sales.cashier_id,
      cashier_name: pos_sales.cashier_name,
      salesman_id: pos_sales.salesman_id,
      salesman_name: pos_sales.salesman_name,
      customer_name: pos_sales.customer_name,
      customer_phone: pos_sales.customer_phone,
      sold_at: pos_sales.sold_at,
      subtotal_sen: pos_sales.subtotal_sen,
      item_discount_sen: pos_sales.item_discount_sen,
      bill_discount_sen: pos_sales.bill_discount_sen,
      sst_applied: pos_sales.sst_applied,
      sst_rate: pos_sales.sst_rate,
      sst_amount_sen: pos_sales.sst_amount_sen,
      rounding_sen: pos_sales.rounding_sen,
      total_sen: pos_sales.total_sen,
      status: pos_sales.status,
      void_reason: pos_sales.void_reason,
      void_by: pos_sales.void_by,
      voided_at: pos_sales.voided_at,
      source: pos_sales.source,
      synced_at: pos_sales.synced_at,
    })
    .from(pos_sales)
    .where(where)
    .orderBy(desc(pos_sales.sold_at), desc(pos_sales.receipt_no))) as PosSaleHeader[];
  if (headers.length === 0) return groupPosReceipts([], [], []);
  const ids = headers.map((h) => h.id);
  const [lines, payments] = await Promise.all([
    db
      .select({
        sale_id: pos_sale_lines.sale_id,
        line_no: pos_sale_lines.line_no,
        item_code: pos_sale_lines.item_code,
        description: pos_sale_lines.description,
        uom: pos_sale_lines.uom,
        qty: pos_sale_lines.qty,
        unit_price_sen: pos_sale_lines.unit_price_sen,
        original_price_sen: pos_sale_lines.original_price_sen,
        override_by: pos_sale_lines.override_by,
        override_reason: pos_sale_lines.override_reason,
        discount_source: pos_sale_lines.discount_source,
        discount_type: pos_sale_lines.discount_type,
        discount_value: pos_sale_lines.discount_value,
        discount_amount_sen: pos_sale_lines.discount_amount_sen,
        is_foc: pos_sale_lines.is_foc,
        amount_sen: pos_sale_lines.amount_sen,
      })
      .from(pos_sale_lines)
      .where(inArray(pos_sale_lines.sale_id, ids)) as Promise<PosSaleLineRow[]>,
    db
      .select({
        sale_id: pos_payments.sale_id,
        method: pos_payments.method,
        amount_sen: pos_payments.amount_sen,
        reference: pos_payments.reference,
      })
      .from(pos_payments)
      .where(inArray(pos_payments.sale_id, ids)) as Promise<PosPaymentRow[]>,
  ]);
  return groupPosReceipts(headers, lines, payments);
}

export async function projectPosSalesHandler(c: Ctx): Promise<Response> {
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isInteger(projectId) || projectId <= 0) return c.json({ error: "invalid_project_id" }, 400);
  const db = getDb(c.env);
  const companyId = activeCompanyId(c);
  const project = await loadProject(db, projectId, companyId);
  /* 404 for a foreign project too: confirming it exists is itself a leak. */
  if (!project) return c.json({ error: "Not found" }, 404);
  try {
    const all = await loadReceipts(db, project.id, companyId);
    const filter = parsePosSalesFilter(c.req.query());
    const data = filterPosReceipts(all, filter);
    const cashiers = new Map<number, string>();
    const terminals = new Set<string>();
    const methods = new Set<string>();
    for (const r of all) {
      terminals.add(r.terminal_code);
      if (r.cashier_id != null) cashiers.set(r.cashier_id, r.cashier_name ?? `#${r.cashier_id}`);
      for (const m of r.methods) methods.add(m);
    }
    return c.json({
      project,
      pos_enabled: project.event_type_slug === CASH_CARRY_SLUG,
      data,
      totals: posSalesTotals(data),
      all_count: all.length,
      filter,
      options: {
        terminals: Array.from(terminals).sort(),
        cashiers: Array.from(cashiers, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
        methods: Array.from(methods).sort(),
      },
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export const projectPosSales = new Hono<{ Bindings: Env; Variables: Vars }>();
projectPosSales.get("/:projectId", projectPosSalesHandler);
