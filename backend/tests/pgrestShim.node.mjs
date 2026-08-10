// The shim's own rule: "the day a canonical function needs one, the gap list
// names it and the shim grows a TESTED method." These are those tests.
//
// The shim builds SQL text, so it is tested by handing it a fake tagged-template
// client that records what it was asked to run. No database is involved.
import test from "node:test";
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
