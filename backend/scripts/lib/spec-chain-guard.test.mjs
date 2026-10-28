/**
 * node --test backend/scripts/lib/spec-chain-guard.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout.
 *
 * WHAT THIS PINS. Both refusals were bought on production data, hours apart, by
 * reading the write path before running anything (docs/bugs/0844). Neither
 * produced a visible symptom — that is precisely why they need a test: a wrong
 * stock key looks exactly like a right one to anything that only counts rows.
 *
 * The SPLIT case is transcribed from the real document: HC-SO-010183 carries two
 * CODY-(Q) beds with the same divan, gap and colour, one drawer left and one
 * right.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyPlans, idsOfPlan, ledgerRowsOf, untouchableOf } from "./spec-chain-guard.mjs";

const rows = (over = {}) => ({ lots: 0, movements: 0, consumptions: 0, untouchable: 0, ...over });
const bucket = (over = {}) => ({
  itemCode: "CODY-(Q)", grp: "bedframe", oldKey: "OLD", newKey: "NEW", rows: rows(), ...over,
});
const plan = (over = {}) => ({
  doc: "HC-SO-000001", soItemId: "so1", pos: [{ id: "po1" }], grn: [{ id: "gr1" }],
  doRows: [{ id: "do1" }], pinv: [], sinv: [], buckets: [bucket()], ...over,
});
const noConsumers = async () => [];

test("a bucket with no ledger rows is always writable - nothing can be stranded", async () => {
  const { writable, refused } = await classifyPlans([plan()], async () => {
    throw new Error("consumersOf must not be asked about an empty bucket");
  });
  assert.equal(writable.length, 1);
  assert.equal(refused.length, 0);
});

test("a bucket reached by a document OUTSIDE the chain is refused and names it", async () => {
  const p = plan({ buckets: [bucket({ rows: rows({ lots: 2 }) })] });
  const { writable, refused } = await classifyPlans([p],
    async () => [{ doc: "HC-SO-009999", id: "stranger" }]);
  assert.equal(writable.length, 0);
  assert.equal(refused.length, 1);
  assert.match(refused[0].why, /shared with 1 line\(s\) outside this chain/);
  assert.match(refused[0].why, /HC-SO-009999/);
});

test("a bucket reached ONLY by the chain's own lines is writable", async () => {
  const p = plan({ buckets: [bucket({ rows: rows({ movements: 5 }) })] });
  const { writable, refused } = await classifyPlans([p], async () => [
    { doc: "HC-SO-000001", id: "po1" },
    { doc: "HC-SO-000001", id: "gr1" },
    { doc: "HC-SO-000001", id: "do1" },
    { doc: "HC-SO-000001", id: "so1" },
  ]);
  assert.equal(refused.length, 0, refused[0]?.why);
  assert.equal(writable.length, 1);
});

test("ONE BUCKET, TWO ANSWERS: both chains are refused, never one written first", async () => {
  /* HC-SO-010183: two CODY-(Q), same divan/gap/colour, one drawer left one right. */
  const left = plan({
    doc: "HC-SO-010183", soItemId: "soL", pos: [{ id: "poL" }], grn: [{ id: "grL" }], doRows: [],
    buckets: [bucket({ newKey: "NEW-LEFT", rows: rows({ lots: 1 }) })],
  });
  const right = plan({
    doc: "HC-SO-010183", soItemId: "soR", pos: [{ id: "poR" }], grn: [{ id: "grR" }], doRows: [],
    buckets: [bucket({ newKey: "NEW-RIGHT", rows: rows({ lots: 1 }) })],
  });
  const { writable, refused } = await classifyPlans([left, right], noConsumers);
  assert.equal(writable.length, 0, "neither may be written - the first would move every lot");
  assert.equal(refused.length, 2);
  for (const r of refused) assert.match(r.why, /SPLIT one stock bucket into 2/);
});

test("two chains sharing a bucket but agreeing on the new key are BOTH writable", async () => {
  const a = plan({ doc: "A", soItemId: "soA", pos: [{ id: "poA" }], grn: [], doRows: [],
    buckets: [bucket({ rows: rows({ lots: 1 }) })] });
  const b = plan({ doc: "B", soItemId: "soB", pos: [{ id: "poB" }], grn: [], doRows: [],
    buckets: [bucket({ rows: rows({ lots: 1 }) })] });
  const { writable, refused } = await classifyPlans([a, b], async () => [
    { doc: "A", id: "poA" }, { doc: "B", id: "poB" }, { doc: "A", id: "soA" }, { doc: "B", id: "soB" },
  ]);
  assert.equal(refused.length, 0, refused[0]?.why);
  assert.equal(writable.length, 2);
});

test("rack / stock-take / transfer rows refuse before anything else is even asked", async () => {
  const p = plan({ buckets: [bucket({ rows: rows({ lots: 9, untouchable: 3 }) })] });
  const { refused } = await classifyPlans([p], async () => {
    throw new Error("consumersOf must not be asked once the bucket is untouchable");
  });
  assert.equal(refused.length, 1);
  assert.match(refused[0].why, /3 row\(s\) in rack \/ stock-take \/ transfer/);
});

test("a refusal on ANY bucket refuses the whole chain, not just that bucket", async () => {
  const p = plan({
    buckets: [
      bucket({ itemCode: "SAFE", rows: rows() }),
      bucket({ itemCode: "SHARED", rows: rows({ lots: 1 }) }),
    ],
  });
  const { writable, refused } = await classifyPlans([p],
    async () => [{ doc: "HC-SO-008888", id: "stranger" }]);
  assert.equal(writable.length, 0);
  assert.match(refused[0].why, /SHARED/);
});

test("idsOfPlan accepts both the row shape and the bare-id shape", () => {
  const ids = idsOfPlan({ soItemId: "so", pos: [{ id: "po" }], grn: [{ id: "gr" }], dos: ["do"], pinv: ["pi"], sinv: ["si"] });
  assert.deepEqual([...ids].sort(), ["do", "gr", "pi", "po", "si", "so"]);
});

test("idsOfPlan prefers doRows when both are present, and drops empties", () => {
  const ids = idsOfPlan({ soItemId: null, pos: [], grn: [], doRows: [{ id: "d1" }], dos: ["d1"], pinv: [], sinv: [] });
  assert.deepEqual([...ids], ["d1"]);
});

test("the row counters add the three ledger tables and keep untouchable apart", () => {
  const b = bucket({ rows: rows({ lots: 1, movements: 2, consumptions: 3, untouchable: 4 }) });
  assert.equal(ledgerRowsOf(b), 6);
  assert.equal(untouchableOf(b), 4);
});
