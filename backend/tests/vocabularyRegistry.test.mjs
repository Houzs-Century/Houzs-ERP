/* The vocabulary registry, pinned.

   WHAT THIS SUITE IS FOR, in one line: the registry decides what the guard
   forbids and what the glossary prints, so a wrong entry is worse than no
   registry — it teaches people the wrong word with a machine's authority.

   Two of these tests exist because the FIRST DRAFT OF THE REGISTRY WAS WRONG,
   twice, on the same day it was written:

     1. `proceeded_at` was listed as retired. The column still exists on
        scm.mfg_sales_orders and the diagnostic probes read it on purpose; the
        guard produced 175 findings, essentially all false.
     2. `internalExpectedDd` was listed as retired. It is the PAYLOAD key the
        status route still accepts from old clients on purpose — a different
        thing from the dropped COLUMN that shares its spelling.

   Both were caught by running the guard against the real tree and checking each
   class against production, not by reasoning. The tests below hold those two
   corrections in place. */
import { test } from "vitest";
import assert from "node:assert/strict";

import { VOCABULARY, findRetired, stripComments, isTestPath, isHistoricalPath } from "../scripts/lib/vocabulary.mjs";

const SRC = "backend/src/scm/lib/example.ts";

test("every entry carries the fields the guard and the glossary both read", () => {
  assert.ok(VOCABULARY.length > 0, "an empty registry would make the guard pass over anything");
  for (const e of VOCABULARY) {
    assert.ok(e.concept && typeof e.concept === "string", "concept");
    assert.ok(e.canonical && typeof e.canonical === "string", `${e.concept}: canonical`);
    assert.ok(Array.isArray(e.retired), `${e.concept}: retired`);
    assert.ok(Array.isArray(e.allow), `${e.concept}: allow`);
    assert.ok(e.declaredIn && e.note, `${e.concept}: declaredIn + note`);
    /* A canonical spelling that is also on the retired list would make the
       guard demand you stop using the word it tells you to use. */
    for (const r of e.retired) {
      assert.notEqual(r, e.canonical, `${e.concept}: "${r}" is both canonical and retired`);
      assert.equal((e.alsoCanonical ?? []).includes(r), false, `${e.concept}: "${r}" is both`);
    }
  }
});

test("a retired spelling in CODE is a finding", () => {
  const hits = findRetired('const sql = "SELECT internal_expected_dd FROM t";', SRC);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].term, "internal_expected_dd");
  assert.equal(hits[0].canonical, "processing_date");
});

test("the same spelling in a COMMENT is not", () => {
  assert.deepEqual(findRetired("// internal_expected_dd was dropped by 0286\nconst x = 1;", SRC), []);
  assert.deepEqual(findRetired("/* internal_expected_dd, retired */\nconst x = 1;", SRC), []);
  assert.deepEqual(findRetired("-- internal_expected_dd in SQL prose\nselect 1;", SRC), []);
});

test("REGRESSION: proceeded_at is not retired — the column still exists", () => {
  /* Checked against production 2026-08-18: information_schema still lists
     proceeded_at on scm.mfg_sales_orders. Listing it cost 175 false findings.
     If it is ever genuinely dropped, drop this assertion in the same PR as the
     migration — not before. */
  assert.deepEqual(findRetired("const t = row.proceeded_at;", SRC), []);
});

test("REGRESSION: the internalExpectedDd PAYLOAD key is not retired", () => {
  /* PATCH /:docNo/status still accepts it from old clients, deliberately, and
     says so in a comment beside the type. Only the dropped COLUMN is retired. */
  assert.deepEqual(findRetired("let body: { internalExpectedDd?: string };", SRC), []);
});

test("migrations and tests may name the retired side — that is their job", () => {
  assert.equal(isHistoricalPath("backend/src/db/migrations-pg/0286_x.sql"), true);
  assert.equal(isTestPath("backend/src/scm/shared/so-processing-date.test.ts"), true);
  assert.equal(isTestPath("backend/src/scm/shared/so-processing-date.ts"), false);
  assert.deepEqual(findRetired('q("internal_expected_dd")', "backend/src/db/migrations-pg/0286_x.sql"), []);
  assert.deepEqual(findRetired('q("internal_expected_dd")', "backend/src/scm/a.test.ts"), []);
});

test("the declaration file may spell what it declares", () => {
  const decl = VOCABULARY.find((e) => e.allow.length > 0);
  assert.ok(decl, "at least one entry names the file entitled to spell its retired terms");
  const allowed = decl.allow[0];
  assert.deepEqual(findRetired(`export const X = "${decl.retired[0]}";`, `backend/${allowed}`), []);
});

test("batch-3 concepts are registered with the canonical the owner agreed", () => {
  /* These three were DOCUMENTED-only in the drift catalogue until they were
     registered here. Each is STAGED — nothing retired yet (the physical renames
     need a backfill or a view-guarded drop) — so the assertion is on the
     canonical word and the pointer, which are what the glossary prints and what
     new code is told to use. If a concept is dropped or its canonical is
     changed, this fails on purpose. */
  const byConcept = (needle) =>
    VOCABULARY.find((e) => e.concept.toLowerCase().includes(needle));

  const salesperson = byConcept("salesperson");
  assert.ok(salesperson, "Salesperson concept is registered");
  assert.equal(salesperson.canonical, "salesperson_id");
  assert.deepEqual(salesperson.retired, [], "salesperson retires nothing yet — agent is kept by design");
  assert.equal(salesperson.declaredIn, "backend/src/scm/lib/so-agent.ts");

  const warehouse = byConcept("warehouse");
  assert.ok(warehouse, "Warehouse concept is registered");
  assert.equal(warehouse.canonical, "warehouse_id");
  assert.deepEqual(warehouse.retired, [], "warehouse retires nothing yet — sales_location drop needs a backfill");

  const customerRef = byConcept("customer reference");
  assert.ok(customerRef, "Customer-reference concept is registered");
  /* Owner ruling 2026-08-18 (#2429): `ref` leads, NOT customer_so_no. */
  assert.equal(customerRef.canonical, "ref");
  assert.deepEqual(customerRef.retired, [], "customer-ref retires nothing yet — po_doc_no drop is the 0189 view-grant hazard");
});

test("stripComments keeps line numbers usable", () => {
  const src = "const a = 1;\n// internal_expected_dd\nconst b = 2;";
  assert.equal(stripComments(src).split("\n").length, src.split("\n").length);
});
