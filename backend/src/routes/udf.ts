import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { requirePermission, requirePageAccessOrSalesView } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

const READ_GATE: Record<string, MiddlewareHandler<{ Bindings: Env }>> = {
  sales_orders: requirePermission("sales_orders.read"),
  delivery_orders: requirePermission("delivery_orders.read"),
  purchase_orders: requirePermission("purchase_orders.read"),
  assr: requirePermission("service_cases.read"),
  balance: requirePermission("balance.read"),
  overdue: requirePermission("overdue.read"),
  logs: requirePermission("logs.read"),
  sales_entries: requirePageAccessOrSalesView("sales"),
};

const ALLOWED_TYPES = new Set(["text", "number", "date", "select", "checkbox"]);

function validateTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(READ_GATE, table);
}

const udfReadGate: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const table = c.req.param("table");
  if (!table || !validateTable(table)) return c.json({ error: "Invalid table" }, 400);
  return READ_GATE[table](c, next);
};

function validateKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,39}$/.test(key);
}

app.get("/:table", udfReadGate, async (c) => {
  const table = c.req.param("table");
  if (!validateTable(table)) return c.json({ error: "Invalid table" }, 400);

  const fieldsRes = await c.env.DB.prepare(
    `SELECT id, field_key as key, label, field_type as type, options, position
     FROM udf_fields WHERE table_name = ?
     ORDER BY position ASC, id ASC`
  )
    .bind(table)
    .all();

  const fields = (fieldsRes.results || []).map((r: any) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type,
    options: r.options ? JSON.parse(r.options) : null,
    position: r.position ?? 0,
  }));

  const valuesRes = await c.env.DB.prepare(
    `SELECT row_key, field_key, value FROM udf_values WHERE table_name = ?`
  )
    .bind(table)
    .all<{ row_key: string; field_key: string; value: string | null }>();

  const values: Record<string, Record<string, string | null>> = {};
  for (const row of valuesRes.results || []) {
    if (!values[row.row_key]) values[row.row_key] = {};
    values[row.row_key][row.field_key] = row.value;
  }

  return c.json({ fields, values });
});

app.post("/:table", requirePermission("udf.manage"), async (c) => {
  const table = c.req.param("table");
  if (!validateTable(table)) return c.json({ error: "Invalid table" }, 400);

  const body = await c.req.json<{
    key: string;
    label: string;
    type?: string;
    options?: string[];
  }>();

  if (!body.key || !body.label) {
    return c.json({ error: "key and label are required" }, 400);
  }
  if (!validateKey(body.key)) {
    return c.json(
      { error: "key must be snake_case (a-z, 0-9, _) and start with a letter" },
      400
    );
  }
  const type = body.type || "text";
  if (!ALLOWED_TYPES.has(type)) {
    return c.json({ error: `type must be one of ${[...ALLOWED_TYPES].join(", ")}` }, 400);
  }
  if (type === "select" && (!body.options || !body.options.length)) {
    return c.json({ error: "select fields require options" }, 400);
  }

  const exists = await c.env.DB.prepare(
    `SELECT id FROM udf_fields WHERE table_name = ? AND field_key = ?`
  )
    .bind(table, body.key)
    .first();
  if (exists) return c.json({ error: "A field with that key already exists" }, 409);

  const maxPos = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 as next FROM udf_fields WHERE table_name = ?`
  )
    .bind(table)
    .first<{ next: number }>();

  const result = await c.env.DB.prepare(
    `INSERT INTO udf_fields (table_name, field_key, label, field_type, options, position)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      table,
      body.key,
      body.label,
      type,
      body.options ? JSON.stringify(body.options) : null,
      maxPos?.next ?? 0
    )
    .run();

  return c.json({
    id: result.meta.last_row_id,
    key: body.key,
    label: body.label,
    type,
    options: body.options ?? null,
    position: maxPos?.next ?? 0,
  });
});

app.delete("/:table/:key", requirePermission("udf.manage"), async (c) => {
  const table = c.req.param("table");
  const key = c.req.param("key");
  if (!validateTable(table)) return c.json({ error: "Invalid table" }, 400);

  await c.env.DB.prepare(
    `DELETE FROM udf_values WHERE table_name = ? AND field_key = ?`
  )
    .bind(table, key)
    .run();

  const res = await c.env.DB.prepare(
    `DELETE FROM udf_fields WHERE table_name = ? AND field_key = ?`
  )
    .bind(table, key)
    .run();

  if (!res.meta.changes) return c.json({ error: "Field not found" }, 404);
  return c.json({ ok: true });
});

app.put("/:table/values/:rowKey", requirePermission("udf.manage"), async (c) => {
  const table = c.req.param("table");
  const rowKey = c.req.param("rowKey");
  if (!validateTable(table)) return c.json({ error: "Invalid table" }, 400);

  const body = await c.req.json<Record<string, string | null>>();
  if (!body || typeof body !== "object") {
    return c.json({ error: "Body must be an object of field_key → value" }, 400);
  }

  const fieldsRes = await c.env.DB.prepare(
    `SELECT field_key FROM udf_fields WHERE table_name = ?`
  )
    .bind(table)
    .all<{ field_key: string }>();
  const known = new Set((fieldsRes.results || []).map((r) => r.field_key));

  for (const k of Object.keys(body)) {
    if (!known.has(k)) {
      return c.json({ error: `Unknown field: ${k}` }, 400);
    }
  }

  for (const [fieldKey, value] of Object.entries(body)) {
    if (value == null || value === "") {
      await c.env.DB.prepare(
        `DELETE FROM udf_values WHERE table_name = ? AND row_key = ? AND field_key = ?`
      )
        .bind(table, rowKey, fieldKey)
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO udf_values (table_name, row_key, field_key, value, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(table_name, row_key, field_key)
         DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
        .bind(table, rowKey, fieldKey, String(value))
        .run();
    }
  }

  return c.json({ ok: true });
});

export default app;
