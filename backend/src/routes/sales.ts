import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { requirePageAccess, requirePageAccessOrSalesView } from "../middleware/auth";
import { getDb } from "../db/client";
import { sales_entries, users, projects } from "../db/schema";
import { and, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { syncFinanceRollup } from "../services/projects";
import {
  nextSalesEntryDocNo,
  replaceItems,
  replacePayments,
  summarisePayments,
  type SalesItemInput,
  type SalesPaymentInput,
} from "../services/salesEntries";
// Multi-company (Phase 0b): active-company resolver. sales_entries + its item /
// payment / activity / change-request children are a PER-COMPANY module (the
// top-bar switcher isolates the two companies' books), so list/detail SELECTs
// filter by the active company and every INSERT stamps it. companyContext runs
// on the whole /api/* surface (index.ts), so c.get('companyId') is available
// here; it's undefined only pre-migration / DB cold-start, and the scoping +
// stamping both no-op in that case so single-company Houzs is unchanged.
import { activeCompanyId } from "../scm/lib/companyScope";
// THE one name for this date, and the seam that folds the other spellings onto
// it. Imported rather than re-typed so this module moves with a future rename
// instead of quietly stopping matching — see the SO_FORM_TEXT_FIELDS note below.
import {
  canonicaliseSoHeaderChanges,
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_PAYLOAD_KEY,
} from "../scm/shared/so-processing-date";

/* The context the extracted handlers below receive. They are exported so the
   route tests can drive them directly; the shape is exactly what app.get/post
   would have passed to an inline handler — including the PATH literal, which is
   what keeps c.req.param("reqId") a plain string rather than string | undefined. */
type HandlerCtx<P extends string> = Context<{ Bindings: Env }, P>;
const app = new Hono<{ Bindings: Env }>();

const PAYMENT_TYPES = new Set(["cash", "card_cc", "card_db", "epp", "cheque", "online"]);

// Header columns added in mig 070 that the form posts and we just
// pass through to the row. Keeps validation focused on the few that
// have constraints (amounts / dates / payment-method enum) and lets
// the rest flow as TEXT.
//
// ─── `processing_date` HERE IS THE SAME CONCEPT, ON A DIFFERENT DOCUMENT ───
//
// THE OWNER RULED ON IT, 2026-08-18: *"全部我们只有一个 Processing Date"*. An
// earlier census recommended treating this module's date as a separate concept
// and that recommendation was OVERRULED. There is one Processing Date in this
// business and it means one thing — *"Processing Date 就代表这张单可以安排订货了"*:
// the date the document is RELEASED for purchasing to order goods. There is no
// production scheduling here ("我们都没有排产的"), so nothing about it is a
// factory date on either document.
//
// WHAT IS STILL DIFFERENT, and it is the ROW, not the concept. A `sales_entries`
// row is its OWN document: no SO row, no doc-flow parent, no DO/SI downstream,
// and none of the SCM Processing-Date MACHINERY reaches it — no deposit gate
// (`processing_date_unpaid`), no variant/KIV completeness gate, no elapsed-date
// lock (`so_locked_processing`), no `scm.so.remove_processing_date` permission,
// no stock allocation, no pair rule. So: same word, same meaning, same spelling
// — and still do NOT coalesce, join or migrate one table's column into the
// other's. Unifying the NAME is the owner's instruction; merging the ROWS is not.
//
// ─── THE RENAME TRAP, AND WHERE THIS PR STOPPED ────────────────────────────
//
// `applyEntryPatch` below builds its UPDATE as `SET ${k} = ?` for each `k` of
// FIELDS that is `in body` — and one of its two callers is the change-request
// APPROVAL path, which JSON.parses `body` out of
// `sales_entry_change_requests.payload`, a row written at REQUEST time and
// applied possibly days later. Those stored payloads are keyed by the column
// names as they were when the request was queued. Drop a key from this allowlist
// and every already-queued payload carrying it stops matching any FIELDS entry —
// the loop never emits a SET, the request approves, reports ok, and SILENTLY
// DROPS the field. There is no error path to catch it.
//
// So the unification is STAGED, and only the first stage has shipped:
//
//   STAGE 1 (SHIPPED 2026-08-18) — ACCEPT BOTH. `canonicaliseSalesEntryBody`
//     below folds the ERP-canonical camelCase `processingDate` onto this
//     module's stored `processing_date` on every road in: the create POST, the
//     direct PATCH, the change-request QUEUE (so newly parked payloads are
//     stored already-canonical) and the approve replay. Nothing was removed, so
//     no queued payload and no stale SPA can break. When a body carries BOTH
//     spellings the CANONICAL one wins — a body with both was written by newer
//     code (same rule as `canonicaliseSoHeaderChanges`, whose seam this reuses).
//
//   STAGE 2 (NOT SHIPPED) — retire `processing_date` as an INBOUND key, leaving
//     `processingDate` as the only spelling a client may send. PRECONDITION,
//     which is a question about production rows and cannot be answered from
//     source: no `sales_entry_change_requests` row in status 'pending' still
//     carries the old key. Measure it, do not assume it:
//
//       SELECT count(*) FROM sales_entry_change_requests
//        WHERE status = 'pending' AND json_extract(payload, '$.processing_date') IS NOT NULL;
//
//     and confirm no deployed client still sends it BEFORE reading that count,
//     because a stale client can queue a new one at any time. The COLUMN keeps
//     its name either way — it already spells the canonical word.
const SO_FORM_TEXT_FIELDS = [
  "doc_no",
  "processing_date",
  "delivery_date",
  "status_2",
  "customer_address_2",
  "customer_postcode",
  "customer_state",
  "customer_phone_2",
  "customer_email",
  "venue",
  "warehouse",
  "branding",
  "po_doc_no",
  "payment_status",
  "source",
  "remarks",
] as const;

/**
 * The inbound spellings this module accepts for the Processing Date, mapped onto
 * the one it STORES.
 *
 * Left: the ERP-canonical payload key every other surface sends. Right: this
 * module's column, which already spells the canonical word and is therefore what
 * everything folds onto. Both sides come from `scm/shared/so-processing-date`, so
 * a future rename moves this table with it rather than leaving it aliasing two
 * words the code no longer uses.
 *
 * Adding to this table is always safe; REMOVING from it is the staged half — read
 * the precondition on SO_FORM_TEXT_FIELDS above.
 */
export const SALES_ENTRY_KEY_ALIASES: Readonly<Record<string, string>> = {
  [SO_PROCESSING_DATE_PAYLOAD_KEY]: SO_PROCESSING_DATE_COLUMN,
};

/**
 * Fold a request / stored payload's key spellings onto the ones this module
 * writes. Returns a NEW object; every key with no alias passes through
 * untouched, so items / payments / custom / project_id are unaffected.
 *
 * Reuses the SCM seam verbatim (`canonicaliseSoHeaderChanges` takes its alias
 * map as a parameter for exactly this reason) so the two modules cannot drift
 * into two different answers for "the body carries both spellings" — the
 * canonical one wins, in both.
 *
 * Call it as EARLY as possible on each road in. Every `"key" in body` test
 * downstream — the FIELDS loop, the create loop, `summariseChange` — has to see
 * the same shape, or the field is accepted by one and dropped by the next.
 */
export const canonicaliseSalesEntryBody = (
  body: Record<string, any> | null | undefined,
): Record<string, any> => canonicaliseSoHeaderChanges(body, SALES_ENTRY_KEY_ALIASES) ?? {};

// Quick-log marker. Reps logging from a busy event capture only
// amount + ref_no; the customer_name column (NOT NULL on the
// schema) gets this sentinel so the row lands as a draft that
// can't be submitted until back-filled. Frontend / project ledger
// renderers swap it out for a friendlier "Quick log · {ref}" label.
export const QUICK_LOG_SENTINEL = "(quick log)";

/**
 * Roll the project's total_sales after a sales_entry mutation. No-op
 * for unscoped (walk-in) entries. Failures are swallowed — the rollup
 * is best-effort; a stale total is preferable to a 500 on the user's
 * "Save sale" click.
 */
async function bumpProjectFinance(env: Env, projectId: number | null | undefined) {
  if (!projectId) return;
  try {
    await syncFinanceRollup(env, projectId);
  } catch (e) {
    // Surface to Wrangler logs so a silently-failed rollup doesn't
    // hide a corrupt `project_finance.total_sales`. We still don't
    // re-throw — the rollup is best-effort and shouldn't 500 the
    // user's "Save sale" click.
    console.error("[bumpProjectFinance]", projectId, e);
  }
}

// Append-only edit history for a sales entry (mig 0015 sales_entry_activity).
// Best-effort — a logging failure must never break the user's save.
async function logSalesActivity(
  env: Env,
  entryId: number,
  userId: number | null | undefined,
  action: string,
  note: string | null = null,
  companyId?: number,
) {
  // Phase 0b: stamp company_id (NOT NULL after mig 0061) from the parent
  // entry's active company; omit the column when unresolved so single-company
  // Houzs keeps logging.
  const stampCo = companyId != null;
  try {
    await env.DB.prepare(
      `INSERT INTO sales_entry_activity (entry_id, user_id, action, note${stampCo ? ", company_id" : ""})
       VALUES (?, ?, ?, ?${stampCo ? ", ?" : ""})`,
    )
      .bind(entryId, userId ?? null, action, note, ...(stampCo ? [companyId] : []))
      .run();
  } catch (e) {
    console.error("[logSalesActivity]", entryId, action, e);
  }
}

// ── Scoping helper ───────────────────────────────────────────
// Reps (role.scope_to_pic=1) without sales.manage only see entries
// they created. Anyone with sales.manage, or any unscoped role, sees
// everything.
// Returns a single WHERE-fragment (no leading/trailing AND) that the
// caller stitches into the final clause via " AND ". Returning a leading
// AND here used to double up with the join — `WHERE x AND AND y`.
function buildOwnershipWhere(user: any, canManage: boolean) {
  if (canManage) return { sql: "", binds: [] as any[] };
  if (user?.scope_to_pic) {
    return { sql: "s.created_by = ?", binds: [user.id] };
  }
  return { sql: "", binds: [] as any[] };
}

// ── List ─────────────────────────────────────────────────────
// Read gate is ADDITIVE (owner 2026-07): the flat page-access matrix for
// "sales" OR a code-keyed Sales/director (position/department). A Sales
// Director's POSITION is never backfilled into the matrix, so the project
// page's Sales section used to render (page authorised by the org-position
// tier) and then 403 here. requirePageAccessOrSalesView admits them by code
// and sets access_level (director → full = sees every entry; sales staff →
// partial = own+downline via buildOwnershipWhere) without weakening any
// non-sales caller. WRITE routes below keep requirePageAccess("sales","full").
app.get("/entries", requirePageAccessOrSalesView("sales"), async (c) => {
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";
  const status = c.req.query("status") || "";
  const projectId = parseInt(c.req.query("project_id") || "", 10);
  const search = c.req.query("search") || "";
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const includeArchived = c.req.query("include_archived") === "1";
  // Quick-log filter — drives the dedicated "Quick Logs" tab on the
  // Sales page. Either narrow to *only* quick-logs (?quick_log=1) or
  // exclude them entirely (?quick_log=0) so the All view doesn't
  // double up against the dedicated tab.
  const quickLogParam = c.req.query("quick_log");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const companyId = activeCompanyId(c);
  const where: string[] = [];
  const binds: any[] = [];
  // Per-company isolation: only the active company's sales entries. No-op when
  // the active company is unresolved (pre-migration / cold-start).
  if (companyId != null) {
    where.push("s.company_id = ?");
    binds.push(companyId);
  }
  if (!includeArchived) where.push("s.archived_at IS NULL");
  if (status) {
    where.push("s.status = ?");
    binds.push(status);
  }
  if (!isNaN(projectId)) {
    where.push("s.project_id = ?");
    binds.push(projectId);
  }
  if (dateFrom) {
    // substr, not date(): keeps the comparison text-vs-text on Postgres.
    where.push("substr(s.occurred_at, 1, 10) >= substr(?, 1, 10)");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("substr(s.occurred_at, 1, 10) <= substr(?, 1, 10)");
    binds.push(dateTo);
  }
  if (search) {
    where.push(
      "(s.customer_name LIKE ? OR s.customer_phone LIKE ? OR s.ref_no LIKE ? OR s.notes LIKE ?)"
    );
    const like = `%${search}%`;
    binds.push(like, like, like, like);
  }
  if (quickLogParam === "1") {
    where.push("s.customer_name = ?");
    binds.push(QUICK_LOG_SENTINEL);
  } else if (quickLogParam === "0") {
    where.push("s.customer_name <> ?");
    binds.push(QUICK_LOG_SENTINEL);
  }

  const ownership = buildOwnershipWhere(user, canManage);
  if (ownership.sql) where.push(ownership.sql);
  const fullWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const fullBinds = [...binds, ...ownership.binds];

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM sales_entries s ${fullWhere}`
  )
    .bind(...fullBinds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT s.*,
            u.name as created_by_name,
            u.email as created_by_email,
            sp.id   as sales_person_id_resolved,
            sp.name as sales_person_name,
            sp.email as sales_person_email,
            p.code as project_code,
            p.name as project_name
       FROM sales_entries s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN users sp ON sp.id = COALESCE(s.sales_person_id, s.created_by)
       LEFT JOIN projects p ON p.id = s.project_id
       ${fullWhere}
       ORDER BY s.occurred_at DESC, s.id DESC
       LIMIT ? OFFSET ?`
  )
    .bind(...fullBinds, perPage, offset)
    .all();

  // Sum filtered totals for the header tiles.
  const totals = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(s.amount), 0) as total_amount,
            COUNT(*) as total_count,
            COUNT(CASE WHEN s.status = 'draft' THEN 1 END) as draft_count,
            COUNT(CASE WHEN s.status = 'submitted' THEN 1 END) as submitted_count,
            COUNT(CASE WHEN s.status = 'pushed' THEN 1 END) as pushed_count
       FROM sales_entries s
       ${fullWhere}`
  )
    .bind(...fullBinds)
    .first<any>();

  // Standalone count of quick-logs awaiting completion — not bound by
  // the current filters, so the tab badge shows the inbox-style total
  // even when the user is on a narrowed view.
  const quickLogTotal = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM sales_entries s
      WHERE s.archived_at IS NULL
        AND s.status = 'draft'
        AND s.customer_name = ?
        ${companyId != null ? "AND s.company_id = ?" : ""}
        ${ownership.sql ? `AND ${ownership.sql}` : ""}`
  )
    .bind(
      QUICK_LOG_SENTINEL,
      ...(companyId != null ? [companyId] : []),
      ...ownership.binds,
    )
    .first<{ count: number }>();

  return c.json({
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
    totals: {
      amount: totals?.total_amount ?? 0,
      count: totals?.total_count ?? 0,
      by_status: {
        draft: totals?.draft_count ?? 0,
        submitted: totals?.submitted_count ?? 0,
        pushed: totals?.pushed_count ?? 0,
      },
      quick_log_pending: quickLogTotal?.count ?? 0,
    },
  });
});

// ── CSV export ───────────────────────────────────────────────
// Returns a CSV with the columns the sales team uses for chasing up
// balances post-event: ref_no, date, customer, amount, deposit (with
// payment method), balance (derived = amount - deposit), sales person.
// Honours the same project_id / status / search / date filters as the
// list endpoint and the same row-ownership scoping (scoped reps only
// get their own entries unless they have sales.manage). Written in
// Drizzle per the new-code convention.
//
// MUST be declared before /entries/:id — Hono matches in order, so the
// :id route would otherwise eat /entries/export with id="export".
app.get("/entries/export", requirePageAccess("sales"), async (c) => {
  const user = c.get("user");
  const canManage =
    c.get("access_level") === "full";

  const projectIdQ = c.req.query("project_id");
  const projectId = projectIdQ ? parseInt(projectIdQ, 10) : NaN;
  const status = c.req.query("status") || "";
  const search = c.req.query("search") || "";
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const includeArchived = c.req.query("include_archived") === "1";

  const db = getDb(c.env);
  const sp = alias(users, "sp");

  const companyId = activeCompanyId(c);
  const conds: any[] = [];
  // Per-company isolation. company_id isn't in the Drizzle schema (added by the
  // raw-SQL migration 0061), so scope via a sql fragment on the table. No-op
  // when the active company is unresolved.
  if (companyId != null) conds.push(sql`${sales_entries}.company_id = ${companyId}`);
  if (!includeArchived) conds.push(isNull(sales_entries.archived_at));
  if (status) conds.push(eq(sales_entries.status, status));
  if (!isNaN(projectId)) conds.push(eq(sales_entries.project_id, projectId));
  if (dateFrom) conds.push(gte(sql`date(${sales_entries.occurred_at})`, sql`date(${dateFrom})`));
  if (dateTo) conds.push(lte(sql`date(${sales_entries.occurred_at})`, sql`date(${dateTo})`));
  if (search) {
    const likeStr = `%${search}%`;
    /* ILIKE, not LIKE — this export runs through Drizzle/postgres.js, which
       BYPASSES the d1-compat shim that silently upgrades LIKE to ILIKE for the
       sibling list endpoint (`/entries`, raw env.DB.prepare). With plain LIKE
       the two disagreed on case: a rep searched "acme", saw rows in the list,
       exported, and got a CSV missing every row stored as "ACME" — a filtered
       export that looks complete is worse than one that errors. */
    conds.push(
      or(
        ilike(sales_entries.customer_name, likeStr),
        ilike(sales_entries.customer_phone, likeStr),
        ilike(sales_entries.ref_no, likeStr),
        ilike(sales_entries.notes, likeStr)
      )!
    );
  }
  // Reps without sales.manage only export their own rows. Same rule as
  // the list endpoint's buildOwnershipWhere.
  if (!canManage && user?.scope_to_pic) {
    conds.push(eq(sales_entries.created_by, user.id));
  }

  const rows = await db
    .select({
      id: sales_entries.id,
      ref_no: sales_entries.ref_no,
      occurred_at: sales_entries.occurred_at,
      customer_name: sales_entries.customer_name,
      customer_phone: sales_entries.customer_phone,
      customer_address: sales_entries.customer_address,
      amount: sales_entries.amount,
      deposit_amount: sales_entries.deposit_amount,
      deposit_payment_type: sales_entries.deposit_payment_type,
      currency: sales_entries.currency,
      status: sales_entries.status,
      project_code: projects.code,
      project_name: projects.name,
      sales_person_name: sp.name,
      sales_person_email: sp.email,
      created_by_name: users.name,
      created_by_email: users.email,
    })
    .from(sales_entries)
    .leftJoin(users, eq(users.id, sales_entries.created_by))
    .leftJoin(sp, eq(sp.id, sql`COALESCE(${sales_entries.sales_person_id}, ${sales_entries.created_by})`))
    .leftJoin(projects, eq(projects.id, sales_entries.project_id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(sales_entries.occurred_at), desc(sales_entries.id));

  const PAYMENT_LABEL: Record<string, string> = {
    cash: "Cash",
    card_cc: "Credit Card",
    card_db: "Debit Card",
    epp: "EPP",
  };

  const header = [
    "Ref No",
    "Date",
    "Customer",
    "Phone",
    "Address",
    "Project",
    "Sales Amount",
    "Deposit",
    "Deposit Payment",
    "Balance",
    "Currency",
    "Status",
    "Sales Person",
  ];

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    const amount = r.amount ?? 0;
    const deposit = r.deposit_amount ?? amount;
    const balance = amount - deposit;
    const projectLabel = r.project_code
      ? `${r.project_code}${r.project_name ? ` ${r.project_name}` : ""}`
      : "";
    const salesPerson =
      r.sales_person_name ||
      r.sales_person_email ||
      r.created_by_name ||
      r.created_by_email ||
      "";
    lines.push(
      [
        r.ref_no ?? "",
        r.occurred_at ? r.occurred_at.slice(0, 10) : "",
        r.customer_name,
        r.customer_phone ?? "",
        r.customer_address ?? "",
        projectLabel,
        amount.toFixed(2),
        deposit.toFixed(2),
        r.deposit_payment_type ? PAYMENT_LABEL[r.deposit_payment_type] || r.deposit_payment_type : "",
        balance.toFixed(2),
        r.currency ?? "MYR",
        r.status ?? "",
        salesPerson,
      ]
        .map(escape)
        .join(",")
    );
  }

  // BOM so Excel opens UTF-8 cleanly.
  const csv = "﻿" + lines.join("\r\n") + "\r\n";
  const today = new Date().toISOString().slice(0, 10);
  const filename = !isNaN(projectId)
    ? `sales_project_${projectId}_${today}.csv`
    : `sales_${today}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// ── Change-request queue (edit approval) ─────────────────────
// Registered BEFORE "/entries/:id" so the literal segment wins over the param.
//
// GET   list requests (managers see all; a rep sees only their own)
// POST  /:reqId/approve   re-applies the parked payload, marks approved
// POST  /:reqId/reject    discards it with an optional note
app.get("/entries/change-requests", requirePageAccess("sales"), async (c) => {
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";
  const status = c.req.query("status") ?? "pending";
  const companyId = activeCompanyId(c);
  let sql = `SELECT cr.id, cr.entry_id, cr.payload, cr.summary, cr.status,
                    cr.requested_by, cr.decided_by, cr.decided_at, cr.decide_note,
                    cr.created_at, e.doc_no, e.customer_name, e.status AS entry_status,
                    ru.name AS requested_by_name, du.name AS decided_by_name
               FROM sales_entry_change_requests cr
               JOIN sales_entries e ON e.id = cr.entry_id
          LEFT JOIN users ru ON ru.id = cr.requested_by
          LEFT JOIN users du ON du.id = cr.decided_by
              WHERE cr.status = ?`;
  const binds: any[] = [status];
  // Per-company isolation. No-op when the active company is unresolved.
  if (companyId != null) {
    sql += ` AND cr.company_id = ?`;
    binds.push(companyId);
  }
  if (!canManage) {
    sql += ` AND cr.requested_by = ?`;
    binds.push(user?.id ?? 0);
  }
  sql += ` ORDER BY cr.created_at DESC LIMIT 200`;
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ requests: rows.results ?? [] });
});

export const approveChangeRequestHandler = async (c: HandlerCtx<"/entries/change-requests/:reqId/approve">) => {
  const reqId = parseInt(c.req.param("reqId"), 10);
  if (!reqId) return c.json({ error: "Invalid ID." }, 400);
  const user = c.get("user");
  const companyId = activeCompanyId(c);
  const note = await c.req.json<{ note?: string }>().then((b) => b?.note ?? null).catch(() => null);

  /* Both loads carry the SAME company predicate that PATCH /entries/:id already
     applies, because they feed the SAME applyEntryPatch UPDATE. That UPDATE is
     blind by id and is safe only because its caller proved the row is in scope
     first — which the PATCH did and this approve did not. The fix is to match
     the scoped caller, NOT to add a second predicate inside applyEntryPatch:
     the PATCH would then filter twice, and the two could drift apart.
     The `!= null` degrade is deliberately copied verbatim from the PATCH — a
     single-company deployment with an unresolved company must keep approving
     its own change requests, and diverging here would refuse them. */
  const cr = await c.env.DB.prepare(
    `SELECT id, entry_id, payload, status, requested_by FROM sales_entry_change_requests
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`,
  )
    .bind(reqId, ...(companyId != null ? [companyId] : []))
    .first<{ id: number; entry_id: number; payload: string; status: string; requested_by: number | null }>();
  if (!cr) return c.json({ error: "Not found" }, 404);
  if (cr.status !== "pending") {
    return c.json({ error: `This request was already ${cr.status}` }, 409);
  }

  const entry = await c.env.DB.prepare(
    `SELECT id, project_id FROM sales_entries
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`,
  )
    .bind(cr.entry_id, ...(companyId != null ? [companyId] : []))
    .first<{ id: number; project_id: number | null }>();
  if (!entry) return c.json({ error: "The entry no longer exists" }, 404);

  let body: Record<string, any>;
  try {
    body = JSON.parse(cr.payload);
  } catch {
    return c.json({ error: "Stored change payload is corrupt" }, 500);
  }
  // Re-validate against the CURRENT row (amounts may have moved since queued).
  const invalid = await validateEntryPatch(c.env, entry.id, body);
  if (invalid) return c.json({ error: `Can't apply: ${invalid.error}` }, invalid.status as 400);

  // Attribute the edit to the original requester; record the approver here.
  await applyEntryPatch(c.env, entry.id, body, cr.requested_by ?? user?.id, entry.project_id, companyId);
  await c.env.DB.prepare(
    `UPDATE sales_entry_change_requests
        SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decide_note = ?
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`,
  )
    .bind(user?.id ?? null, note, reqId, ...(companyId != null ? [companyId] : []))
    .run();
  await logSalesActivity(c.env, entry.id, user?.id, "change_approved", note, companyId);
  return c.json({ ok: true });
};
app.post("/entries/change-requests/:reqId/approve", requirePageAccess("sales", "full"), approveChangeRequestHandler);

export const rejectChangeRequestHandler = async (c: HandlerCtx<"/entries/change-requests/:reqId/reject">) => {
  const reqId = parseInt(c.req.param("reqId"), 10);
  if (!reqId) return c.json({ error: "Invalid ID." }, 400);
  const user = c.get("user");
  const companyId = activeCompanyId(c);
  const note = await c.req.json<{ note?: string }>().then((b) => b?.note ?? null).catch(() => null);

  /* Same predicate as the approve twin above. Rejecting is still a cross-company
     WRITE — it terminates the other company's queued edit — so it gets the same
     boundary even though it never touches sales_entries. */
  const cr = await c.env.DB.prepare(
    `SELECT id, entry_id, status FROM sales_entry_change_requests
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`,
  )
    .bind(reqId, ...(companyId != null ? [companyId] : []))
    .first<{ id: number; entry_id: number; status: string }>();
  if (!cr) return c.json({ error: "Not found" }, 404);
  if (cr.status !== "pending") {
    return c.json({ error: `This request was already ${cr.status}` }, 409);
  }
  await c.env.DB.prepare(
    `UPDATE sales_entry_change_requests
        SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decide_note = ?
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`,
  )
    .bind(user?.id ?? null, note, reqId, ...(companyId != null ? [companyId] : []))
    .run();
  await logSalesActivity(c.env, cr.entry_id, user?.id, "change_rejected", note, companyId);
  return c.json({ ok: true });
};
app.post("/entries/change-requests/:reqId/reject", requirePageAccess("sales", "full"), rejectChangeRequestHandler);

// ── Detail ───────────────────────────────────────────────────
app.get("/entries/:id", requirePageAccess("sales"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";
  const companyId = activeCompanyId(c);

  const row = await c.env.DB.prepare(
    `SELECT s.*,
            u.name as created_by_name,
            u.email as created_by_email,
            sp.id   as sales_person_id_resolved,
            sp.name as sales_person_name,
            sp.email as sales_person_email,
            p.code as project_code,
            p.name as project_name
       FROM sales_entries s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN users sp ON sp.id = COALESCE(s.sales_person_id, s.created_by)
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?${companyId != null ? " AND s.company_id = ?" : ""}`
  )
    .bind(id, ...(companyId != null ? [companyId] : []))
    .first<any>();
  if (!row) return c.json({ error: "Not found" }, 404);

  // Scoped rep can only see own entries.
  if (!canManage && user?.scope_to_pic && row.created_by !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }

  // Fetch UDF values. The UDF layer expects row_key as TEXT so cast id.
  const udf = await c.env.DB.prepare(
    `SELECT field_key, value FROM udf_values
      WHERE table_name = 'sales_entries' AND row_key = ?`
  )
    .bind(String(id))
    .all<{ field_key: string; value: string | null }>();

  const custom: Record<string, string | null> = {};
  for (const r of udf.results ?? []) custom[r.field_key] = r.value;

  // Mig 070 — items + payments
  const itemsRes = await c.env.DB.prepare(
    `SELECT id, entry_id, line_no, item_code, item_description, remarks,
            qty, unit_price, amount, group_tag
       FROM sales_entry_items
      WHERE entry_id = ?
      ORDER BY line_no, id`
  )
    .bind(id)
    .all();
  const paymentsRes = await c.env.DB.prepare(
    `SELECT id, entry_id, paid_at, payment_method, amount,
            account_sheet, approval_code, collected_by
       FROM sales_entry_payments
      WHERE entry_id = ?
      ORDER BY paid_at, id`
  )
    .bind(id)
    .all();

  // Full edit history — who touched the entry and when (sales_entry_activity).
  const activityRes = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.note, a.created_at, u.name as user_name
       FROM sales_entry_activity a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entry_id = ?
      ORDER BY a.created_at, a.id`
  )
    .bind(id)
    .all();

  return c.json({
    entry: row,
    custom,
    items: itemsRes.results ?? [],
    payments: paymentsRes.results ?? [],
    activity: activityRes.results ?? [],
  });
});

// ── Create ───────────────────────────────────────────────────
app.post("/entries", requirePageAccess("sales"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    project_id?: number | null;
    ref_no?: string | null;
    customer_name?: string;
    customer_code?: string | null;
    customer_address?: string | null;
    customer_phone?: string | null;
    amount?: number;
    deposit_amount?: number | null;
    deposit_payment_type?: string | null;
    sales_person_id?: number | null;
    currency?: string;
    occurred_at?: string;
    notes?: string | null;
    custom?: Record<string, any>;
    // Mig 070 form fields — header text columns + line items + payments.
    items?: SalesItemInput[];
    payments?: SalesPaymentInput[];
    [k: string]: any;
    // Quick-log path — rep is on the floor and only has amount + ref_no.
    // The row lands as a draft tagged with the QUICK_LOG_SENTINEL in
    // customer_name. The /submit endpoint blocks the rep from
    // promoting this to 'submitted' until they back-fill a real name.
    quick_log?: boolean;
  }>();

  const customerNameInput = (body.customer_name || "").trim();
  const isQuickLog = body.quick_log === true || !customerNameInput;
  const customerName = isQuickLog ? QUICK_LOG_SENTINEL : customerNameInput;
  const amount = Number(body.amount);
  if (!isFinite(amount)) return c.json({ error: "amount must be a number" }, 400);
  const occurredAt = (body.occurred_at || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(occurredAt)) {
    return c.json({ error: "occurred_at must be a yyyy-mm-dd date" }, 400);
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const payments = Array.isArray(body.payments) ? body.payments : [];

  // Validate payment dates / methods up front so we don't insert the
  // header and orphan a bad payment.
  for (const p of payments) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(p.paid_at || ""))) {
      return c.json({ error: "payments[].paid_at must be yyyy-mm-dd" }, 400);
    }
    if (!p.payment_method || typeof p.payment_method !== "string") {
      return c.json({ error: "payments[].payment_method is required" }, 400);
    }
    const a = Number(p.amount);
    if (!isFinite(a) || a < 0) {
      return c.json({ error: "payments[].amount must be a non-negative number" }, 400);
    }
  }

  // Deposit derives from payments when supplied; otherwise honour the
  // legacy single-deposit body fields (quick-log + old client paths).
  const paySummary = summarisePayments(payments);
  let depositAmount: number | null = null;
  let paymentType: string | null = null;
  if (payments.length > 0) {
    depositAmount = paySummary.total;
    paymentType = paySummary.firstMethod;
  } else if (body.deposit_amount === null) {
    depositAmount = null;
    paymentType = body.deposit_payment_type?.trim() || null;
  } else if (body.deposit_amount === undefined) {
    depositAmount = amount;
    paymentType = body.deposit_payment_type?.trim() || null;
  } else {
    const d = Number(body.deposit_amount);
    if (!isFinite(d) || d < 0) {
      return c.json({ error: "deposit_amount must be a non-negative number" }, 400);
    }
    if (d > amount) {
      return c.json({ error: "deposit_amount cannot exceed amount" }, 400);
    }
    depositAmount = d;
    paymentType = body.deposit_payment_type?.trim() || null;
  }

  if (paymentType && !PAYMENT_TYPES.has(paymentType)) {
    return c.json(
      { error: "deposit_payment_type must be one of cash, card_cc, card_db, epp, cheque, online" },
      400
    );
  }

  // Mint doc_no if the client didn't supply one.
  const docNo = (body.doc_no?.trim() as string | undefined) || (await nextSalesEntryDocNo(c.env));

  // Build the dynamic insert. Static columns first, then the new
  // mig-070 text fields driven by SO_FORM_TEXT_FIELDS minus doc_no
  // (which we already minted above).
  const cols: string[] = [
    "doc_no",
    "project_id", "ref_no", "customer_name", "customer_code",
    "customer_address", "customer_phone", "amount",
    "deposit_amount", "deposit_payment_type",
    "currency", "occurred_at", "notes", "created_by", "sales_person_id",
  ];
  const vals: any[] = [
    docNo,
    body.project_id ?? null,
    body.ref_no?.trim() || null,
    customerName,
    body.customer_code?.trim() || null,
    body.customer_address?.trim() || null,
    body.customer_phone?.trim() || null,
    amount,
    depositAmount,
    paymentType,
    body.currency?.trim() || "MYR",
    occurredAt,
    body.notes?.trim() || null,
    user?.id ?? 0,
    body.sales_person_id ?? user?.id ?? null,
  ];
  /* Same fold as the PATCH path: a create that sends the ERP-canonical
     `processingDate` must land in the same column as one sending
     `processing_date`, or the two roads in disagree about a field the operator
     filled on the same form. */
  const canonBody = canonicaliseSalesEntryBody(body);
  for (const k of SO_FORM_TEXT_FIELDS) {
    if (k === "doc_no") continue;
    cols.push(k);
    const v = canonBody[k];
    vals.push(typeof v === "string" ? v.trim() || null : v ?? null);
  }

  // Phase 0b: stamp the active company (sales_entries.company_id NOT NULL after
  // mig 0061). Omitted when unresolved (pre-migration / cold-start) so the
  // single-company insert keeps working.
  const companyId = activeCompanyId(c);
  if (companyId != null) {
    cols.push("company_id");
    vals.push(companyId);
  }

  const placeholders = cols.map(() => "?").join(", ");
  const r = await c.env.DB.prepare(
    `INSERT INTO sales_entries (${cols.join(", ")}) VALUES (${placeholders})`
  )
    .bind(...vals)
    .run();

  const id = r.meta.last_row_id as number;

  if (items.length) await replaceItems(c.env, id, items, companyId ?? null);
  if (payments.length) await replacePayments(c.env, id, payments, companyId ?? null);

  // Persist custom field values via the existing UDF store. Silent-drop
  // anything with an unknown key so a renamed field doesn't 500 the
  // create — the matching GET will just omit it.
  if (body.custom) {
    await writeCustomFields(c.env, id, body.custom);
  }

  await bumpProjectFinance(c.env, body.project_id ?? null);

  await logSalesActivity(c.env, id, user?.id, "created", null, companyId);

  return c.json({ id, doc_no: docNo }, 201);
});

// ── Patch ────────────────────────────────────────────────────
app.patch("/entries/:id", requirePageAccess("sales"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";
  const companyId = activeCompanyId(c);

  const current = await c.env.DB.prepare(
    `SELECT id, created_by, status, project_id FROM sales_entries
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`
  )
    .bind(id, ...(companyId != null ? [companyId] : []))
    .first<{ id: number; created_by: number; status: string; project_id: number | null }>();
  if (!current) return c.json({ error: "Not found" }, 404);

  const isOwner = current.created_by === user?.id;
  if (!canManage && !isOwner) {
    return c.json({ error: "You can only edit your own entries" }, 403);
  }

  const body = await c.req.json<Record<string, any>>();

  // Cheap field validation up front so the rep gets the same immediate
  // feedback whether the edit applies now or goes to the approval queue.
  const invalid = await validateEntryPatch(c.env, id, body);
  if (invalid) return c.json({ error: invalid.error }, invalid.status as 400);

  // Approval queue (Part B) — a non-manager editing their OWN entry once it
  // has LEFT draft does not mutate it: the proposed change is parked as a
  // pending request for a Sales Director to approve (re-apply) or reject.
  // Managers (sales=full) and edits to a still-draft entry apply immediately.
  if (!canManage && current.status !== "draft") {
    const requestId = await queueEntryChange(c.env, id, body, user?.id, companyId);
    await logSalesActivity(c.env, id, user?.id, "change_requested", null, companyId);
    return c.json({ queued: true, request_id: requestId, status: current.status }, 202);
  }

  await applyEntryPatch(c.env, id, body, user?.id, current.project_id, companyId);
  return c.json({ ok: true });
});

// ── Sales-entry edit helpers (shared by PATCH + the approval queue) ──────

/** Cheap field validation for a sales-entry PATCH body. Returns an error
 *  descriptor (mapped to a 400 by the caller) or null when the patch is OK. */
async function validateEntryPatch(
  env: Env,
  id: number,
  body: Record<string, any>,
): Promise<{ error: string; status: number } | null> {
  if ("deposit_payment_type" in body && body.deposit_payment_type) {
    if (!PAYMENT_TYPES.has(String(body.deposit_payment_type))) {
      return { error: "deposit_payment_type must be one of cash, card_cc, card_db, epp", status: 400 };
    }
  }
  // deposit ≤ amount — fall back to the stored amount when only one moves.
  if ("deposit_amount" in body && body.deposit_amount != null) {
    const d = Number(body.deposit_amount);
    if (!isFinite(d) || d < 0) {
      return { error: "deposit_amount must be a non-negative number", status: 400 };
    }
    const amt =
      "amount" in body && body.amount != null
        ? Number(body.amount)
        : await env.DB.prepare(`SELECT amount FROM sales_entries WHERE id = ?`)
            .bind(id)
            .first<{ amount: number }>()
            .then((r) => r?.amount ?? 0);
    if (d > amt) return { error: "deposit_amount cannot exceed amount", status: 400 };
  }
  if (Array.isArray(body.payments)) {
    for (const p of body.payments as SalesPaymentInput[]) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(p.paid_at || ""))) {
        return { error: "payments[].paid_at must be yyyy-mm-dd", status: 400 };
      }
      if (!p.payment_method) return { error: "payments[].payment_method is required", status: 400 };
      const a = Number(p.amount);
      if (!isFinite(a) || a < 0) {
        return { error: "payments[].amount must be a non-negative number", status: 400 };
      }
    }
  }
  return null;
}

/** Apply a (pre-validated) sales-entry PATCH body to the row — fields, items,
 *  payments, custom fields, project-finance rollup, activity log. Called by the
 *  direct PATCH path AND when a Director approves a queued change request. */
async function applyEntryPatch(
  env: Env,
  id: number,
  body: Record<string, any>,
  actorId: number | null | undefined,
  currentProjectId: number | null,
  companyId?: number,
): Promise<void> {
  /* STAGE 1 of the Processing-Date name unification (see SO_FORM_TEXT_FIELDS).
     BOTH callers pass through here — the direct PATCH and the change-request
     APPROVE, which replays a payload parked days ago — so folding the spellings
     once, here, is what makes a body from either era write the same column. */
  body = canonicaliseSalesEntryBody(body);
  const sets: string[] = [];
  const binds: any[] = [];
  const FIELDS = [
    "project_id",
    "ref_no",
    "customer_name",
    "customer_code",
    "customer_address",
    "customer_phone",
    "amount",
    "deposit_amount",
    "deposit_payment_type",
    "sales_person_id",
    "currency",
    "occurred_at",
    "notes",
    ...SO_FORM_TEXT_FIELDS,
  ] as const;
  for (const k of FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      const v = body[k];
      binds.push(typeof v === "string" ? v.trim() || null : v ?? null);
    }
  }

  // Items + payments — replace-all when arrays are supplied. Mirrors the
  // deposit_amount / deposit_payment_type so the legacy list view renders.
  if (Array.isArray(body.items)) {
    await replaceItems(env, id, body.items as SalesItemInput[], companyId ?? null);
  }
  if (Array.isArray(body.payments)) {
    const pays = body.payments as SalesPaymentInput[];
    await replacePayments(env, id, pays, companyId ?? null);
    const sum = summarisePayments(pays);
    if (!("deposit_amount" in body)) {
      sets.push("deposit_amount = ?");
      binds.push(sum.total);
    }
    if (!("deposit_payment_type" in body)) {
      sets.push("deposit_payment_type = ?");
      binds.push(sum.firstMethod);
    }
  }

  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    binds.push(id);
    await env.DB.prepare(`UPDATE sales_entries SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
  }

  if (body.custom) {
    await writeCustomFields(env, id, body.custom);
  }

  // Roll up the new project; if the patch re-targeted the entry, refresh the
  // old one too so it stops double-counting the moved row.
  const nextProjectId = "project_id" in body ? (body.project_id ?? null) : currentProjectId;
  await bumpProjectFinance(env, nextProjectId);
  if (currentProjectId && currentProjectId !== nextProjectId) {
    await bumpProjectFinance(env, currentProjectId);
  }

  await logSalesActivity(env, id, actorId, "edited", null, companyId);
}

/** Short human-readable summary of which fields a change request touches. */
export function summariseChange(body: Record<string, any>): string {
  const parts: string[] = [];
  /* The summary is what the approver reads before pressing approve, so it must
     name the field the apply will actually write — not the spelling the client
     happened to send. */
  for (const k of Object.keys(canonicaliseSalesEntryBody(body))) {
    if (k === "custom") parts.push("custom fields");
    else if (k === "items" && Array.isArray(body.items)) parts.push(`items(${body.items.length})`);
    else if (k === "payments" && Array.isArray(body.payments)) parts.push(`payments(${body.payments.length})`);
    else parts.push(k);
  }
  return parts.slice(0, 12).join(", ");
}

/** Park a proposed PATCH body as a pending change request, superseding any
 *  earlier pending request for the same entry (only the latest edit matters). */
export async function queueEntryChange(
  env: Env,
  entryId: number,
  body: Record<string, any>,
  requestedBy: number | null | undefined,
  companyId?: number,
): Promise<number> {
  /* Canonicalise BEFORE the payload is frozen, so a request parked today is
     already keyed the way stage 2 will require. The approve path folds again on
     the way out, which is what covers the rows parked before this shipped —
     applying the fold twice is a no-op (an already-canonical key has no alias). */
  body = canonicaliseSalesEntryBody(body);
  await env.DB.prepare(
    `UPDATE sales_entry_change_requests
        SET status = 'superseded', decided_at = datetime('now')
      WHERE entry_id = ? AND status = 'pending'`,
  )
    .bind(entryId)
    .run();
  // Phase 0b: stamp company_id (NOT NULL after mig 0061); omit when unresolved.
  const stampCo = companyId != null;
  const res = await env.DB.prepare(
    `INSERT INTO sales_entry_change_requests (entry_id, payload, summary, requested_by${stampCo ? ", company_id" : ""})
     VALUES (?, ?, ?, ?${stampCo ? ", ?" : ""})`,
  )
    .bind(
      entryId,
      JSON.stringify(body),
      summariseChange(body),
      requestedBy ?? null,
      ...(stampCo ? [companyId] : []),
    )
    .run();
  return res.meta.last_row_id as number;
}

// ── Submit (lock as ready for push) ─────────────────────────
// Company scope (owner audit 2026-07-22): sibling PATCH/GET already scope by
// company_id (see line 496, 507 pattern) — the four state-transition writes
// (submit/unsubmit/void/DELETE) missed it, letting a caller in company A
// submit/void/delete B's entry by knowing its id. Now match the sibling
// pattern: SELECT + UPDATE both bounded by company_id when resolved.
app.post("/entries/:id/submit", requirePageAccess("sales"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";
  const companyId = activeCompanyId(c);

  const current = await c.env.DB.prepare(
    `SELECT id, created_by, status, customer_name FROM sales_entries
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`
  )
    .bind(...(companyId != null ? [id, companyId] : [id]))
    .first<{ id: number; created_by: number; status: string; customer_name: string }>();
  if (!current) return c.json({ error: "Not found" }, 404);
  if (!canManage && current.created_by !== user?.id) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  if (current.status !== "draft") {
    return c.json({ error: `Can't submit a ${current.status} entry` }, 400);
  }
  // Quick-log gate: a row sitting on the QUICK_LOG_SENTINEL hasn't
  // been back-filled with real customer details. Don't let it
  // promote to 'submitted' (and from there toward AutoCount push).
  if (current.customer_name === QUICK_LOG_SENTINEL) {
    return c.json(
      { error: "Fill customer details before submitting" },
      400,
    );
  }

  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'submitted', updated_at = datetime('now')
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`
  )
    .bind(...(companyId != null ? [id, companyId] : [id]))
    .run();
  await logSalesActivity(c.env, id, user?.id, "submitted", null, companyId);
  return c.json({ ok: true });
});

// ── Unsubmit (back to draft; managers only) ──────────────────
app.post("/entries/:id/unsubmit", requirePageAccess("sales", "full"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const user = c.get("user");
  const companyId = activeCompanyId(c);
  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'draft', updated_at = datetime('now')
      WHERE id = ? AND status = 'submitted'${companyId != null ? " AND company_id = ?" : ""}`
  )
    .bind(...(companyId != null ? [id, companyId] : [id]))
    .run();
  await logSalesActivity(c.env, id, user?.id, "unsubmitted", null, companyId);
  return c.json({ ok: true });
});

// ── Void ─────────────────────────────────────────────────────
app.post("/entries/:id/void", requirePageAccess("sales", "full"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const user = c.get("user");
  const companyId = activeCompanyId(c);
  const before = await c.env.DB.prepare(
    `SELECT project_id FROM sales_entries
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`
  )
    .bind(...(companyId != null ? [id, companyId] : [id]))
    .first<{ project_id: number | null }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  await c.env.DB.prepare(
    `UPDATE sales_entries SET status = 'void', updated_at = datetime('now')
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`
  )
    .bind(...(companyId != null ? [id, companyId] : [id]))
    .run();
  await bumpProjectFinance(c.env, before?.project_id ?? null);
  await logSalesActivity(c.env, id, user?.id, "voided", null, companyId);
  return c.json({ ok: true });
});

// ── Delete (soft) ────────────────────────────────────────────
app.delete("/entries/:id", requirePageAccess("sales"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const user = c.get("user");
  const canManage = c.get("access_level") === "full";
  const companyId = activeCompanyId(c);

  const row = await c.env.DB.prepare(
    `SELECT created_by, status, project_id FROM sales_entries
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`
  )
    .bind(...(companyId != null ? [id, companyId] : [id]))
    .first<{ created_by: number; status: string; project_id: number | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!canManage) {
    if (row.created_by !== user?.id) return c.json({ error: "You don't have permission to do that." }, 403);
    if (row.status !== "draft")
      return c.json({ error: "Only drafts can be deleted" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE sales_entries SET archived_at = datetime('now')
      WHERE id = ?${companyId != null ? " AND company_id = ?" : ""}`
  )
    .bind(...(companyId != null ? [id, companyId] : [id]))
    .run();
  await bumpProjectFinance(c.env, row.project_id);
  return c.json({ ok: true });
});

// ── Push to AutoCount ────────────────────────────────────────
// Placeholder — the actual push handler lives behind AutoCount's write
// surface which is currently disabled (backend/src/services/autocount.ts
// AUTOCOUNT_WRITES_DISABLED). Flipping this to a real push is a separate
// change; for now the endpoint exists so the frontend can wire the
// "Push" button without a 404.
app.post("/entries/:id/push", requirePageAccess("sales", "full"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  return c.json(
    {
      error:
        "AutoCount push is not yet enabled. Entries will be pushed once the write surface is unlocked.",
    },
    501
  );
});

// ── Helper: write custom field values ────────────────────────
async function writeCustomFields(
  env: Env,
  entryId: number,
  custom: Record<string, any>
) {
  // Fetch the defined fields once, filter incoming keys against them.
  const defs = await env.DB.prepare(
    `SELECT field_key FROM udf_fields WHERE table_name = 'sales_entries'`
  ).all<{ field_key: string }>();
  const allowed = new Set((defs.results ?? []).map((d) => d.field_key));

  for (const [key, rawValue] of Object.entries(custom)) {
    if (!allowed.has(key)) continue;
    const value =
      rawValue === null || rawValue === undefined ? null : String(rawValue);
    await env.DB.prepare(
      `INSERT INTO udf_values (table_name, row_key, field_key, value, updated_at)
       VALUES ('sales_entries', ?, ?, ?, datetime('now'))
       ON CONFLICT(table_name, row_key, field_key)
       DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
      .bind(String(entryId), key, value)
      .run();
  }
}

export default app;
