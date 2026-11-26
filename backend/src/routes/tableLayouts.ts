import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
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

const MANAGE_DEFAULTS_PERM = "settings.manage";

/**
 * Who may MANAGE layouts — create, rename, duplicate, delete a named one, and
 * name the company default (owner 2026-08-02: 权限只有 super admin 或者 owner
 * 看得见). That is the "*" wildcard, which in this app is exactly the Owner and
 * Super Admin roles.
 *
 * Deliberately NOT `hasPermission(granted, "layouts.manage")`: that helper
 * answers true for a wildcard holder on ANY key, so inventing a key would read
 * as a narrower gate while behaving identically. Asking for the wildcard
 * itself says what the gate is.
 */
function holdsWildcard(granted: ReadonlyArray<string> | ReadonlySet<string> | undefined): boolean {
  if (!granted) return false;
  if (Array.isArray(granted)) return granted.includes("*");
  return (granted as ReadonlySet<string>).has("*");
}

const requireLayoutManager: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  if (!holdsWildcard(user.permissions_set ?? user.permissions)) {
    return c.json({ error: "You don't have permission to manage layouts." }, 403);
  }
  await next();
};

const TABLE_KEY_RE = /^[a-z0-9][a-z0-9.:_-]{0,79}$/i;

/**
 * Cross-company SHARED grids — the four Delivery/TMS queue boards, which render
 * ONE queue over every company's rows (owner 2026-08-19). Per-company rows
 * forked the same board's layout: whichever company a window was on picked the
 * row, so flipping windows "reset" the board. For these keys the user's LIVE
 * arrangement is pinned to ONE canonical company (the caller's lowest visible
 * company id — deterministic per user, no magic constant), GET serves the
 * NEWEST row wherever it was saved, and every save collapses the fork by
 * deleting the same-key live rows under other companies. Company DEFAULTS and
 * named layouts stay per-company on purpose: a default is a company thing.
 * The same key list lives in frontend dataGridLayoutStorage.ts (minus the
 * 'dg:' prefix), where it unscopes the localStorage entry.
 */
const SHARED_TABLE_KEYS = new Set([
  "dg:dg-delivery-planning",
  // v2 (owner 2026-09-22 column redesign) — the frontend bumped the board's
  // storageKey to retire the saved layouts at once; keep the row shared/pinned
  // so the cross-company fork does not come back. Old key stays for un-migrated rows.
  "dg:dg-delivery-planning-v2",
  "dg:dg-date-arrangement-v2",
  "dg:dg-trips-time-arrangement-v2",
  "dg:dg-last-mile",
  "dg-delivery-planning",
  "dg-delivery-planning-v2",
  "dg-date-arrangement-v2",
  "dg-trips-time-arrangement-v2",
  "dg-last-mile",
]);

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
  pinnedRight: string[];
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
    pinnedRight: keyList(r.pinnedRight),
    groupBy: keyList(r.groupBy),
  };
}

function parseLayout(raw: unknown): StoredLayout | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return sanitizeLayout(JSON.parse(raw));
  } catch {
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
  const canManageLayouts = holdsWildcard(user?.permissions_set ?? user?.permissions);

  const defaults: Record<string, Record<string, StoredLayout>> = {};
  const mine: Record<string, { layout: StoredLayout; updatedAt: string | null }> = {};
  const defaultNames: Record<string, Record<string, string>> = {};
  const myLayouts: Record<string, Array<{ id: number; name: string; layout: StoredLayout }>> = {};
  const sharedLayouts: Record<string, Array<{ id: number; name: string; layout: StoredLayout }>> = {};

  if (visible.length > 0) {
    const ids = visible.map((co) => co.id);
    const uid = userIdOf(c);
    try {
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await c.env.DB.prepare(
        `SELECT id, company_id, user_id, name, is_shared, table_key, layout, updated_at
           FROM table_layouts
          WHERE (user_id IS NULL AND company_id IN (${placeholders}))
             OR (user_id = ? AND company_id IN (${placeholders}))`,
      )
        .bind(...ids, uid, ...ids)
        .all<{
          id: number;
          company_id: number;
          user_id: number | null;
          name: string | null;
          is_shared: boolean | number | string | null;
          table_key: string;
          layout: string;
          updated_at: string | null;
        }>();
      const mineAt = new Map<string, string>();
      const sharedAt = new Map<string, string>();
      for (const row of rows.results ?? []) {
        const layout = parseLayout(row.layout);
        if (!layout) continue;
        const shared = Number(row.is_shared) === 1 || row.is_shared === true || row.is_shared === "t";
        if (row.user_id === null && shared) {
          if (!row.name) continue;
          if (!SHARED_TABLE_KEYS.has(row.table_key) && row.company_id !== activeCompanyId) continue;
          const dedupeKey = `${row.table_key}\u0000${row.name.toLowerCase()}`;
          const at = row.updated_at ?? "";
          const seen = sharedAt.get(dedupeKey);
          if (seen !== undefined && seen >= at) continue;
          sharedAt.set(dedupeKey, at);
          const list = (sharedLayouts[row.table_key] ??= []);
          const idx = list.findIndex((l) => l.name.toLowerCase() === row.name!.toLowerCase());
          const entry = { id: Number(row.id), name: row.name, layout };
          if (idx >= 0) list[idx] = entry;
          else list.push(entry);
        } else if (row.user_id === null) {
          const bucket = (defaults[String(row.company_id)] ??= {});
          bucket[row.table_key] = layout;
          if (row.name) {
            (defaultNames[String(row.company_id)] ??= {})[row.table_key] = row.name;
          }
        } else if (row.name == null) {
          if (SHARED_TABLE_KEYS.has(row.table_key)) {
            const at = row.updated_at ?? "";
            const seen = mineAt.get(row.table_key);
            if (seen !== undefined && seen >= at) continue;
            mineAt.set(row.table_key, at);
          } else if (row.company_id !== activeCompanyId) {
            continue;
          }
          mine[row.table_key] = { layout, updatedAt: row.updated_at ?? null };
        } else {
          if (row.company_id !== activeCompanyId) continue;
          (myLayouts[row.table_key] ??= []).push({
            id: Number(row.id),
            name: row.name,
            layout,
          });
        }
      }
      for (const list of Object.values(myLayouts)) {
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      }
    } catch {
    }
  }

  return c.json({
    companies: visible,
    activeCompanyId,
    canManageDefaults,
    canManageLayouts,
    defaults,
    defaultNames,
    mine,
    myLayouts,
    sharedLayouts,
  });
});

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
  const updated = await env.DB.prepare(
    userId === null
      ?
        `UPDATE table_layouts SET layout = ?, updated_at = ?, updated_by = ?
          WHERE company_id = ? AND table_key = ? AND user_id IS NULL AND is_shared = 0`
      :
        `UPDATE table_layouts SET layout = ?, updated_at = ?, updated_by = ?
          WHERE company_id = ? AND table_key = ? AND user_id = ? AND name IS NULL`,
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

function pinnedCompanyIdFor(c: Ctx): number | null {
  const companies = (c.get("companies") as { id: number }[] | undefined) ?? [];
  const allowedIds = c.get("allowedCompanyIds") as number[] | undefined;
  const ids = (allowedIds ? companies.filter((co) => allowedIds.includes(co.id)) : companies)
    .map((co) => co.id)
    .filter((id) => Number.isFinite(id));
  return ids.length > 0 ? Math.min(...ids) : null;
}

function mineTarget(
  c: Ctx,
): { error: string } | { tableKey: string; companyId: number; shared: boolean } {
  const target = readTarget(c);
  if ("error" in target) return { error: String(target.error) };
  if (!SHARED_TABLE_KEYS.has(target.tableKey)) return { ...target, shared: false };
  return { tableKey: target.tableKey, companyId: pinnedCompanyIdFor(c) ?? target.companyId, shared: true };
}

app.put("/:tableKey", async (c) => {
  const target = mineTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const body = await c.req.json().catch(() => ({}));
  const layout = sanitizeLayout((body as { layout?: unknown }).layout);
  await upsert(c.env, target.companyId, uid, target.tableKey, layout, uid);
  if (target.shared) {
    await c.env.DB.prepare(
      "DELETE FROM table_layouts WHERE table_key = ? AND user_id = ? AND name IS NULL AND company_id <> ?",
    )
      .bind(target.tableKey, uid, target.companyId)
      .run();
  }
  return c.json({ ok: true, layout });
});

app.delete("/:tableKey", async (c) => {
  const target = mineTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  if (target.shared) {
    await c.env.DB.prepare(
      "DELETE FROM table_layouts WHERE table_key = ? AND user_id = ? AND name IS NULL",
    )
      .bind(target.tableKey, uid)
      .run();
    return c.json({ ok: true });
  }
  await c.env.DB.prepare(
    "DELETE FROM table_layouts WHERE company_id = ? AND table_key = ? AND user_id = ? AND name IS NULL",
  )
    .bind(target.companyId, target.tableKey, uid)
    .run();
  return c.json({ ok: true });
});

app.put("/:tableKey/default", requirePermission(MANAGE_DEFAULTS_PERM), async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const body = await c.req.json().catch(() => ({}));
  const layout = sanitizeLayout((body as { layout?: unknown }).layout);
  await upsert(c.env, target.companyId, null, target.tableKey, layout, userIdOf(c));
  return c.json({ ok: true, layout });
});

app.patch("/:tableKey/default", requireLayoutManager, async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const body = await c.req.json().catch(() => ({}));
  const raw = (body as { name?: unknown }).name;
  const name = cleanName(raw);
  const res = await c.env.DB.prepare(
    `UPDATE table_layouts SET name = ?, updated_at = ?, updated_by = ?
      WHERE company_id = ? AND table_key = ? AND user_id IS NULL AND is_shared = 0`,
  )
    .bind(name || null, nowIso(), userIdOf(c), target.companyId, target.tableKey)
    .run();
  if (Number(res.meta?.changes ?? 0) === 0) {
    return c.json({ error: "This company has no saved default for that table yet." }, 404);
  }
  return c.json({ ok: true, name: name || null });
});

app.delete("/:tableKey/default", requirePermission(MANAGE_DEFAULTS_PERM), async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  await c.env.DB.prepare(
    "DELETE FROM table_layouts WHERE company_id = ? AND table_key = ? AND user_id IS NULL AND is_shared = 0",
  )
    .bind(target.companyId, target.tableKey)
    .run();
  return c.json({ ok: true });
});


app.put("/:tableKey/shared", requireLayoutManager, async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const body = await c.req.json().catch(() => ({}));
  const name = cleanName((body as { name?: unknown }).name);
  if (!name) return c.json({ error: "Give the shared layout a name." }, 400);
  const layout = sanitizeLayout((body as { layout?: unknown }).layout);
  const payload = JSON.stringify(layout);
  const at = nowIso();
  const by = userIdOf(c);
  const crossCompany = SHARED_TABLE_KEYS.has(target.tableKey);
  const writeCompany = crossCompany ? (pinnedCompanyIdFor(c) ?? target.companyId) : target.companyId;
  const updated = await c.env.DB.prepare(
    `UPDATE table_layouts SET layout = ?, updated_at = ?, updated_by = ?
      WHERE company_id = ? AND table_key = ? AND user_id IS NULL AND is_shared = 1
        AND lower(name) = lower(?)`,
  )
    .bind(payload, at, by, writeCompany, target.tableKey, name)
    .run();
  if (Number(updated.meta?.changes ?? 0) === 0) {
    await c.env.DB.prepare(
      `INSERT INTO table_layouts (company_id, user_id, name, is_shared, table_key, layout, updated_at, updated_by)
       VALUES (?, NULL, ?, 1, ?, ?, ?, ?)`,
    )
      .bind(writeCompany, name, target.tableKey, payload, at, by)
      .run();
  }
  if (crossCompany) {
    await c.env.DB.prepare(
      `DELETE FROM table_layouts
        WHERE table_key = ? AND user_id IS NULL AND is_shared = 1
          AND lower(name) = lower(?) AND company_id <> ?`,
    )
      .bind(target.tableKey, name, writeCompany)
      .run();
  }
  return c.json({ ok: true, name, layout });
});

app.delete("/:tableKey/shared/:name", requireLayoutManager, async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const name = cleanName(c.req.param("name"));
  if (!name) return c.json({ error: "Invalid layout name." }, 400);
  const crossCompany = SHARED_TABLE_KEYS.has(target.tableKey);
  await c.env.DB.prepare(
    crossCompany
      ? `DELETE FROM table_layouts
           WHERE table_key = ? AND user_id IS NULL AND is_shared = 1 AND lower(name) = lower(?)`
      : `DELETE FROM table_layouts
           WHERE company_id = ? AND table_key = ? AND user_id IS NULL AND is_shared = 1 AND lower(name) = lower(?)`,
  )
    .bind(...(crossCompany ? [target.tableKey, name] : [target.companyId, target.tableKey, name]))
    .run();
  return c.json({ ok: true });
});


const MAX_NAME_LEN = 60;

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_NAME_LEN);
}

app.get("/:tableKey/layouts", async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const rows = await c.env.DB.prepare(
    `SELECT id, name, layout FROM table_layouts
      WHERE company_id = ? AND table_key = ? AND user_id = ? AND name IS NOT NULL
      ORDER BY name`,
  )
    .bind(target.companyId, target.tableKey, uid)
    .all<{ id: number; name: string; layout: string }>();
  return c.json({
    layouts: (rows.results ?? [])
      .map((r) => ({ id: Number(r.id), name: r.name, layout: parseLayout(r.layout) }))
      .filter((r) => r.layout !== null),
  });
});

app.post("/:tableKey/layouts", requireLayoutManager, async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const body = await c.req.json().catch(() => ({}));
  const name = cleanName((body as { name?: unknown }).name);
  if (!name) return c.json({ error: "Give the layout a name." }, 400);
  const layout = sanitizeLayout((body as { layout?: unknown }).layout);

  const clash = await c.env.DB.prepare(
    `SELECT id FROM table_layouts
      WHERE company_id = ? AND table_key = ? AND user_id = ? AND lower(name) = lower(?)`,
  )
    .bind(target.companyId, target.tableKey, uid, name)
    .first<{ id: number }>();
  if (clash) return c.json({ error: `You already have a layout called “${name}”.` }, 409);

  const inserted = await c.env.DB.prepare(
    `INSERT INTO table_layouts (company_id, user_id, name, table_key, layout, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(target.companyId, uid, name, target.tableKey, JSON.stringify(layout), nowIso(), uid)
    .run();
  return c.json({
    layout: { id: Number(inserted.meta?.last_row_id ?? 0), name, layout },
  });
});

app.patch("/:tableKey/layouts/:id", requireLayoutManager, async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "Invalid layout" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const name = cleanName((body as { name?: unknown }).name);
  if (!name) return c.json({ error: "Give the layout a name." }, 400);

  const clash = await c.env.DB.prepare(
    `SELECT id FROM table_layouts
      WHERE company_id = ? AND table_key = ? AND user_id = ? AND lower(name) = lower(?) AND id <> ?`,
  )
    .bind(target.companyId, target.tableKey, uid, name, id)
    .first<{ id: number }>();
  if (clash) return c.json({ error: `You already have a layout called “${name}”.` }, 409);

  const res = await c.env.DB.prepare(
    `UPDATE table_layouts SET name = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND company_id = ? AND table_key = ? AND user_id = ? AND name IS NOT NULL`,
  )
    .bind(name, nowIso(), uid, id, target.companyId, target.tableKey, uid)
    .run();
  if (Number(res.meta?.changes ?? 0) === 0) return c.json({ error: "Layout not found" }, 404);
  return c.json({ ok: true, name });
});

/**
 * PUT /api/table-layouts/:tableKey/layouts/:id — replace a saved layout's
 * COLUMNS with what is on screen (owner 2026-08-02: default layout 需要可以
 * edit). Renaming is PATCH; this is the other half — without it a layout could
 * only ever be created, and "fix the one I already have" meant delete-and-
 * recreate under the same name.
 *
 * The company default's equivalent is PUT /:tableKey/default, which already
 * existed — so both kinds of layout can now be edited in place.
 */
app.put("/:tableKey/layouts/:id", requireLayoutManager, async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "Invalid layout" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const layout = sanitizeLayout((body as { layout?: unknown }).layout);
  const res = await c.env.DB.prepare(
    `UPDATE table_layouts SET layout = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND company_id = ? AND table_key = ? AND user_id = ? AND name IS NOT NULL`,
  )
    .bind(JSON.stringify(layout), nowIso(), uid, id, target.companyId, target.tableKey, uid)
    .run();
  if (Number(res.meta?.changes ?? 0) === 0) return c.json({ error: "Layout not found" }, 404);
  return c.json({ ok: true, layout });
});

app.delete("/:tableKey/layouts/:id", requireLayoutManager, async (c) => {
  const target = readTarget(c);
  if ("error" in target) return c.json({ error: target.error }, 400);
  const uid = userIdOf(c);
  if (!uid) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "Invalid layout" }, 400);
  const res = await c.env.DB.prepare(
    `DELETE FROM table_layouts
      WHERE id = ? AND company_id = ? AND table_key = ? AND user_id = ? AND name IS NOT NULL`,
  )
    .bind(id, target.companyId, target.tableKey, uid)
    .run();
  if (Number(res.meta?.changes ?? 0) === 0) return c.json({ error: "Layout not found" }, 404);
  return c.json({ ok: true });
});

export default app;
