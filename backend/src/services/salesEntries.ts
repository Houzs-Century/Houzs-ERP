import type { Env } from "../types";

/**
 * Mint the next `SO-NNNNNN` doc number for a sales_entries row.
 *
 * Format: 6-digit zero-padded, scanned against all-time max so re-runs
 * are idempotent and gaps from deletes don't get reused. Mirrors the
 * `nextProjectCode` pattern in services/projects.ts but flat (no year
 * scoping — the boss's reference app uses a flat counter).
 */
export async function nextSalesEntryDocNo(env: Env): Promise<string> {
  const prefix = "SO-";
  const row = await env.DB.prepare(
    `SELECT doc_no FROM sales_entries
      WHERE doc_no LIKE ?
      ORDER BY doc_no DESC LIMIT 1`
  )
    .bind(`${prefix}%`)
    .first<{ doc_no: string }>();
  let next = 1;
  if (row?.doc_no) {
    const tail = row.doc_no.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `${prefix}${String(next).padStart(6, "0")}`;
}

// ── Items ─────────────────────────────────────────────────────

export interface SalesItemInput {
  line_no?: number;
  item_code?: string | null;
  item_description?: string | null;
  remarks?: string | null;
  qty?: number;
  unit_price?: number;
  amount?: number;
  group_tag?: string | null;
}

/** Replace-all semantics: delete every existing item for the entry,
 *  then insert the supplied list. Used by both POST and PATCH so the
 *  client posts a complete list each time (no per-line diffing).
 *
 *  Multi-company (Phase 0b): `companyId` stamps sales_entry_items.company_id
 *  (NOT NULL after migration 0061). It's the parent sales_entry's active
 *  company, threaded down from the route handler via activeCompanyId(c). When
 *  undefined (companies master not resolvable — pre-migration / DB cold-start)
 *  the column is OMITTED so the insert keeps working single-company. */
export async function replaceItems(
  env: Env,
  entryId: number,
  items: SalesItemInput[],
  companyId?: number,
): Promise<void> {
  await env.DB.prepare(`DELETE FROM sales_entry_items WHERE entry_id = ?`)
    .bind(entryId)
    .run();
  if (!items.length) return;
  const stampCo = companyId != null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const qty = Number(it.qty ?? 1);
    const unitPrice = Number(it.unit_price ?? 0);
    const amount = Number(
      it.amount != null && Number.isFinite(Number(it.amount))
        ? Number(it.amount)
        : qty * unitPrice,
    );
    await env.DB.prepare(
      `INSERT INTO sales_entry_items
         (entry_id, line_no, item_code, item_description, remarks,
          qty, unit_price, amount, group_tag${stampCo ? ", company_id" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`
    )
      .bind(
        entryId,
        it.line_no ?? i + 1,
        it.item_code?.trim() || null,
        it.item_description?.trim() || null,
        it.remarks?.trim() || null,
        qty,
        unitPrice,
        amount,
        it.group_tag?.trim() || null,
        ...(stampCo ? [companyId] : []),
      )
      .run();
  }
}

// ── Payments ─────────────────────────────────────────────────

export interface SalesPaymentInput {
  paid_at: string;
  payment_method: string;
  amount: number;
  account_sheet?: string | null;
  approval_code?: string | null;
  collected_by?: string | null;
}

/** Replace-all payments for an entry. `companyId` (Phase 0b) stamps
 *  sales_entry_payments.company_id (NOT NULL after migration 0061) from the
 *  parent entry's active company; omitted when unresolved (see replaceItems). */
export async function replacePayments(
  env: Env,
  entryId: number,
  payments: SalesPaymentInput[],
  companyId?: number,
): Promise<void> {
  await env.DB.prepare(`DELETE FROM sales_entry_payments WHERE entry_id = ?`)
    .bind(entryId)
    .run();
  if (!payments.length) return;
  const stampCo = companyId != null;
  for (const p of payments) {
    await env.DB.prepare(
      `INSERT INTO sales_entry_payments
         (entry_id, paid_at, payment_method, amount,
          account_sheet, approval_code, collected_by${stampCo ? ", company_id" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`
    )
      .bind(
        entryId,
        p.paid_at,
        p.payment_method,
        Number(p.amount),
        p.account_sheet?.trim() || null,
        p.approval_code?.trim() || null,
        p.collected_by?.trim() || null,
        ...(stampCo ? [companyId] : []),
      )
      .run();
  }
}

/** Rolling helpers — used by POST/PATCH to keep the legacy single-deposit
 *  columns in sync with the payments table for backward compat with the
 *  list view that reads `deposit_amount` directly. */
export function summarisePayments(payments: SalesPaymentInput[]): {
  total: number;
  firstMethod: string | null;
} {
  if (!payments.length) return { total: 0, firstMethod: null };
  let total = 0;
  for (const p of payments) total += Number(p.amount) || 0;
  return { total, firstMethod: payments[0]?.payment_method ?? null };
}
