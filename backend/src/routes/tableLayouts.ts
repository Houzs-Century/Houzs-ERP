import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { hasPermission } from "../services/permissions";

/**
 * Column layouts for the list tables (owner 2026-08-01).
 *
 * Two row kinds in one table (see migrations-pg/0236_table_layouts.sql):
 *
 *   user_id IS NULL  → this COMPANY's default view, written from the Columns
 *                      panel by a settings.manage admin. Replaces the code
 *                      constants that used to make "move a column for everyone
 *                      in 2990" a pull request.
 *   user_id IS SET   → that user's own arrangement, so it follows the account
 *                      to another machine instead of dying with a localStorage.
 *
 * The user's row always beats the default — which is what makes changing a
 * default safe: it only ever reaches people who haven't arranged their own.
 *
 * COMPANY COMES FROM THE SERVER, never from the body: every write lands in
 * `c.get("companyId")`, the company companyContext resolved for this request.
 * A caller cannot write into a company they aren't in, and there is no
 * company field to forge.
 */

const app = new Hono<{ Bindings: Env }>();

/** Who may write a company-wide default. Same verb as the other admin-wide
 *  settings surfaces (Settings → Branding / Email), so no new role plumbing. */
const MANAGE_DEFAULTS_PERM = "settings.manage";

/**
 * The layout FAMILY key, e.g. 'sales-orders-v2', or 'dg:dg-suppliers' for a
 * table still on the vendored SCM DataGrid — whose own storage keys carry dots
 * ('cn-g.cn-from-order-lines.layout.v1'), hence the '.' here. The 'dg:' prefix
 * is what tells the frontend which local storage shape a row belongs to; the
 * server never interprets it.
 */
const TABLE_KEY_RE = /^[a-z0-9][a-z0-9.:_-]{0,79}$/i;

/** Bounds. A layout is a handful of column keys, never a document. */
const MAX_KEYS = 200;
const MAX_KEY_LEN = 64;
const MIN_WIDTH = 40;
const MAX_WIDTH = 2000;

interface StoredLayout {
  order: string[];
  hidden: string[];
  shown: string[];
  widths: Record<string, number>;
  pinned: string[];
  /** Group-by columns. Only the vendored SCM DataGrid has these, and there they
   *  ARE part of the layout — grouping a list by supplier changes its shape.
   *  Sort is deliberately not here: it stays device-local on both grids. */
  groupBy: string[];
}

const isKey = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_KEY_LEN;

function keyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (!isKey(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

/**
 * Normalise whatever the client sent into the stored shape. Deliberately
 * TOTAL (never throws, never rejects): the input is one browser's accumulated
 * column prefs, and a single corrupt width must not cost the user the rest of
 * their layout. Anything unrecognised is dropped, which is also what makes the
 * echo on GET safe — nothing round-trips that this function didn't build.
 */
function sanitizeLayout(raw: unknown): StoredLayout {
  const r = (raw ?? {}) as Record<string, unknown>;
  const widths: Record<string, number> = {};
  const rawWidths = r.widths;
  if (rawWidths && typeof rawWidths === "object" && !Array.isArray(rawWidths)) {
    for (const [k, v] of Object.entries(rawWidths as Record<string, unknown>)) {
      if (!isKey(k)) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      widths[k] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
      if (Object.keys(widths).length >= MAX_KEYS) break;
    }
  }
  return {
    order: keyList(r.order),
    hidden: keyList(r.hidden),
    shown: keyList(r.shown),
    widths,
    pinned: keyList(r.pinned),
    groupBy: keyList(r.groupBy),
  };
}

function parseLayout(raw: unknown): StoredLayout | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return sanitizeLayout(JSON.parse(raw));
  } catch {
    // A row we can't parse is a row we ignore: the caller falls back to the
    // company default / code preset rather than seeing a broken table.
    return null;
  }
}

type Ctx = Context<{ Bindings: Env }>;

const userIdOf = (c: Ctx): number => {
  const raw = (c.get("user") as { id?: number | string } | undefined)?.id;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * GET /api/table-layouts
 *
 * ONE boot request for every table in the app: layouts are a few hundred bytes
 * each and are needed BEFORE the first list renders (a table that hydrates
 * after mount would visibly re-arrange itself), so they are fetched together
 * rather than per page.
 *
 *   defaults — every company this caller may see, so the Columns panel can
 *              offer "the other company's layout" as a one-click preset. Column
 *              KEYS only; no rows, no data, nothing company-confidential.
 *   mine     — the active company only. Each window is one company, and
 *              switching company refetches.
 */
app.get("/", async (c) => {
  const companies = (c.get("companies") as { id: number; code: string; name: string }[] | undefined) ?? [];
  const allowedIds = c.get("allowedCompanyIds") as number[] | undefined;
  const visible = allowedIds ? companies.filter((co) => allowedIds.includes(co.id)) : companies;
  const activeCompanyId = (c.get("companyId") as number | undefined) ?? null;
  const user = c.get("user");
  const canManageDefaults = hasPermission(
    user?.permissions_set ?? user?.permissions ?? [],
    MANAGE_DEFAULTS_PERM,
  );

  const defaults: Record<string, Record<string, StoredLayout>> = {};
  const mine: Record<string, { layout: StoredLayout; updatedAt: string | null }> = {};

  // Pre-activation (no companies master) there is nothing to key rows by —
  // return the empty shape and let every table fall back to its code preset,
  // exactly as before this feature existed.
  if (visible.length > 0) {
    const ids = visible.map((co) => co.id);
    const uid = userIdOf(c);
    try {
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await c.env.DB.prepare(
        `SELECT company_id, user_id, table_key, layout, updated_at
           FROM table_layouts
          WHERE (user_id IS NULL AND company_id IN (${placeholders}))
             OR (user_id = ? AND company_id = ?)`,
      )
        .bind(...ids, uid, activeCompanyId ?? 0)
        .all<{
          company_id: number;
          user_id: number | null;
          table_key: string;
          layout: string;
          updated_at: string | null;
        }>();
      for (const row of rows.results ?? []) {
        const layout = parseLayout(row.layout);
        if (!layout) continue;
        if (row.user_id === null) {
          const bucket = (defaults[String(row.company_id)] ??= {});
          bucket[row.table_key] = layout;
        } else {
          mine[row.table_key] = { layout, updatedAt: row.updated_at ?? null };
        }
      }
    } catch {
      // Table absent (migration not applied yet) or a transient DB error. A
      // layout store is a convenience: degrade to "nothing saved" and let the
      // page's own defaults render rather than failing the boot request.
    }
  }

  return c.json({
    companies: visible,
    activeCompanyId,
    canManageDefaults,
    defaults,
    mine,
  });
});

/** Shared upsert. `userId === null` writes the company default. */
async function upsert(
  env: Env,
  companyId: number,
  userId: number | null,
  tableKey: string,
  layout: StoredLayout,
  updatedBy: number,
): Promise<void> {
  const payload = JSON.stringify(layout);
  const at = nowIso();
  // No ON CONFLICT: the two uniques are PARTIAL indexes, which Postgres will
  // only use as a conflict target when the statement repeats their exact
  // predicate — a footgun that reads as working until the NULL/NOT-NULL case
  // diverges. Update-then-insert is unambiguous under both engines, and the
  // uniques still make a lost race an error rather than a duplicate.
  const updated = await env.DB.prepare(
    userId === null
      ? `UPDATE table_layouts SET layout = ?, updated_at = ?, updated_by = ?
          WHERE company_id = ? AND table_key = ? AND user_id IS NULL`
      : `UPDATE table_layouts SET layout = ?, updated_at = ?, updated_by = ?
          WHERE company_id = ? AND table_key = ? AND user_id = ?`,
  )
    .bind(
      ...(userId === null
        ? [payload, at, updatedBy, companyId, tableKey]
        : [payload, at, updatedBy, companyId, tableKey, userId]),
    )
    .run();
  const changed = Number(updated.meta?.changes ?? 0);
  if (changed > 0) return;
  await env.DB.prepare(
    `INSERT INTO table_layouts (company_id, user_id, table_key, layout, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(companyId, userId, tableKey, payload, at, updatedBy)
    .run();
}

function readTarget(c: Ctx) {
  const tableKey = c.req.param("tableKey") ?? "";
  const companyId = c.get("companyId") as number | undefined;
  if (!TABLE_KEY_RE.test(tableKey)) return { error: "Invalid table key" as const };
  if (!companyId) return { error: "No active company" as const };
  return { tableKey, companyId };
}

/** PUT /api/table-layouts/:tableKey — save MY layout for the active company. */
app.put("/:tableKey", async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const body = await c.req.json().catch(() => ({}));
  const layout = sanitizeLayout((body as { layout?: unknown }).layout);
  await upsert(c.env, target.companyId, uid, target.tableKey, layout, uid);
  return c.json({ ok: true, layout });
});

/** DELETE /api/table-layouts/:tableKey — forget MY layout (the panel's Reset),
 *  so this table falls back to the company default again. */
app.delete("/:tableKey", async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  await c.env.DB.prepare(
    "DELETE FROM table_layouts WHERE company_id = ? AND table_key = ? AND user_id = ?",
  )
    .bind(target.companyId, target.tableKey, uid)
    .run();
  return c.json({ ok: true });
});

/**
 * PUT /api/table-layouts/:tableKey/default — set THIS COMPANY's default view.
 *
 * Reaches only users who have never arranged this table themselves; everyone
 * else keeps their own row. Which company is written is the request's active
 * company, so the admin sets 2990's default from a 2990 window and Houzs's
 * from a Houzs window — the same window they arranged the columns in.
 */
app.put("/:tableKey/default", requirePermission(MANAGE_DEFAULTS_PERM), async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const body = await c.req.json().catch(() => ({}));
  const layout = sanitizeLayout((body as { layout?: unknown }).layout);
  await upsert(c.env, target.companyId, null, target.tableKey, layout, userIdOf(c));
  return c.json({ ok: true, layout });
});

/** DELETE /api/table-layouts/:tableKey/default — drop this company's default,
 *  falling the table back to the page's own preset. The undo for a bad save. */
app.delete("/:tableKey/default", requirePermission(MANAGE_DEFAULTS_PERM), async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  await c.env.DB.prepare(
    "DELETE FROM table_layouts WHERE company_id = ? AND table_key = ? AND user_id IS NULL",
  )
    .bind(target.companyId, target.tableKey)
    .run();
  return c.json({ ok: true });
});

export default app;
