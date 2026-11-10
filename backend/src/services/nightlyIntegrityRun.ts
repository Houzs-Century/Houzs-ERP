// Nightly integrity check — the reads and the alert. Runs from the 00:05 MYT
// cron slot (index.ts, job "integrity-nightly"). The rules are in
// nightlyIntegrity.ts; the mismatch judgement is the shared core in
// scripts/lib/half-done-documents.mjs (also behind the on-demand audit).
//
// SELECTs only, every one names company_id. Activity window: the last two
// days — a GRN created or posted, a DO created or changed (it ships days after
// it is created, and the night it ships is the night to hear about it), a PO
// line created or received against, a rebank or a money document created.
// Logs carry counts per class only; the admin notice carries document numbers
// and item codes, never an amount.

import { sql, type SQL } from "drizzle-orm";
import type { Env } from "../types";
import type { DB } from "../db/client";
import { getDb } from "../db/client";
import { DO_STOCK_OUT_STATES } from "../scm/shared/do-shipped-states";
import {
  compareDocItems, cancelledResidue, comparePoReceived, strandedRebanks, duplicateClusters,
  DUPLICATE_WINDOW_SECONDS, type DocItemFinding, type DocRef, type DocLine, type DocMovement, type DupDoc,
} from "../../scripts/lib/half-done-documents.mjs";
import {
  integrityNotice, isCutoverPoLine, isNewFinding, logLine, newLotBucketFindings, nightlyCutoffMs,
  totalFindings, withoutNonStock, type ClassResult, type IntegrityClass, type NightlyLotRow,
} from "./nightlyIntegrity";
import { usersOnDeskFor } from "./permissionHolders";
import { postPersonalNotice } from "./personalNotice";

export const INTEGRITY_JOB = "integrity-nightly";
export const INTEGRITY_NOTICE_SOURCE = "integrity_check";
const EXAMPLES = 8;

const list = (xs: readonly string[]): SQL => sql`(${sql.join(xs.map((x) => sql`${x}`), sql`, `)})`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const docItem = (r: DocItemFinding) => `${r.docNo} ${r.itemCode}`;

async function nonStockCodes(db: DB, co: number): Promise<Set<string>> {
  const rows = await db.execute<{ code: string }>(sql`
    SELECT DISTINCT trim(code) AS code FROM scm.mfg_products
     WHERE company_id = ${co} AND category::text = 'SERVICE'`);
  return new Set(rows.map((r) => r.code));
}

async function grnInMissing(db: DB, co: number, cutoff: string, svc: Set<string>, cutoffMs: number) {
  const scope = sql`g.company_id = ${co} AND g.status::text IN ('POSTED', 'CLOSED')
    AND COALESCE(g.migrated_no_stock, false) = false AND GREATEST(g.created_at, g.posted_at) >= ${cutoff}::timestamptz`;
  const docs = await db.execute<DocRef & Record<string, unknown>>(sql`
    SELECT g.id::text AS "docId", g.grn_number AS "docNo", GREATEST(g.created_at, g.posted_at) AS "createdAt"
      FROM scm.grns g WHERE ${scope}`);
  const lines = await db.execute<DocLine & Record<string, unknown>>(sql`
    SELECT gi.grn_id::text AS "docId", gi.item_code AS "itemCode", gi.item_group AS "itemGroup", gi.qty_accepted AS qty
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id WHERE ${scope}`);
  const movs = await db.execute<DocMovement & Record<string, unknown>>(sql`
    SELECT m.source_doc_id::text AS "docId", m.item_code AS "itemCode",
           SUM(CASE WHEN m.movement_type = 'IN' THEN m.qty WHEN m.movement_type = 'OUT' THEN -m.qty ELSE 0 END)::int AS net
      FROM scm.inventory_movements m JOIN scm.grns g ON g.id = m.source_doc_id
     WHERE m.company_id = ${co} AND m.source_doc_type = 'GRN' AND ${scope}
     GROUP BY 1, 2`);
  const f = withoutNonStock([...lines], [...movs], svc);
  return compareDocItems([...docs], f.lines, f.movements).filter((r) => isNewFinding(r.createdAt, cutoffMs));
}

/* Net OUT of a DO, as the audit counts it: OUT minus its own IN corrections
   minus the ADJUSTMENT a cancel writes (fn_reverse_do_out). */
function doMovements(db: DB, co: number, statuses: readonly string[], cutoff: string) {
  return db.execute<DocMovement & Record<string, unknown>>(sql`
    SELECT m.source_doc_id::text AS "docId", m.item_code AS "itemCode",
           SUM(CASE WHEN m.source_doc_type = 'DO' AND m.movement_type = 'OUT' THEN m.qty
                    WHEN m.source_doc_type = 'DO' AND m.movement_type = 'IN' THEN -m.qty
                    WHEN m.source_doc_type = 'ADJUSTMENT' AND m.movement_type = 'ADJUSTMENT' THEN -m.qty
                    ELSE 0 END)::int AS net
      FROM scm.inventory_movements m JOIN scm.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.company_id = ${co} AND d.company_id = ${co} AND m.source_doc_type IN ('DO', 'ADJUSTMENT')
       AND d.status::text IN ${list(statuses)} AND COALESCE(d.migrated_no_stock, false) = false
       AND GREATEST(d.created_at, d.updated_at) >= ${cutoff}::timestamptz
     GROUP BY 1, 2`);
}

function doDocs(db: DB, co: number, statuses: readonly string[], cutoff: string) {
  return db.execute<DocRef & Record<string, unknown>>(sql`
    SELECT d.id::text AS "docId", d.do_number AS "docNo", GREATEST(d.created_at, d.updated_at) AS "createdAt"
      FROM scm.delivery_orders d
     WHERE d.company_id = ${co} AND d.status::text IN ${list(statuses)}
       AND COALESCE(d.migrated_no_stock, false) = false AND GREATEST(d.created_at, d.updated_at) >= ${cutoff}::timestamptz`);
}

async function doOutMissing(db: DB, co: number, cutoff: string, svc: Set<string>, cutoffMs: number) {
  const docs = await doDocs(db, co, DO_STOCK_OUT_STATES, cutoff);
  const lines = await db.execute<DocLine & Record<string, unknown>>(sql`
    SELECT i.delivery_order_id::text AS "docId", i.item_code AS "itemCode", i.item_group AS "itemGroup", i.qty
      FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
     WHERE d.company_id = ${co} AND d.status::text IN ${list(DO_STOCK_OUT_STATES)}
       AND COALESCE(d.migrated_no_stock, false) = false AND GREATEST(d.created_at, d.updated_at) >= ${cutoff}::timestamptz`);
  const movs = await doMovements(db, co, DO_STOCK_OUT_STATES, cutoff);
  const f = withoutNonStock([...lines], [...movs], svc);
  return compareDocItems([...docs], f.lines, f.movements).filter((r) => isNewFinding(r.createdAt, cutoffMs));
}

async function doCancelNotReversed(db: DB, co: number, cutoff: string, svc: Set<string>, cutoffMs: number) {
  const docs = await doDocs(db, co, ["CANCELLED"], cutoff);
  const movs = withoutNonStock([], [...(await doMovements(db, co, ["CANCELLED"], cutoff))], svc).movements;
  return cancelledResidue([...docs], movs).filter((r) => isNewFinding(r.createdAt, cutoffMs));
}

async function poReceivedMismatch(db: DB, co: number, cutoff: string, svc: Set<string>, cutoffMs: number) {
  /* A PO line is in tonight's scope when it was created, or received against,
     in the window; activityAt is the later of the two. */
  const poLines = await db.execute<{
    poItemId: string; docNo: string; lineNo: number | null; itemCode: string; itemGroup: string | null;
    receivedQty: number | string | null; createdAt: string; activityAt: string;
  }>(sql`
    WITH touched AS (
      SELECT gi.purchase_order_item_id AS id, MAX(gi.created_at) AS at
        FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
       WHERE g.company_id = ${co} AND gi.created_at >= ${cutoff}::timestamptz GROUP BY 1)
    SELECT pi.id::text AS "poItemId", po.po_number AS "docNo", pi.line_no AS "lineNo", pi.item_code AS "itemCode",
           pi.item_group AS "itemGroup", pi.received_qty AS "receivedQty", pi.created_at AS "createdAt",
           GREATEST(pi.created_at, t.at) AS "activityAt"
      FROM scm.purchase_order_items pi JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
      LEFT JOIN touched t ON t.id = pi.id
     WHERE po.company_id = ${co} AND (pi.created_at >= ${cutoff}::timestamptz OR t.id IS NOT NULL)`);
  const ids = poLines.map((p) => p.poItemId);
  const grnLines = ids.length === 0 ? [] : await db.execute<{
    poItemId: string; status: string; qty_accepted: number; returned_qty: number; returned_closed_qty: number;
  }>(sql`
    SELECT gi.purchase_order_item_id::text AS "poItemId", g.status::text AS status,
           gi.qty_accepted, gi.returned_qty, gi.returned_closed_qty
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE g.company_id = ${co} AND gi.purchase_order_item_id::text IN ${list(ids)}`);
  const kept = poLines.filter((p) => !isCutoverPoLine(p.createdAt)
    && withoutNonStock([{ itemCode: p.itemCode, itemGroup: p.itemGroup }], [], svc).lines.length === 1);
  return comparePoReceived(kept, [...grnLines]).filter((r) => isNewFinding(r.activityAt, cutoffMs));
}

async function rebankNoEntry(db: DB, co: number, cutoff: string, cutoffMs: number) {
  const rows = await db.execute<{
    jeNo: string; sourceType: string; paymentId: string; createdAt: string; paymentExists: boolean; liveEntries: number;
  }>(sql`
    SELECT r.je_no AS "jeNo", r.source_type AS "sourceType", r.source_doc_no AS "paymentId", r.created_at AS "createdAt",
           CASE WHEN r.source_type = 'SOPAY_REVERSAL'
                THEN EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments p WHERE p.company_id = ${co} AND p.id::text = r.source_doc_no)
                ELSE EXISTS (SELECT 1 FROM scm.sales_invoice_payments p WHERE p.company_id = ${co} AND p.id::text = r.source_doc_no)
           END AS "paymentExists",
           (SELECT COUNT(*) FROM scm.journal_entries l
             WHERE l.company_id = ${co} AND l.source_doc_no = r.source_doc_no
               AND l.source_type = replace(r.source_type, '_REVERSAL', '')
               AND l.posted = true AND COALESCE(l.reversed, false) = false)::int AS "liveEntries"
      FROM scm.journal_entries r
     WHERE r.company_id = ${co} AND r.source_type IN ('SOPAY_REVERSAL', 'SIPAY_REVERSAL')
       AND r.narration LIKE '% moved from % to %' AND r.created_at >= ${cutoff}::timestamptz`);
  return strandedRebanks([...rows]).filter((r) => isNewFinding(r.createdAt, cutoffMs));
}

async function lotsVsMovements(db: DB, co: number, cutoffMs: number, svc: Set<string>) {
  /* Whole ledger, then only buckets born in the window are kept (rules file). */
  const rows = await db.execute<NightlyLotRow & Record<string, unknown>>(sql`
    WITH mv AS (
      SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk,
             SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS net,
             MIN(created_at) AS first_at, MAX(created_at) AS last_at
        FROM scm.inventory_movements WHERE company_id = ${co} GROUP BY 1, 2, 3),
    lt AS (
      SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS open, MIN(created_at) AS first_at
        FROM scm.inventory_lots WHERE company_id = ${co} GROUP BY 1, 2, 3)
    SELECT COALESCE(mv.item_code, lt.item_code) AS "itemCode",
           COALESCE(w.code, w.name, LEFT(COALESCE(mv.warehouse_id, lt.warehouse_id)::text, 8)) AS warehouse,
           COALESCE(mv.vk, lt.vk) AS "variantKey",
           COALESCE(mv.net, 0) AS "movementNet", COALESCE(lt.open, 0) AS "lotOpen", mv.last_at AS "lastAt",
           LEAST(mv.first_at, lt.first_at) AS "firstAt",
           (SELECT max(p.category::text) FROM scm.mfg_products p
             WHERE p.company_id = ${co} AND p.code = COALESCE(mv.item_code, lt.item_code)) AS category
      FROM mv FULL JOIN lt ON lt.item_code = mv.item_code AND lt.warehouse_id = mv.warehouse_id AND lt.vk = mv.vk
      LEFT JOIN scm.warehouses w ON w.id = COALESCE(mv.warehouse_id, lt.warehouse_id) AND w.company_id = ${co}
     WHERE COALESCE(mv.net, 0) <> COALESCE(lt.open, 0)`);
  return newLotBucketFindings(co, [...rows], cutoffMs, svc);
}

/* Same sources and fingerprints as the audit's class 7. Amounts and names go
   INTO md5() inside Postgres and never come out. */
function dupSources(co: number, cutoff: string): Array<[string, SQL]> {
  const since = sql`${cutoff}::timestamptz`;
  return [
    ["credit notes", sql`
      SELECT n.note_number AS "docNo", n.status::text AS status, n.created_at AS "createdAt",
             md5(concat_ws('|', n.kind, n.party_type, n.party_code, n.party_name, n.supplier_id, n.so_doc_no, n.sales_invoice_id,
                   n.purchase_invoice_id, n.source_doc_no, n.note_date, n.total_sen, n.debtor_id,
                   (SELECT string_agg(concat_ws('~', l.description, l.account_code, l.amount_sen, l.qty), '^' ORDER BY l.line_no, l.description)
                      FROM scm.acc_credit_note_lines l WHERE l.note_id = n.id AND l.company_id = ${co}))) AS fingerprint
        FROM scm.acc_credit_notes n WHERE n.company_id = ${co} AND n.created_at >= ${since}`],
    ["supplier bills (PI)", sql`
      SELECT p.invoice_number AS "docNo", p.status::text AS status, p.created_at AS "createdAt",
             md5(concat_ws('|', p.supplier_id, p.supplier_invoice_ref, p.purchase_order_id, p.grn_id, p.invoice_date, p.total_sen,
                   (SELECT string_agg(concat_ws('~', i.item_code, i.grn_item_id, i.qty, i.unit_price_sen), '^' ORDER BY i.item_code, i.qty, i.grn_item_id)
                      FROM scm.purchase_invoice_items i WHERE i.purchase_invoice_id = p.id))) AS fingerprint
        FROM scm.purchase_invoices p WHERE p.company_id = ${co} AND p.created_at >= ${since}`],
    ["supplier bills (AP)", sql`
      SELECT a.invoice_number AS "docNo", a.status::text AS status, a.created_at AS "createdAt",
             md5(concat_ws('|', a.doc_kind, a.supplier_id, a.supplier_invoice_ref, a.invoice_date, a.total_sen,
                   (SELECT string_agg(concat_ws('~', l.description, l.debit_account_code, l.amount_sen), '^' ORDER BY l.line_no, l.description)
                      FROM scm.ap_invoice_lines l WHERE l.invoice_id = a.id AND l.company_id = ${co}))) AS fingerprint
        FROM scm.ap_invoices a WHERE a.company_id = ${co} AND a.created_at >= ${since}`],
    ["deposit invoices", sql`
      SELECT d.di_number AS "docNo", d.status::text AS status, d.created_at AS "createdAt",
             md5(concat_ws('|', d.payment_source, d.so_doc_no, d.party_code, d.invoice_date, d.amount_sen, d.method)) AS fingerprint
        FROM scm.acc_deposit_invoices d WHERE d.company_id = ${co} AND d.created_at >= ${since}`],
    ["general receipts", sql`
      SELECT r.receipt_number AS "docNo", r.status::text AS status, r.created_at AS "createdAt",
             md5(concat_ws('|', r.payer_name, r.receipt_date, r.bank_account_code, r.total_sen,
                   (SELECT string_agg(concat_ws('~', l.description, l.credit_account_code, l.amount_sen), '^' ORDER BY l.line_no, l.description)
                      FROM scm.acc_receipt_lines l WHERE l.receipt_id = r.id AND l.company_id = ${co}))) AS fingerprint
        FROM scm.acc_receipts r WHERE r.company_id = ${co} AND r.created_at >= ${since}`],
    ["other debtor receipts", sql`
      SELECT r.receipt_number AS "docNo", r.status::text AS status, r.created_at AS "createdAt",
             md5(concat_ws('|', r.debtor_id, r.receipt_date, r.bank_account_code, r.total_sen,
                   (SELECT string_agg(concat_ws('~', a.bill_id, a.amount_sen), '^' ORDER BY a.bill_id, a.amount_sen)
                      FROM scm.acc_debtor_receipt_allocations a WHERE a.receipt_id = r.id AND a.company_id = ${co}))) AS fingerprint
        FROM scm.acc_debtor_receipts r WHERE r.company_id = ${co} AND r.created_at >= ${since}`],
    ["sales order payments", sql`
      SELECT p.so_doc_no || ' pay ' || LEFT(p.id::text, 8) AS "docNo", p.method AS status, p.created_at AS "createdAt",
             md5(concat_ws('|', p.so_doc_no, p.paid_at, p.method, p.merchant_provider, p.approval_code, p.amount_sen,
                   p.converted_from_so_doc_no, p.converted_to_so_doc_no)) AS fingerprint
        FROM scm.mfg_sales_order_payments p
       WHERE p.company_id = ${co} AND p.created_at >= ${since} AND p.mirror_of_payment_id IS NULL`],
    ["sales invoice payments", sql`
      SELECT COALESCE(s.invoice_number, 'SI') || ' pay ' || LEFT(p.id::text, 8) AS "docNo", p.method AS status, p.created_at AS "createdAt",
             md5(concat_ws('|', p.sales_invoice_id, p.paid_at, p.method, p.merchant_provider, p.approval_code, p.amount_sen)) AS fingerprint
        FROM scm.sales_invoice_payments p
        LEFT JOIN scm.sales_invoices s ON s.id = p.sales_invoice_id AND s.company_id = ${co}
       WHERE p.company_id = ${co} AND p.created_at >= ${since}`],
  ];
}

async function doubleSubmits(db: DB, co: number, cutoff: string): Promise<string[]> {
  const out: string[] = [];
  const failed: string[] = [];
  for (const [label, q] of dupSources(co, cutoff)) {
    try {
      const docs = await db.execute<DupDoc & Record<string, unknown>>(q);
      for (const c of duplicateClusters([...docs], DUPLICATE_WINDOW_SECONDS)) out.push(`${label}: ${c.docNo}`);
    } catch (e) {
      failed.push(`${label}: ${errMsg(e)}`);
    }
  }
  if (failed.length) throw new Error(failed.join("; "));
  return out;
}

async function runClass(cls: IntegrityClass, read: () => Promise<string[]>): Promise<ClassResult> {
  try {
    const all = await read();
    return { cls, count: all.length, examples: all.slice(0, EXAMPLES), error: null };
  } catch (e) {
    return { cls, count: 0, examples: [], error: errMsg(e) };
  }
}

export async function checkCompany(db: DB, co: number, nowMs: number): Promise<ClassResult[]> {
  const cutoffMs = nightlyCutoffMs(nowMs);
  const cutoff = new Date(cutoffMs).toISOString();
  const svc = await nonStockCodes(db, co);
  return [
    await runClass("grn_in_missing", async () => (await grnInMissing(db, co, cutoff, svc, cutoffMs)).map(docItem)),
    await runClass("do_out_missing", async () => (await doOutMissing(db, co, cutoff, svc, cutoffMs)).map(docItem)),
    await runClass("do_cancel_not_reversed", async () => (await doCancelNotReversed(db, co, cutoff, svc, cutoffMs)).map(docItem)),
    await runClass("po_received_mismatch", async () =>
      (await poReceivedMismatch(db, co, cutoff, svc, cutoffMs)).map((r) => `${r.docNo} line ${r.lineNo ?? "-"} ${r.itemCode}`)),
    await runClass("rebank_no_entry", async () => (await rebankNoEntry(db, co, cutoff, cutoffMs)).map((r) => r.docNo)),
    await runClass("lots_vs_movements", async () => (await lotsVsMovements(db, co, cutoffMs, svc)).map((r) => r.docNo)),
    await runClass("double_submit", () => doubleSubmits(db, co, cutoff)),
  ];
}

export interface IntegrityRunSummary {
  companies: number;
  findings: number;
  failedClasses: number;
}

/** The nightly pass: every company, every class; one admin notice per company
 *  with new findings. Throws at the end when any class failed, so job_runs
 *  records the run as an error (and the job-failure alert picks it up). */
export async function runNightlyIntegrity(env: Env, nowMs: number): Promise<IntegrityRunSummary> {
  const db = getDb(env);
  const companies = await db.execute<{ id: number; name: string | null }>(
    sql`SELECT id, COALESCE(code, name, id::text) AS name FROM public.companies ORDER BY id`);
  const dateMyt = new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
  let findings = 0;
  const failures: string[] = [];
  for (const c of companies) {
    const co = Number(c.id);
    const results = await checkCompany(db, co, nowMs);
    console.log(`[cron ${INTEGRITY_JOB}] ${logLine(co, results)}`);
    findings += totalFindings(results);
    for (const r of results) if (r.error) failures.push(`company ${co} ${r.cls}: ${r.error}`);
    const notice = integrityNotice(c.name ?? String(co), dateMyt, results);
    if (notice) {
      try {
        const { userIds } = await usersOnDeskFor(env, "it.view", { companyId: co });
        await postPersonalNotice(env, { userIds, category: "WARNING", source: INTEGRITY_NOTICE_SOURCE, ...notice });
      } catch (e) {
        failures.push(`company ${co} notice: ${errMsg(e)}`);
      }
    }
  }
  if (failures.length) throw new Error(`${failures.length} check(s) failed: ${failures.join("; ").slice(0, 1500)}`);
  return { companies: companies.length, findings, failedClasses: failures.length };
}

