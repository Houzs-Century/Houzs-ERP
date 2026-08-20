import { describe, expect, test } from "vitest";
import { pgrestShim } from "../scripts/lib/pgrest-shim.mjs";

// The shim carries the app's REAL costing functions (restampDoActualCost,
// restampSiFromDo) over a direct postgres connection, so ITS translation is
// part of the money path. These tests pin (a) the exact SQL each supabase-js
// chain those functions use translates to, and (b) the loud-failure contract:
// any method the shim does not implement throws AND lands on __gaps, so a
// caller can prove no query was silently skipped.

type Call = { text: string; params: unknown[] };

function fakeSql(rows: unknown[] = []) {
  const calls: Call[] = [];
  const sql = {
    unsafe: async (text: string, params: unknown[] = []) => {
      calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
      return rows;
    },
  };
  return { sql, calls };
}

describe("pgrest-shim — SQL translation for the exact chains the canonical functions use", () => {
  test("select().eq().maybeSingle() — the restamp's DO header read", async () => {
    const { sql, calls } = fakeSql([{ status: "DISPATCHED" }]);
    const sb = pgrestShim(sql as never, "scm");
    const res = await sb.from("delivery_orders")
      .select("status, warehouse_id, is_dropship").eq("id", "do-1").maybeSingle();
    expect(calls[0].text).toBe('SELECT "status", "warehouse_id", "is_dropship" FROM "scm"."delivery_orders" WHERE "id" = $1');
    expect(calls[0].params).toEqual(["do-1"]);
    expect(res).toEqual({ data: { status: "DISPATCHED" }, error: null });
  });

  test("maybeSingle() with zero rows is data:null, error:null (PostgREST semantics)", async () => {
    const { sql } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    const res = await sb.from("delivery_orders").select("status").eq("id", "x").maybeSingle();
    expect(res).toEqual({ data: null, error: null });
  });

  test(".in() expands to one placeholder per element; an EMPTY list matches nothing without touching the DB shape", async () => {
    const { sql, calls } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    await sb.from("mfg_sales_order_items").select("id, warehouse_id").in("id", ["a", "b", "c"]);
    expect(calls[0].text).toBe('SELECT "id", "warehouse_id" FROM "scm"."mfg_sales_order_items" WHERE "id" IN ($1, $2, $3)');
    expect(calls[0].params).toEqual(["a", "b", "c"]);
    const res = await sb.from("mfg_sales_order_items").select("id").in("id", []);
    expect(calls[1].text).toContain("WHERE FALSE");
    expect(res).toEqual({ data: [], error: null });
  });

  test("chained filters AND together — the movements read", async () => {
    const { sql, calls } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    await sb.from("inventory_movements")
      .select("movement_type, warehouse_id, item_code, variant_key, batch_no, qty, total_cost_sen")
      .eq("source_doc_type", "DO").eq("source_doc_id", "do-1");
    expect(calls[0].text).toContain('WHERE "source_doc_type" = $1 AND "source_doc_id" = $2');
  });

  test(".not(col, 'is', null) + .order + .limit — the dropship expected-batch read", async () => {
    const { sql, calls } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    await sb.from("purchase_order_items")
      .select("so_item_id, purchase_order_id, created_at")
      .in("so_item_id", ["s1"]).not("purchase_order_id", "is", null);
    expect(calls[0].text).toContain('"so_item_id" IN ($1) AND "purchase_order_id" IS NOT NULL');
    await sb.from("warehouses").select("id").eq("is_default", true)
      .order("code", { ascending: true }).limit(1).maybeSingle();
    expect(calls[1].text).toContain('WHERE "is_default" = $1 ORDER BY "code" ASC LIMIT 1');
    expect(calls[1].params).toEqual([true]);
  });

  test("update().eq() — the line-cost write, params in SET-then-WHERE order", async () => {
    const { sql, calls } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    const res = await sb.from("delivery_order_items")
      .update({ unit_cost_sen: 830, line_cost_sen: 830, line_margin_sen: -830 })
      .eq("id", "line-1");
    expect(calls[0].text).toBe('UPDATE "scm"."delivery_order_items" SET "unit_cost_sen" = $1, "line_cost_sen" = $2, "line_margin_sen" = $3 WHERE "id" = $4');
    expect(calls[0].params).toEqual([830, 830, -830, "line-1"]);
    expect(res.error).toBeNull();
  });

  test("a database error comes back as { error }, never a throw — the app code checks .error", async () => {
    const sql = { unsafe: async () => { const e = new Error('column "is_dropship" does not exist') as Error & { code?: string }; e.code = "42703"; throw e; } };
    const sb = pgrestShim(sql as never);
    const res = await sb.from("delivery_orders").select("status, is_dropship").eq("id", "x").maybeSingle();
    expect(res.data).toBeNull();
    expect(res.error?.message).toContain("is_dropship");
  });
});

describe("pgrest-shim — the loud-failure contract", () => {
  test("an unimplemented method throws AND records on __gaps", async () => {
    const { sql } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    expect(() => (sb.from("delivery_orders") as never as { or: (s: string) => void }).or("a.eq.1")).toThrow(/GAP/);
    expect(sb.__gaps.length).toBe(1);
    expect(sb.__gaps[0]).toContain(".or(");
  });

  test("rpc() is a recorded gap — reconcile functions are driven with sql.unsafe, not through the shim", () => {
    const { sql } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    expect(() => sb.rpc("fn_reconcile_uncosted_out")).toThrow(/GAP/);
    expect(sb.__gaps[0]).toContain("fn_reconcile_uncosted_out");
  });

  test("embedded/aliased selects are refused loudly, not mistranslated", async () => {
    const { sql } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    const res = await sb.from("delivery_orders").select("id, items:delivery_order_items(id)").eq("id", "x");
    expect(res.error?.message).toContain("GAP");
    expect(sb.__gaps.length).toBe(1);
  });

  test("unsafe identifiers are refused before any SQL is built", () => {
    const { sql } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    expect(() => sb.from('delivery_orders"; DROP TABLE x; --')).toThrow(/unsafe identifier/);
  });
});

describe("pgrest-shim — 2026-08-01 growth: the recomputeSoStockAllocation surface", () => {
  test(".not(col,'in','(A,B,C)') — the allocator's status exclusion, one placeholder per value", async () => {
    const { sql, calls } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    await sb.from("mfg_sales_orders")
      .select("doc_no, status")
      .not("status", "in", "(CANCELLED,CLOSED,SHIPPED,DELIVERED,INVOICED,DRAFT)");
    expect(calls[0].text).toContain('"status" NOT IN ($1, $2, $3, $4, $5, $6)');
    expect(calls[0].params).toEqual(["CANCELLED", "CLOSED", "SHIPPED", "DELIVERED", "INVOICED", "DRAFT"]);
  });

  test(".or('a.is.null,b.lt.<ISO>') — the lock-claim disjunction; the ISO value keeps its dots", async () => {
    const { sql, calls } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    const now = "2026-08-01T12:00:00.000Z";
    await sb.from("stock_allocation_recompute_lock")
      .select("lock_key").eq("lock_key", "global").or(`locked_by.is.null,locked_until.lt.${now}`);
    expect(calls[0].text).toContain('WHERE "lock_key" = $1 AND ("locked_by" IS NULL OR "locked_until" < $2)');
    expect(calls[0].params).toEqual(["global", now]);
  });

  test("update().or().select().maybeSingle() — the lock claim RETURNS the row it claimed (or null when it lost)", async () => {
    const { sql, calls } = fakeSql([{ lock_key: "global" }]);
    const sb = pgrestShim(sql as never);
    const res = await sb.from("stock_allocation_recompute_lock")
      .update({ locked_by: "tok", locked_until: "2026-08-01T12:05:00.000Z" })
      .eq("lock_key", "global")
      .or("locked_by.is.null,locked_until.lt.2026-08-01T12:00:00.000Z")
      .select("lock_key")
      .maybeSingle();
    expect(calls[0].text).toBe('UPDATE "scm"."stock_allocation_recompute_lock" SET "locked_by" = $1, "locked_until" = $2 WHERE "lock_key" = $3 AND ("locked_by" IS NULL OR "locked_until" < $4) RETURNING "lock_key"');
    expect(res).toEqual({ data: { lock_key: "global" }, error: null });
    // The losing claimant sees data:null, not an error — the allocator's
    // "another_recompute_in_progress" branch depends on exactly this.
    const { sql: sql2 } = fakeSql([]);
    const sb2 = pgrestShim(sql2 as never);
    const lost = await sb2.from("stock_allocation_recompute_lock")
      .update({ locked_by: "tok" }).eq("lock_key", "global").select("lock_key").maybeSingle();
    expect(lost).toEqual({ data: null, error: null });
  });

  test("a plain update (no .select()) keeps data:null — the flip writes are unchanged", async () => {
    const { sql, calls } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    const res = await sb.from("mfg_sales_order_items")
      .update({ stock_status: "PENDING", stock_qty_ready: 0 }).in("id", ["a", "b"]);
    expect(calls[0].text).toBe('UPDATE "scm"."mfg_sales_order_items" SET "stock_status" = $1, "stock_qty_ready" = $2 WHERE "id" IN ($3, $4)');
    expect(res).toEqual({ data: null, error: null });
  });

  test(".insert() — audit rows batch with a UNION column set; a row missing a key inserts NULL", async () => {
    const { sql, calls } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    await sb.from("mfg_so_audit_log").insert([
      { so_doc_no: "SO-1", action: "AUTO", company_id: 1 },
      { so_doc_no: "SO-2", action: "AUTO" },
    ]);
    expect(calls[0].text).toBe('INSERT INTO "scm"."mfg_so_audit_log" ("so_doc_no", "action", "company_id") VALUES ($1, $2, $3), ($4, $5, $6)');
    expect(calls[0].params).toEqual(["SO-1", "AUTO", 1, "SO-2", "AUTO", null]);
    // Single-object insert works too (mfg_so_status_changes).
    await sb.from("mfg_so_status_changes").insert({ doc_no: "SO-1", from_status: "CONFIRMED", to_status: "READY_TO_SHIP" });
    expect(calls[1].text).toContain('INSERT INTO "scm"."mfg_so_status_changes"');
  });

  test("the .or grammar stays narrow: any op outside is.null / lt is a loud gap", () => {
    const { sql } = fakeSql([]);
    const sb = pgrestShim(sql as never);
    expect(() => (sb.from("mfg_sales_orders") as never as { or: (s: string) => void }).or("status.eq.READY")).toThrow(/GAP/);
    expect(sb.__gaps.length).toBe(1);
  });
});
