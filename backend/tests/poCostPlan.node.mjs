/* Which ERP purchase-order line each AutoCount price lands on.
 *
 * These exist because the first version of stamp-po-line-costs.mjs resolved a
 * price per (PoNo, ItemCode, Desc2) but looked the TARGET up by (PoNo, Desc2),
 * dropping the item code -- and Desc2 does not carry the bed SIZE. Two real
 * production lines took a different size's money:
 *
 *   PO-009826  HOK-DIVAN ONLY (K) RM470.00   -> HOK-DIVAN ONLY (Q) x3
 *   PO-009802  HOK-2041 (A) (SS)  RM641.50   -> HOK-2041 (A) (Q)  x1
 *
 * Both fixtures below are those lines, copied from
 * scripts/data/ac-po-line-costs.json.gz including their DtlKeys and the exact
 * Desc2 typography (curly quotes, doubled apostrophes) that the signature has
 * to fold away. Point the planner at the pre-fix key and the first two tests
 * fail: the queen row appears in `plan` at the king's price.
 *
 * Run by `npm test` through the pretest test:scale-contract target. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planStamps, sig, normCode, SKIP } from "../scripts/lib/po-cost-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, "..", "scripts", "data", "ac-po-line-costs.json.gz");

const CODE_MAP = new Map([
  ["HOK-DIVAN ONLY (Q)", "DIVAN ONLY-(Q)"],
  ["HOK-DIVAN ONLY (K)", "DIVAN ONLY-(K)"],
  ["HOK-2041 (A) (Q)", "ELEGANT (A)-(Q)"],
  ["HOK-2041 (A) (SS)", "ELEGANT (A)-(SS)"],
]);

const acLine = (o) => ({ PoNo: "PO-009826", PoDtlKey: null, ItemCode: "X", Qty: 1, TransferedQty: 0, Desc2: null, ...o });
const erpRow = (o) => ({
  id: "row-1", material_code: "X", supplier_sku: null, description2: null,
  qty: 1, received_qty: 0, linked_ac_dtlkey: null,
  ac_doc: "PO-009826", po_number: "PO-2606-001", ...o,
});
const book = (o = {}) => ({ poLines: [], samePoGr: [], history: [], ...o });

/* ── The divan pair, exactly as production holds it ─────────────────────── */
const DIVAN_D2 = "Divan:10''+No Leg/Col:PC151-01";
const divanBook = book({
  poLines: [
    acLine({ PoDtlKey: 892692, ItemCode: "HOK-DIVAN ONLY (Q)", Qty: 3, Desc2: DIVAN_D2 }),
    acLine({ PoDtlKey: 892694, ItemCode: "HOK-DIVAN ONLY (K)", Qty: 1, Desc2: DIVAN_D2 }),
  ],
  // Only the KING has ever been bought at this build. The queen's own history
  // sits at RM325 median over 152 lines, so RM470 would be +44.6%.
  history: [{ DocDate: "2026-05-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2, UnitPrice: 470 }],
});
const divanRows = [
  erpRow({ id: "erp-q", material_code: "DIVAN ONLY-(Q)", supplier_sku: "HOK-DIVAN ONLY (Q)", description2: DIVAN_D2, qty: 3 }),
  erpRow({ id: "erp-k", material_code: "DIVAN ONLY-(K)", supplier_sku: "HOK-DIVAN ONLY (K)", description2: DIVAN_D2, qty: 1 }),
];

test("the king's price does not land on the queen sharing its Desc2", () => {
  const { plan, skipped } = planStamps({ book: divanBook, erpRows: divanRows, codeMap: CODE_MAP });
  assert.deepEqual(plan.map((p) => p.id), ["erp-k"]);
  assert.equal(plan[0].centi, 47000);
  const q = skipped.find((s) => s.row.id === "erp-q");
  assert.ok(q, "the queen must be reported, not stamped");
  assert.equal(q.reason, SKIP.NO_PRICE);
});

test("the ELEGANT super-single price does not land on the queen either", () => {
  const D2 = "Col:PC151-02/Divan:8+1”leg/Gap:12”";
  const b = book({
    poLines: [
      acLine({ PoNo: "PO-009802", PoDtlKey: 889900, ItemCode: "HOK-2041 (A) (Q)", Desc2: D2 }),
      acLine({ PoNo: "PO-009802", PoDtlKey: 889902, ItemCode: "HOK-2041 (A) (SS)", Desc2: D2 }),
    ],
    history: [{ DocDate: "2026-05-01", ItemCode: "HOK-2041 (A) (SS)", Desc2: D2, UnitPrice: 641.5 }],
  });
  const rows = [
    erpRow({ id: "erp-q", ac_doc: "PO-009802", material_code: "ELEGANT (A)-(Q)", supplier_sku: "HOK-2041 (A) (Q)", description2: D2 }),
    erpRow({ id: "erp-ss", ac_doc: "PO-009802", material_code: "ELEGANT (A)-(SS)", supplier_sku: "HOK-2041 (A) (SS)", description2: D2 }),
  ];
  const { plan, skipped } = planStamps({ book: b, erpRows: rows, codeMap: CODE_MAP });
  assert.deepEqual(plan.map((p) => p.id), ["erp-ss"]);
  assert.equal(plan[0].centi, 64150);
  assert.equal(skipped.find((s) => s.row.id === "erp-q").reason, SKIP.NO_PRICE);
});

test("plan and skipped together account for every ERP row exactly once", () => {
  // The dry-run prints both lists; if they did not partition the rows read, the
  // printed footprint would not be the written footprint -- the defect that
  // made the old log say "LEFT AT ZERO x3" about a line it then stamped.
  const { plan, skipped } = planStamps({ book: divanBook, erpRows: divanRows, codeMap: CODE_MAP });
  const seen = [...plan.map((p) => p.id), ...skipped.map((s) => s.row.id)].sort();
  assert.deepEqual(seen, divanRows.map((r) => r.id).sort());
  assert.equal(new Set(seen).size, seen.length);
});

test("one ERP row wanted at two different prices is refused, not resolved", () => {
  /* Reachable because the mapping CSV is many-to-one: AERO-DIVAN ONLY (K) and
     HOK-DIVAN ONLY (K) both map to ERP DIVAN ONLY-(K). So one ERP row can be
     claimed by its supplier_sku (the HOK line) and by its material_code (the
     AERO line), at two different prices. Whichever arrived last used to win. */
  const D2 = "Col:AB1";
  const b = book({
    poLines: [
      acLine({ PoDtlKey: 1, ItemCode: "HOK-DIVAN ONLY (K)", Desc2: D2 }),
      acLine({ PoDtlKey: 2, ItemCode: "AERO-DIVAN ONLY (K)", Desc2: D2 }),
    ],
    history: [
      { DocDate: "2026-01-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: D2, UnitPrice: 100 },
      { DocDate: "2026-02-01", ItemCode: "AERO-DIVAN ONLY (K)", Desc2: D2, UnitPrice: 900 },
    ],
  });
  const rows = [erpRow({ id: "erp-1", material_code: "DIVAN ONLY-(K)", supplier_sku: "HOK-DIVAN ONLY (K)", description2: D2 })];
  const map = new Map([["HOK-DIVAN ONLY (K)", "DIVAN ONLY-(K)"], ["AERO-DIVAN ONLY (K)", "DIVAN ONLY-(K)"]]);
  const out = planStamps({ book: b, erpRows: rows, codeMap: map });
  assert.equal(out.plan.length, 0, "a contested row must not be written");
  assert.equal(out.skipped[0].reason, SKIP.AMBIGUOUS);
  assert.deepEqual(out.skipped[0].prices, [10000, 90000]);
});

test("the same price proposed by two routes is one agreed write, not a refusal", () => {
  const D2 = "Col:AB1";
  const b = book({
    poLines: [
      acLine({ PoDtlKey: 1, ItemCode: "HOK-DIVAN ONLY (K)", Desc2: D2 }),
      acLine({ PoDtlKey: 2, ItemCode: "AERO-DIVAN ONLY (K)", Desc2: D2 }),
    ],
    history: [
      { DocDate: "2026-01-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: D2, UnitPrice: 470 },
      { DocDate: "2026-02-01", ItemCode: "AERO-DIVAN ONLY (K)", Desc2: D2, UnitPrice: 470 },
    ],
  });
  const rows = [erpRow({ id: "erp-1", material_code: "DIVAN ONLY-(K)", supplier_sku: "HOK-DIVAN ONLY (K)", description2: D2 })];
  const map = new Map([["HOK-DIVAN ONLY (K)", "DIVAN ONLY-(K)"], ["AERO-DIVAN ONLY (K)", "DIVAN ONLY-(K)"]]);
  const { plan, skipped } = planStamps({ book: b, erpRows: rows, codeMap: map });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].centi, 47000);
  assert.equal(skipped.length, 0);
});

test("the same price proposed twice is one write, not two", () => {
  // plan[] used to hold one entry per (AutoCount line x ERP target), so the
  // closing "priced N of M planned" read as a partial failure when M merely
  // double-counted. One entry per ERP id now.
  const D2 = "Col:ZZ";
  const b = book({
    poLines: [acLine({ PoDtlKey: 1, ItemCode: "HOK-7", Desc2: D2 }), acLine({ PoDtlKey: 2, ItemCode: "HOK-7", Desc2: D2 })],
    history: [{ DocDate: "2026-01-01", ItemCode: "HOK-7", Desc2: D2, UnitPrice: 250 }],
  });
  const rows = [erpRow({ id: "erp-1", material_code: "HOK-7", supplier_sku: "HOK-7", description2: D2 })];
  const { plan } = planStamps({ book: b, erpRows: rows, codeMap: new Map() });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].centi, 25000);
});

test("a DtlKey is a 1:1 match and beats the signature", () => {
  const b = book({
    poLines: [acLine({ PoDtlKey: 892694, ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2 })],
    history: [{ DocDate: "2026-05-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2, UnitPrice: 470 }],
  });
  // Desc2 deliberately does NOT match; the key alone must carry it.
  const rows = [erpRow({ id: "erp-k", material_code: "DIVAN ONLY-(K)", supplier_sku: "HOK-DIVAN ONLY (K)", description2: "something else entirely", linked_ac_dtlkey: 892694 })];
  const { plan, stats } = planStamps({ book: b, erpRows: rows, codeMap: CODE_MAP });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].route, "dtlkey");
  assert.equal(stats.matchedByDtlKey, 1);
});

test("a DtlKey pointing at a different item code is refused, never followed", () => {
  const b = book({
    poLines: [acLine({ PoDtlKey: 892694, ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2 })],
    history: [{ DocDate: "2026-05-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2, UnitPrice: 470 }],
  });
  const rows = [erpRow({ id: "erp-q", material_code: "DIVAN ONLY-(Q)", supplier_sku: "HOK-DIVAN ONLY (Q)", description2: DIVAN_D2, linked_ac_dtlkey: 892694 })];
  const { plan, skipped } = planStamps({ book: b, erpRows: rows, codeMap: CODE_MAP });
  assert.equal(plan.length, 0);
  assert.equal(skipped[0].reason, SKIP.CODE_MISMATCH);
});

test("a broken DtlKey vetoes the row — no other route may rescue it", () => {
  // The most exact evidence disagreeing is a reason to stop, not a reason to
  // fall through to weaker evidence that happens to agree with itself.
  const b = book({
    poLines: [
      acLine({ PoDtlKey: 892694, ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2 }),
      acLine({ PoDtlKey: 892692, ItemCode: "HOK-DIVAN ONLY (Q)", Desc2: DIVAN_D2 }),
    ],
    history: [
      { DocDate: "2026-05-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2, UnitPrice: 470 },
      { DocDate: "2026-05-01", ItemCode: "HOK-DIVAN ONLY (Q)", Desc2: DIVAN_D2, UnitPrice: 325 },
    ],
  });
  // erp-q carries the KING's DtlKey (a broken backfill) but its own supplier_sku
  // would otherwise match the queen line at RM325.
  const rows = [erpRow({ id: "erp-q", material_code: "DIVAN ONLY-(Q)", supplier_sku: "HOK-DIVAN ONLY (Q)", description2: DIVAN_D2, linked_ac_dtlkey: 892694 })];
  const { plan, skipped } = planStamps({ book: b, erpRows: rows, codeMap: CODE_MAP });
  assert.equal(plan.length, 0);
  assert.equal(skipped[0].reason, SKIP.CODE_MISMATCH);
});

test("supplier_sku carries a minted sofa SKU the mapping CSV cannot reach", () => {
  const D2 = "1+1(30”Inch)/Col:BO315-31";
  const b = book({
    poLines: [acLine({ ItemCode: "DSL-8051 SOFA", Desc2: D2 })],
    history: [{ DocDate: "2026-01-01", ItemCode: "DSL-8051 SOFA", Desc2: D2, UnitPrice: 1800 }],
  });
  // No CSV entry for this code; the ERP row was minted as SOFA-8051-BO315-31.
  const rows = [erpRow({ id: "erp-s", material_code: "SOFA-8051-BO315-31", supplier_sku: "DSL-8051 SOFA", description2: D2 })];
  const { plan, stats } = planStamps({ book: b, erpRows: rows, codeMap: new Map() });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].route, "supplier_sku+desc2");
  assert.equal(stats.matchedBySupplierSku, 1);
});

test("an ERP row no AutoCount line reaches keeps its zero and is reported", () => {
  const rows = [erpRow({ id: "erp-orphan", material_code: "DIVAN ONLY-(S)", supplier_sku: "HOK-DIVAN ONLY (S)", description2: "Col:NOPE" })];
  const { plan, skipped } = planStamps({ book: divanBook, erpRows: rows, codeMap: CODE_MAP });
  assert.equal(plan.length, 0);
  assert.equal(skipped[0].reason, SKIP.NO_AC_LINE);
});

test("a closed AutoCount line is not a source of price for anything", () => {
  const b = book({
    poLines: [acLine({ ItemCode: "HOK-DIVAN ONLY (K)", Qty: 1, TransferedQty: 1, Desc2: DIVAN_D2 })],
    history: [{ DocDate: "2026-05-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2, UnitPrice: 470 }],
  });
  const rows = [erpRow({ id: "erp-k", material_code: "DIVAN ONLY-(K)", supplier_sku: "HOK-DIVAN ONLY (K)", description2: DIVAN_D2 })];
  const { plan, skipped } = planStamps({ book: b, erpRows: rows, codeMap: CODE_MAP });
  assert.equal(plan.length, 0);
  assert.equal(skipped[0].reason, SKIP.NO_AC_LINE);
});

test("the Desc2 signature still folds curly quotes and doubled apostrophes", () => {
  const b = book({
    poLines: [acLine({ ItemCode: "HOK-DIVAN ONLY (K)", Desc2: "Divan:10''+No Leg/Col:PC151-01" })],
    history: [{ DocDate: "2026-05-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: "Divan:10”+No  Leg/Col:PC151-01", UnitPrice: 470 }],
  });
  const rows = [erpRow({ id: "erp-k", material_code: "DIVAN ONLY-(K)", supplier_sku: "HOK-DIVAN ONLY (K)", description2: "divan:10” + no leg / col:pc151-01" })];
  const { plan } = planStamps({ book: b, erpRows: rows, codeMap: CODE_MAP });
  assert.equal(plan.length, 1, "the same physical build keyed by two typists must still match");
  assert.equal(plan[0].centi, 47000);
});

/* ── The collision, measured on the REAL committed snapshot ────────────────
   The fixtures above are hand-built, so on their own they only prove the rule
   is implemented — not that it MATTERS. This one reads the same
   scripts/data/ac-po-line-costs.json.gz the script reads and counts the
   collision in production data, so the claim "dropping the item code lets one
   size's price land on another" is re-measured by CI on every run instead of
   being a number somebody once computed offline in a review comment. */
const snapshot = () =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT)).toString("utf8").replace(/^﻿/, ""));

test("the pre-fix key really does merge different item codes, on real data", () => {
  const open = snapshot().poLines.filter((l) => Number(l.Qty) - Number(l.TransferedQty ?? 0) > 0);
  assert.ok(open.length > 0, "the snapshot must carry open lines or this proves nothing");

  const preFix = new Map(); // what the first version keyed on: document + Desc2
  const postFix = new Set(); // what it keys on now: document + ITEM CODE + Desc2
  for (const l of open) {
    const k = `${l.PoNo}|${sig(l.Desc2)}`;
    if (!preFix.has(k)) preFix.set(k, new Set());
    preFix.get(k).add(normCode(l.ItemCode));
    postFix.add(`${l.PoNo}|${normCode(l.ItemCode)}|${sig(l.Desc2)}`);
  }
  const merged = [...preFix.values()].filter((codes) => codes.size > 1);
  assert.ok(
    merged.length > 0,
    "if this ever reaches zero the snapshot changed; re-derive the footprint before trusting the old one",
  );

  /* Every merged group is a pair of DIFFERENT item codes sharing one Desc2 —
     i.e. a bed size the pre-fix key could not tell apart. The post-fix key
     separates them, so it must have strictly more distinct keys. */
  assert.ok(postFix.size > preFix.size, "the item code must split at least one key apart");

  /* The two lines the reviewer caught being mis-stamped must be among them. */
  const codesFor = (po) => {
    const hit = [...preFix.entries()].filter(([k]) => k.startsWith(`${po}|`)).map(([, v]) => [...v]);
    return hit.flat();
  };
  const divan = codesFor("PO-009826");
  assert.ok(divan.includes("HOK-DIVAN ONLY (Q)") && divan.includes("HOK-DIVAN ONLY (K)"),
    "PO-009826 must still show the queen and the king sharing a Desc2");
  const elegant = codesFor("PO-009802");
  assert.ok(elegant.includes("HOK-2041 (A) (Q)") && elegant.includes("HOK-2041 (A) (SS)"),
    "PO-009802 must still show the queen and the super-single sharing a Desc2");
});

test("qty on the plan is the OPEN quantity, so the reported value is the exposure", () => {
  const b = book({
    poLines: [acLine({ ItemCode: "HOK-DIVAN ONLY (K)", Qty: 5, TransferedQty: 2, Desc2: DIVAN_D2 })],
    history: [{ DocDate: "2026-05-01", ItemCode: "HOK-DIVAN ONLY (K)", Desc2: DIVAN_D2, UnitPrice: 470 }],
  });
  const rows = [erpRow({ id: "erp-k", material_code: "DIVAN ONLY-(K)", supplier_sku: "HOK-DIVAN ONLY (K)", description2: DIVAN_D2, qty: 5, received_qty: 2 })];
  const { plan } = planStamps({ book: b, erpRows: rows, codeMap: CODE_MAP });
  assert.equal(plan[0].qty, 3);
});

/* ── The log and the writer must consume ONE list ──────────────────────────
   The tests above prove the DECISION is right. This one proves the SCRIPT
   cannot misreport it, which is a separate failure and the one that actually
   shipped: the first version printed a narrative walked from the AutoCount
   lines while APPLY walked a plan built from a different key, so the dry-run
   said "LEFT AT ZERO ... x3" about the very lines it then stamped at RM2,051.50.
   A reviewer who reads a dry-run is trusting that the printed footprint IS the
   written footprint, and nothing in the partition test above can catch a script
   that prints one list and writes another.

   Asserted against the script SOURCE because the script's own main() opens a
   database connection on import and cannot be exercised in this harness. That
   makes these assertions structural, and they are deliberately narrow: they
   pin the traversal, not the wording. */
const STAMP = path.join(HERE, "..", "scripts", "stamp-po-line-costs.mjs");
const stampSrc = () => fs.readFileSync(STAMP, "utf8");

test("the dry-run's printed list and APPLY's written list are the same array", () => {
  const src = stampSrc();
  // Exactly two traversals of `plan`: the one that prints and the one that writes.
  const loops = src.match(/for \(const p of plan\) \{/g) ?? [];
  assert.equal(loops.length, 2,
    "expected exactly two `for (const p of plan) {` blocks — one printing the planned " +
    "writes, one performing them. A third traversal, or a loop over anything else, is " +
    "how the log and the write drift apart.");

  // The printing loop is the one introduced by the "planned writes" banner.
  const banner = src.indexOf("-- planned writes");
  assert.ok(banner > 0, "the dry-run must announce its planned-writes list");
  const afterBanner = src.slice(banner);
  assert.ok(/^[^\n]*\n\s*for \(const p of plan\) \{/.test(afterBanner),
    "the planned-writes banner must be immediately followed by the traversal of `plan`");

  // There is exactly one write, and it sits inside a `plan` traversal.
  const updates = src.match(/UPDATE scm\.\w+/g) ?? [];
  assert.deepEqual(updates, ["UPDATE scm.purchase_order_items"],
    "the script must contain exactly one UPDATE, against purchase_order_items");
  const writeLoop = src.lastIndexOf("for (const p of plan) {");
  assert.ok(writeLoop < src.indexOf("UPDATE scm.purchase_order_items"),
    "the UPDATE must sit inside the final `plan` traversal, not in a loop of its own");
});

test("the script never re-walks the AutoCount lines to narrate an outcome", () => {
  /* The original contradiction came from the script counting `unmatchedUnits`
     while walking `book.poLines` itself. That traversal now belongs to
     po-cost-plan.mjs, which returns `plan` and `skipped`; the script's job is to
     print them and write one of them. If a loop over the AutoCount evidence ever
     reappears here, the two views of the run can disagree again. */
  const src = stampSrc();
  const body = src.slice(src.indexOf("async function main()"));
  assert.ok(!/for \(const \w+ of book\./.test(body),
    "the script must not iterate the AutoCount snapshot — the plan module owns that walk");
  assert.ok(!/unmatchedUnits/.test(src),
    "`unmatchedUnits` was the counter that produced the false LEFT AT ZERO line");
});

test("every reported bucket comes from `plan` or `skipped`, never a third tally", () => {
  const src = stampSrc();
  const body = src.slice(src.indexOf("async function main()"));
  /* Each iteration inside main() must draw from the partition APPLY acts on —
     `plan`, `skipped`, or a grouping derived from them (`tiers`, `byReason`,
     and the `list` those yield). An iteration over anything else is a third
     tally, and a third tally is free to disagree with both. */
  const sources = [...body.matchAll(/for \(const (?:\w+|\[[^\]]+\]) of ([^)]*?)\)\s*\{/g)]
    .map((m) => m[1].trim());
  assert.ok(sources.length > 0, "no iterations found in main() — the regex stopped matching");
  const strays = sources.filter((expr) => !/\b(plan|skipped|tiers|byReason)\b/.test(expr));
  assert.deepEqual(strays, [],
    `main() iterates ${JSON.stringify(strays)}; every printed number must be derived from ` +
    "the same `plan`/`skipped` partition APPLY acts on");
});
