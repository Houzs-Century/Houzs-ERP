/**
 * The cause split behind the sales-order purchase counter.
 *
 * Every case here is a row shape that has to be told apart from another row
 * shape it looks exactly like in the counter — which is the whole reason this
 * module exists. A sweep that treated them alike would overwrite the rows that
 * were already right.
 *
 * NO SHEBANG on the module under test — see its header.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CHILD_CAUSES, GROUP_CAUSES, IS_BY_DESIGN, IS_COUNTED, IS_LINK_GAP,
  causeForChild, causeForGroup, runSelfTest, selfTestCases, groupSelfTestCases, tallyCauses,
} from "../scripts/lib/so-po-counter-cause.mjs";

test("the classifier passes its own planted cases — the runner refuses if it does not", () => {
  assert.deepEqual(runSelfTest(), []);
});

test("every planted case is driven through the SAME function the runner calls", () => {
  for (const c of selfTestCases()) assert.equal(causeForChild(c.c), c.want, c.name);
  for (const c of groupSelfTestCases()) assert.equal(causeForGroup(c.kids).cause, c.want, c.name);
});

test("a defect and a decision are told apart, not summed", () => {
  const linked = {
    erpHasPoDoc: true, erpHasPoLine: true, erpPoStatus: "SENT",
    erpFromMrp: false, erpSoLineKey: "884412", bookSoLineKey: "884412",
  };
  /* Same counter reading on both. Only the cause differs, and only one is work. */
  assert.equal(causeForGroup([linked]).cause, "counter_stale");
  assert.equal(causeForGroup([{ ...linked, erpFromMrp: true }]).cause, "from_mrp");
  assert.ok(!IS_BY_DESIGN.has("counter_stale"));
  assert.ok(IS_BY_DESIGN.has("from_mrp"));
});

test("a mixed group is NEVER reported as one of its causes", () => {
  const base = {
    erpHasPoDoc: true, erpHasPoLine: true, erpPoStatus: "SENT",
    erpFromMrp: false, erpSoLineKey: "884412", bookSoLineKey: "884412",
  };
  const g = causeForGroup([
    { ...base, erpHasPoDoc: false },
    { ...base, erpFromMrp: true },
  ]);
  assert.equal(g.cause, "mixed");
  assert.deepEqual(g.children, ["po_doc_absent", "from_mrp"]);
});

test("the three cause classes partition, so nothing is counted twice", () => {
  for (const v of CHILD_CAUSES) {
    const n = [IS_COUNTED, IS_BY_DESIGN, IS_LINK_GAP].filter((s) => s.has(v)).length;
    assert.equal(n, 1, `${v} must belong to exactly one class`);
  }
});

test("every group cause is declared, so a tally cannot grow a column nobody named", () => {
  const t = tallyCauses([[], [{ erpHasPoDoc: false }]]);
  for (const k of Object.keys(t)) assert.ok(GROUP_CAUSES.includes(k), `${k} is not declared`);
  assert.equal(t.book_names_no_child, 1);
  assert.equal(t.po_doc_absent, 1);
});
