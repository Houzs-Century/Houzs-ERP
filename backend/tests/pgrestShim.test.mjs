// The shim's own rule: "the day a canonical function needs one, the gap list
// names it and the shim grows a TESTED method." These are those tests.
//
// The shim builds SQL text, so it is tested by handing it a fake tagged-template
// client that records what it was asked to run. No database is involved.
import { test } from 'vitest';
import assert from "node:assert/strict";
import { pgrestShim } from "../scripts/lib/pgrest-shim.mjs";

/* A stand-in for the `postgres` tagged-template client: records the assembled
   statement and the parameters, and returns whatever rows the test supplies. */
function fakeSql(rows = []) {
  const calls = [];
  const sql = (strings, ...params) => {
    const text = strings.raw ? strings.raw.join("?") : String(strings);
    calls.push({ text, params });
    return Promise.resolve(rows);
  };
  sql.unsafe = (text, params = []) => { calls.push({ text, params }); return Promise.resolve(rows); };
  sql.calls = calls;
  return sql;
}

const lastCall = (sql) => sql.calls[sql.calls.length - 1];

test("gt emits a > comparison with the value as a parameter", async () => {
  const sql = fakeSql([{ id: "a" }]);
  const sb = pgrestShim(sql);
  const { data, error } = await sb.from("v_inventory_lots_open").select("id, qty").gt("qty", 0);
  assert.equal(error, null);
  assert.deepEqual(data, [{ id: "a" }]);
  const call = lastCall(sql);
  assert.match(call.text, /"qty" > \$1/);
  assert.deepEqual(call.params, [0]);
});

test("gte, lt and lte emit their own operators", async () => {
  for (const [method, op] of [["gte", ">="], ["lt", "<"], ["lte", "<="]]) {
    const sql = fakeSql([]);
    const sb = pgrestShim(sql);
    await sb.from("inventory_lots").select("id")[method]("qty", 5);
    const call = lastCall(sql);
    assert.match(call.text, new RegExp(`"qty" ${op.replace(/[<>=]/g, (c) => "\\" + c)} \\$1`), `${method} should emit ${op}`);
    assert.deepEqual(call.params, [5]);
  }
});

test("a comparison composes with eq, and both values are parameterised in order", async () => {
  const sql = fakeSql([]);
  const sb = pgrestShim(sql);
  await sb.from("inventory_lots").select("id").eq("company_id", 1).gt("qty", 0);
  const call = lastCall(sql);
  assert.match(call.text, /"company_id" = \$1/);
  assert.match(call.text, /"qty" > \$2/);
  assert.deepEqual(call.params, [1, 0]);
});

test("a comparison on an unsafe identifier is refused, not interpolated", async () => {
  const sql = fakeSql([]);
  const sb = pgrestShim(sql);
  // exec() reports failures the way supabase-js does — as { error }, not a throw
  const { data, error } = await sb.from("inventory_lots").select("id").gt("qty; DROP TABLE x", 0);
  assert.equal(data, null);
  assert.match(error.message, /unsafe identifier/);
  assert.equal(sql.calls.length, 0, "nothing may reach the database");
});

test("an unimplemented method still gaps loudly rather than guessing", async () => {
  const sql = fakeSql([]);
  const sb = pgrestShim(sql);
  assert.throws(
    () => sb.from("inventory_lots").select("id").like("code", "A%"),
    /pgrest-shim GAP/,
  );
});

test("neq emits <> with the value as a parameter", async () => {
  // requeueSkipped's own probe: has this document been queued again since?
  //   .from('autocount_outbox').select('id').eq('doc_no', x).neq('status', 'skipped')
  const sql = fakeSql([{ id: "row-1" }]);
  const sb = pgrestShim(sql);
  const { data, error } = await sb.from("autocount_outbox").select("id")
    .eq("doc_no", "HC-SO-1").neq("status", "skipped");
  assert.equal(error, null);
  assert.deepEqual(data, [{ id: "row-1" }]);
  const call = lastCall(sql);
  assert.match(call.text, /"doc_no" = \$1/);
  assert.match(call.text, /"status" <> \$2/);
  assert.deepEqual(call.params, ["HC-SO-1", "skipped"]);
});

test("neq(col, null) is a loud gap, not a silent match-nothing", async () => {
  // `<> NULL` is NULL for every row, so translating it literally would return
  // an empty set and look like a legitimate answer. PostgREST spells the intent
  // as not(col,'is',null); the shim says so rather than guessing.
  const sql = fakeSql([]);
  const sb = pgrestShim(sql);
  assert.throws(
    () => sb.from("autocount_outbox").select("id").neq("linked_ac_docno", null),
    (e) => /GAP/.test(e.message) && /not\('linked_ac_docno', 'is', null\)/.test(e.message),
  );
  // and nothing was sent
  assert.equal(sql.calls.length, 0);
});

// ── 2026-08-29 growth: upsert (docs/bugs/0562) ───────────────────────────────

test("upsert emits INSERT ... ON CONFLICT (col) DO UPDATE of the other columns", async () => {
  const sql = fakeSql([]);
  const sb = pgrestShim(sql);
  const { error } = await sb.from("stock_allocation_recompute_queue").upsert(
    { job_key: "GLOBAL", request_token: "t-1", requested_at: "2026-08-29", reason: "x" },
    { onConflict: "job_key" },
  );
  assert.equal(error, null);
  const c = lastCall(sql);
  assert.match(c.text, /INSERT INTO "scm"\."stock_allocation_recompute_queue"/);
  assert.match(c.text, /ON CONFLICT \("job_key"\) DO UPDATE SET/);
  assert.match(c.text, /"request_token" = EXCLUDED\."request_token"/);
  assert.ok(!/EXCLUDED\."job_key"/.test(c.text), "the conflict column itself is never overwritten");
});

test("upsert without a safe onConflict is a loud gap, never a silent write", async () => {
  const sql = fakeSql([]);
  const sb = pgrestShim(sql);
  const r = await sb.from("stock_allocation_recompute_queue").upsert({ job_key: "GLOBAL" }, {});
  assert.ok(r.error && /upsert onConflict/.test(r.error.message), `expected a loud gap error, got ${JSON.stringify(r)}`);
  assert.ok(sb.__gaps.some((g) => /upsert onConflict/.test(g)), "the gap is recorded on __gaps");
  assert.equal(sql.calls.length, 0, "and nothing was written");
});

/* ── one-level !inner embeds (docs/bugs/0672) ──────────────────────────────
   These are the two reads recomputeSoStockAllocation has issued since
   24b379034 (#2298) and that the shim refused for three weeks with
   `unsafe identifier "so.status"`. The fake below answers the catalog probe
   the way production's pg_constraint does — mfg_sales_order_items joins its
   header on doc_no, NOT on an id — so a test that passed against an assumed
   `parent_id` convention would fail here. */
function fakeSqlWithCatalog(fkRows, dataRows = []) {
  const calls = [];
  const run = (text, params = []) => {
    if (/pg_constraint/.test(text)) {
      const [, parent, child] = params;
      return Promise.resolve(fkRows.filter((r) =>
        (r.src_table === parent && r.tgt_table === child) || (r.src_table === child && r.tgt_table === parent)));
    }
    calls.push({ text, params });
    return Promise.resolve(dataRows);
  };
  const sql = (strings, ...params) => run(strings.raw ? strings.raw.join("?") : String(strings), params);
  sql.unsafe = (text, params = []) => run(text, params);
  sql.calls = calls;
  return sql;
}

const SO_FKS = [
  { src_table: "mfg_sales_order_items", tgt_table: "mfg_sales_orders", src_col: "doc_no", tgt_col: "doc_no" },
  { src_table: "delivery_order_items", tgt_table: "mfg_sales_order_items", src_col: "so_item_id", tgt_col: "id" },
  { src_table: "purchase_order_items", tgt_table: "mfg_sales_order_items", src_col: "so_item_id", tgt_col: "id" },
];

test("the allocator's DO-line load translates into one parent-grained statement", async () => {
  const sql = fakeSqlWithCatalog(SO_FKS, [{ id: "so-1", so: { status: "OPEN" }, do_items: [{ id: "d1", qty: 2, delivery_order_id: "do-1" }] }]);
  const sb = pgrestShim(sql);
  const { data, error } = await sb
    .from("mfg_sales_order_items")
    .select("id, so:mfg_sales_orders!inner(status), do_items:delivery_order_items!inner(id, qty, delivery_order_id)")
    .eq("cancelled", false)
    .not("so.status", "in", "(CANCELLED,CLOSED)")
    .order("id")
    .range(0, 999);
  assert.equal(error, null, `expected no error, got ${error && error.message}`);
  assert.deepEqual(data[0].do_items, [{ id: "d1", qty: 2, delivery_order_id: "do-1" }]);
  const { text, params } = lastCall(sql);
  // The header embed is an INNER JOIN on the REAL foreign key column.
  assert.match(text, /JOIN "scm"."mfg_sales_orders" "so" ON "so"."doc_no" = "p"."doc_no"/);
  // The DO lines are aggregated, not joined — otherwise .range() would page
  // over joined rows and both repeat and skip parents.
  assert.match(text, /json_agg\(json_build_object\('id', "c_do_items"."id", 'qty', "c_do_items"."qty", 'delivery_order_id', "c_do_items"."delivery_order_id"\)\)/);
  assert.match(text, /EXISTS \(SELECT 1 FROM "scm"."delivery_order_items" "c_do_items" WHERE "c_do_items"."so_item_id" = "p"."id"\)/);
  // The filter that used to be refused is now a column reference on the join.
  assert.match(text, /"so"."status" NOT IN \(\$2, \$3\)/);
  assert.doesNotMatch(text, /"so\.status"/);
  assert.match(text, /ORDER BY "p"."id" ASC LIMIT 1000 OFFSET 0/);
  /* Placeholders ascend across the statement as it reads, so a log line can be
     checked by eye against its parameter array. */
  assert.match(text, /WHERE "p"\."cancelled" = \$1 AND "so"\."status" NOT IN \(\$2, \$3\)/);
  assert.deepEqual(params, [false, "CANCELLED", "CLOSED"]);
});

test("a filter on a to-many embed narrows BOTH the aggregate and the EXISTS", async () => {
  const sql = fakeSqlWithCatalog(SO_FKS, []);
  const sb = pgrestShim(sql);
  const { error } = await sb
    .from("mfg_sales_order_items")
    .select("id, so:mfg_sales_orders!inner(status), po_items:purchase_order_items!inner(qty, received_qty)")
    .eq("cancelled", false)
    .not("so.status", "in", "(CANCELLED)")
    .gt("po_items.received_qty", 0)
    .order("id")
    .range(0, 99);
  assert.equal(error, null, `expected no error, got ${error && error.message}`);
  const { text, params } = lastCall(sql);
  const narrowed = text.match(/"c_po_items"."received_qty" > \$\d+/g) ?? [];
  assert.equal(narrowed.length, 2, `the embed filter must appear in the aggregate AND the EXISTS, saw ${narrowed.length}`);
  // A parent whose only PO line has received nothing must not come back.
  assert.match(text, /EXISTS \(SELECT 1 FROM "scm"."purchase_order_items" "c_po_items" WHERE "c_po_items"."so_item_id" = "p"."id" AND "c_po_items"."received_qty" > \$\d+\)/);
  assert.deepEqual(params, [0, false, "CANCELLED", 0]);
  assert.match(text, /^SELECT .*LIMIT 100 OFFSET 0$/);
});

test("a filter naming an alias select() never declared is a loud gap", async () => {
  const sql = fakeSqlWithCatalog(SO_FKS, []);
  const sb = pgrestShim(sql);
  const { error } = await sb.from("mfg_sales_order_items")
    .select("id, so:mfg_sales_orders!inner(status)")
    .not("header.status", "in", "(CANCELLED)");
  assert.match(String(error?.message), /no embed called "header"/);
  assert.equal(sb.__gaps.length, 1);
});

test("an embed without !inner is refused rather than guessed as a LEFT join", async () => {
  const sql = fakeSqlWithCatalog(SO_FKS, []);
  const sb = pgrestShim(sql);
  const { error } = await sb.from("mfg_sales_order_items").select("id, so:mfg_sales_orders(status)");
  assert.match(String(error?.message), /without !inner/);
  assert.equal(sb.__gaps.length, 1);
});

test("an ambiguous relationship gaps with its count instead of picking a join column", async () => {
  const sql = fakeSqlWithCatalog([
    ...SO_FKS,
    { src_table: "delivery_order_items", tgt_table: "mfg_sales_order_items", src_col: "origin_so_item_id", tgt_col: "id" },
  ], []);
  const sb = pgrestShim(sql);
  const { error } = await sb.from("mfg_sales_order_items")
    .select("id, do_items:delivery_order_items!inner(id)");
  assert.match(String(error?.message), /2 single-column foreign key\(s\)/);
});

test("two levels of embedding are refused", async () => {
  const sql = fakeSqlWithCatalog(SO_FKS, []);
  const sb = pgrestShim(sql);
  const { error } = await sb.from("mfg_sales_order_items")
    .select("id, do_items:delivery_order_items!inner(id, do:delivery_orders!inner(status))");
  assert.match(String(error?.message), /ONE level of embedding/);
});

test("a select with no embed emits exactly the SQL it always did", async () => {
  const sql = fakeSqlWithCatalog(SO_FKS, []);
  const sb = pgrestShim(sql);
  await sb.from("mfg_sales_order_items").select("id, doc_no").eq("cancelled", false).order("id").range(0, 9);
  const { text, params } = lastCall(sql);
  assert.equal(text, 'SELECT "id", "doc_no" FROM "scm"."mfg_sales_order_items" WHERE "cancelled" = $1 ORDER BY "id" ASC LIMIT 10 OFFSET 0');
  assert.deepEqual(params, [false]);
});
