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
      .select("movement_type, warehouse_id, product_code, variant_key, batch_no, qty, total_cost_sen")
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
      .update({ unit_cost_centi: 830, line_cost_centi: 830, line_margin_centi: -830 })
      .eq("id", "line-1");
    expect(calls[0].text).toBe('UPDATE "scm"."delivery_order_items" SET "unit_cost_centi" = $1, "line_cost_centi" = $2, "line_margin_centi" = $3 WHERE "id" = $4');
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
