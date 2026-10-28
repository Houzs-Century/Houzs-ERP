/**
 * node --test backend/scripts/lib/ac-header-fields.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout.
 *
 * NO SHEBANG — a test-imported module must not carry one (CLAUDE.md).
 *
 * Each test below pins a rule that has already been paid for once. They are not
 * coverage: they are the regressions this lane exists to avoid re-introducing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PO_HEADER_FIELDS,
  SALESLOC,
  SO_HEADER_FIELDS,
  compareField,
  flat,
  headerAuditNeedles,
  salesLoc,
  writeValue,
} from "./ac-header-fields.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("the human veto NEVER contains a version test", () => {
  /* PR #3042's probe measured 80 of 81 sync-ac-delta "conflicts" as the
     automated stock-allocation sweep and exactly 1 as a person. `version` is an
     optimistic-locking token bumped by seven automated paths; using it as an
     authorship test refuses the owner's data on a robot's behalf. */
  const needles = headerAuditNeedles(SO_HEADER_FIELDS).join(" ").toLowerCase();
  assert.ok(!needles.includes("version"), "version must not be an authorship needle");
  assert.ok(!needles.includes("revision"), "revision must not be an authorship needle either");
});

test("every field with an ERP column contributes its own veto needle", () => {
  const needles = new Set(headerAuditNeedles(SO_HEADER_FIELDS));
  for (const f of SO_HEADER_FIELDS) {
    if (!f.erp) continue;
    assert.ok(needles.has(`%${f.erp}%`), `no veto needle for ${f.erp}`);
  }
});

test("COPY NEVER COMPUTE: a blank book value never proposes a write", () => {
  const f = { key: "note", book: "UDF_Note", erp: "note", kind: "copy" };
  assert.equal(compareField(f, null, "something the ERP holds").verdict, "bookBlank");
  assert.equal(compareField(f, "   ", "something the ERP holds").verdict, "bookBlank");
  assert.equal(compareField(f, null, null).verdict, "bothBlank");
});

test("the ERP holding blank while the book has a value is its own verdict", () => {
  const f = { key: "branding", book: "UDF_BRANDING", erp: "branding", kind: "copy" };
  assert.equal(compareField(f, "HOUZS", null).verdict, "erpBlank");
  assert.equal(compareField(f, "HOUZS", "HOUZS").verdict, "agree");
  assert.equal(compareField(f, "HOUZS", "HOUZ").verdict, "differ");
});

test("a curly quote or a doubled space is the export round trip, not an edit", () => {
  const f = { key: "debtor_name", book: "DebtorName", erp: "debtor_name", kind: "copy" };
  assert.equal(compareField(f, "O’Brien  Sdn  Bhd", "O'Brien Sdn Bhd").verdict, "agree");
  assert.equal(flat("a‘b“c  d "), "a'b\"c d");
});

test("a date compares by day, whatever shape the driver returned", () => {
  const f = { key: "so_date", book: "DocDate", erp: "so_date", kind: "copy", cmp: "date" };
  assert.equal(compareField(f, "2026-08-05 00:00:00", "2026-08-05").verdict, "agree");
  assert.equal(compareField(f, new Date("2026-08-05T00:00:00Z"), "2026-08-05").verdict, "agree");
  assert.equal(compareField(f, "2026-08-06 00:00:00", "2026-08-05").verdict, "differ");
});

test("money compares in sen, so RM 1500.00 is not a difference from 150000", () => {
  const f = { key: "balance_sen", book: "UDF_BALANCE", erp: "balance_sen", kind: "money", cmp: "sen" };
  assert.equal(compareField(f, "1500.00", "150000").verdict, "agree");
  assert.equal(compareField(f, 1500, 150000).verdict, "agree");
  assert.equal(compareField(f, "1500.01", "150000").verdict, "differ");
});

test("writeValue stores the BOOK's own text, never the flattened comparison form", () => {
  /* `flat()` exists to compare. Writing the flattened text would replace
     AutoCount's own spacing with ours — a change we invented, which is exactly
     what migration-copy-never-compute forbids. */
  const f = { key: "address1", book: "InvAddr1", erp: "address1", kind: "copy" };
  assert.equal(writeValue(f, "NO 12,  JALAN  SS2/24"), "NO 12,  JALAN  SS2/24");
  assert.equal(writeValue(f, "   "), null);
});

test("sales_location is written through the SAME map the insert used", () => {
  const f = SO_HEADER_FIELDS.find((x) => x.key === "sales_location");
  assert.equal(writeValue(f, "kl"), "KL WAREHOUSE");
  assert.equal(compareField(f, "KL", "KL WAREHOUSE").verdict, "agree");
  // an unmapped code passes through trimmed, never guessed at
  assert.equal(salesLoc("  MELAKA "), "MELAKA");
});

test("the SALESLOC map still matches the importer that used to own it", () => {
  /* The map was MOVED out of import-ac-outstanding-so.mjs so the insert and the
     update resolve this column identically. If somebody re-adds a local copy
     there, this fails rather than letting the two drift. */
  const src = readFileSync(join(here, "..", "import-ac-outstanding-so.mjs"), "utf8");
  assert.ok(/from "\.\/lib\/ac-header-fields\.mjs"/.test(src),
    "the SO importer must import SALESLOC from the shared map");
  assert.ok(!/^const SALESLOC = \{/m.test(src),
    "the SO importer must not hold its own copy of SALESLOC");
  assert.equal(SALESLOC.KL, "KL WAREHOUSE");
  assert.equal(SALESLOC.JB, "KL WAREHOUSE");
});

test("no field is writable unless it is a straight copy into a real column", () => {
  for (const f of [...SO_HEADER_FIELDS, ...PO_HEADER_FIELDS]) {
    if (f.kind !== "copy") continue;
    if (f.erp === null) {
      assert.ok(/^\(/.test(f.key), `a no-column field must be labelled as one: ${f.key}`);
      assert.ok(f.why, `a no-column field must say why: ${f.key}`);
    }
  }
  // every derived field carries the reason it is not copied
  for (const f of [...SO_HEADER_FIELDS, ...PO_HEADER_FIELDS]) {
    if (f.kind === "derive") assert.ok(f.why, `a derived field must say what derived it: ${f.key}`);
  }
});

test("the headline case is in the map: SalesAgent reaches BOTH ERP homes", () => {
  const keys = SO_HEADER_FIELDS.filter((f) => f.book === "SalesAgent").map((f) => f.erp);
  assert.deepEqual(keys.sort(), ["agent", "salesperson_id"]);
});

test("the four fields the owner ruled in each name a real ERP column AND its migration", () => {
  /* 2026-09-07,「四个都加」. These were NOT_CARRIED — the book held the column and
     no importer named an ERP one — so 2,912 measured book values had nowhere to
     land. If somebody sets one of them back to `erp: null`, or adds the column
     to the map without shipping the migration that creates it, this fails. */
  const MIG = "20260907T1026";
  const want = {
    attention: "Attention",
    delivery_address1: "DeliverAddr1",
    delivery_address2: "DeliverAddr2",
    delivery_address3: "DeliverAddr3",
    delivery_address4: "DeliverAddr4",
    display_term: "DisplayTerm",
    ac_to_po_no: "UDF_ToPONo",
  };
  for (const [key, book] of Object.entries(want)) {
    const f = SO_HEADER_FIELDS.find((x) => x.key === key);
    assert.ok(f, `SO_HEADER_FIELDS lost ${key}`);
    assert.equal(f.erp, key, `${key} must name its own ERP column`);
    assert.equal(f.book, book);
    assert.equal(f.kind, "copy", `${key} is a straight copy of the book's own text`);
    assert.ok(f.why.includes(MIG), `${key} must cite the migration that created its column`);
  }
  for (const key of ["attention", "display_term"]) {
    const f = PO_HEADER_FIELDS.find((x) => x.key === key);
    assert.ok(f && f.erp === key && f.kind === "copy", `PO ${key} must be a copy into its own column`);
    assert.ok(f.why.includes(MIG));
  }
});

test("ac_to_po_no is NOT named after a customer PO", () => {
  /* Measured on ac-doc-headers.json.gz (2026-09-07): 7,068 of the 7,071 filled
     UDF_ToPONo values begin "PO-" — they are the purchase orders AutoCount
     raised FROM the order, going OUT to a supplier. The repo has already dropped
     four dead `customer_po*` columns once (0312); a column named for the wrong
     direction is how that happens again. */
  const f = SO_HEADER_FIELDS.find((x) => x.book === "UDF_ToPONo");
  assert.equal(f.erp, "ac_to_po_no");
  assert.ok(!/customer/i.test(f.erp), "ToPONo is not the customer's PO number");
  assert.match(f.why, /NOT a customer PO number/);
});

test("a blank in the book never overwrites a value in the ERP, on the new fields too", () => {
  /* The owner's rule of the same day, 2026-09-07:「保留 ERP 的价钱 — 空白不覆盖」.
     It is the mirror of copy-never-compute and it binds every field, not only
     the money ones the ruling was made about. */
  for (const key of ["delivery_address1", "display_term", "attention", "ac_to_po_no"]) {
    const f = SO_HEADER_FIELDS.find((x) => x.key === key);
    assert.equal(compareField(f, null, "what the ERP already holds").verdict, "bookBlank");
    assert.equal(compareField(f, "   ", "what the ERP already holds").verdict, "bookBlank");
    assert.equal(compareField(f, "BOOK VALUE", null).verdict, "erpBlank");
  }
});

test("a resolve field is never compared as text", () => {
  /* salesperson_id holds a uuid whose source is a NAME. Comparing the two would
     report every order as differing; the lane counts presence instead. */
  const f = SO_HEADER_FIELDS.find((x) => x.key === "salesperson_id");
  assert.equal(f.kind, "resolve");
  assert.equal(SO_HEADER_FIELDS.find((x) => x.key === "venue_id").kind, "resolve");
});
