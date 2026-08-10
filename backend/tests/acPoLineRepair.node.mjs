// Guards for the three things the cutover lost on a migrated purchase-order
// line: the delivery date, the SO dedication, and the AutoCount line key.
//
// RUN IT WITH (from backend/):
//   node --test tests/acPoLineRepair.node.mjs
// Wired into `npm run test:scale-contract`, which is `pretest`, so it runs on
// every CI backend job.
//
// NO DEPENDENCIES: node:test / node:assert plus node:zlib to read the committed
// snapshots. The snapshot tests are the point — the bug was that an importer
// read a key the export does not have, and no unit test with a hand-written
// fixture would ever have noticed, because the fixture would have carried
// whatever key the test author typed.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  AC_PO_DELIVERY_DATE_KEYS,
  acDeliveryDate,
  acDtlKey,
  acFromSoDtlKey,
  isoDate,
  mergeAcPoLines,
} from "../scripts/lib/ac-po-line.mjs";
import { makeSoLineTaker } from "../scripts/lib/so-line-dedication.mjs";
import { matchAcLinesToErpRows } from "../scripts/lib/ac-po-line-match.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const gz = (f) =>
  JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(here, "..", "scripts", "data", f)))
      .toString("utf8")
      .replace(/^﻿/, ""),
  );

const OUTSTANDING = gz("ac-outstanding-po.json.gz");
const SO_LINKED = gz("ac-so-linked-pos.json.gz");

// ── the key rename, against the real exports ────────────────────────────────
// This is the guard. Revert acDeliveryDate to read only `DelivDate` — the name
// import-ac-outstanding-po.mjs used — and this fails 338 + 579 times.

test("every AutoCount PO line in the committed exports yields a delivery date", () => {
  for (const [name, rows] of [["ac-outstanding-po", OUTSTANDING], ["ac-so-linked-pos", SO_LINKED]]) {
    const blank = rows.filter((r) => acDeliveryDate(r) === null);
    assert.equal(
      blank.length,
      0,
      `${name}: ${blank.length} of ${rows.length} lines read as having no delivery date. ` +
        `The export's key is one of ${AC_PO_DELIVERY_DATE_KEYS.join(" / ")}; ` +
        `this file carries ${JSON.stringify(Object.keys(rows[0] ?? {}))}.`,
    );
  }
});

test("the re-cut export dropped DelivDate entirely, which is why reading it silently produced NULLs", () => {
  // Pins the fact the bug turned on: not a wrong value, an absent key.
  for (const rows of [OUTSTANDING, SO_LINKED]) {
    assert.equal(rows.filter((r) => "DelivDate" in r).length, 0);
    assert.equal(rows.filter((r) => "DeliveryDate" in r).length, rows.length);
  }
});

test("acDeliveryDate normalises to YYYY-MM-DD and refuses anything else", () => {
  assert.equal(acDeliveryDate({ DeliveryDate: "2026-08-15 00:00:00" }), "2026-08-15");
  assert.equal(acDeliveryDate({ DelivDate: "2024-05-21 00:00:00" }), "2024-05-21");
  assert.equal(acDeliveryDate({ DeliveryDate: "" }), null);
  assert.equal(acDeliveryDate({ DeliveryDate: null }), null);
  assert.equal(acDeliveryDate({}), null);
  assert.equal(acDeliveryDate({ DeliveryDate: "15/08/2026" }), null);
});

test("isoDate survives the JS Date the postgres driver returns for a date column", () => {
  // String(new Date(...)).slice(0, 10) is "Tue Mar 25" — sorts wrong, and no
  // date column accepts it. The header ETA is picked by sorting these.
  assert.equal(String(new Date("2003-03-25T00:00:00Z")).slice(0, 10), "Tue Mar 25");
  assert.equal(isoDate(new Date("2003-03-25T00:00:00Z")), "2003-03-25");
  assert.equal(isoDate("2026-08-15 00:00:00"), "2026-08-15");
  assert.equal(isoDate(new Date("nonsense")), null);
  assert.equal(isoDate("Tue Mar 25 2003"), null);
  assert.equal(isoDate(null), null);
  // and the sort the header fill depends on is only correct in this shape
  assert.deepEqual(
    [new Date("2026-08-15T00:00:00Z"), new Date("2003-03-25T00:00:00Z")].map(isoDate).sort(),
    ["2003-03-25", "2026-08-15"],
  );
});

test("DtlKey identifies a PODTL row, so it de-duplicates the two overlapping exports", () => {
  const merged = mergeAcPoLines(SO_LINKED, OUTSTANDING);
  assert.equal(merged.size, new Set([...SO_LINKED, ...OUTSTANDING].map((r) => Number(r.DtlKey))).size);
  assert.ok(merged.size < SO_LINKED.length + OUTSTANDING.length, "the exports must actually overlap");
  // earlier argument wins
  const first = SO_LINKED[0];
  assert.equal(merged.get(Number(first.DtlKey)), first);
  for (const l of merged.values()) assert.equal(typeof acDtlKey(l), "number");
});

test("FromSODtlKey reads as absent when AutoCount stores 0 or nothing", () => {
  assert.equal(acFromSoDtlKey({ FromSODtlKey: 773519 }), "773519");
  assert.equal(acFromSoDtlKey({ FromSODtlKey: 0 }), null);
  assert.equal(acFromSoDtlKey({ FromSODtlKey: "" }), null);
  assert.equal(acFromSoDtlKey({}), null);
  // The real export: a PO raised from nothing is normal, an unreadable one is not.
  const merged = [...mergeAcPoLines(SO_LINKED, OUTSTANDING).values()];
  const withOrigin = merged.filter((l) => acFromSoDtlKey(l));
  assert.equal(merged.length, 738);
  assert.equal(withOrigin.length, 595);
});

// ── the dedication rule ─────────────────────────────────────────────────────

const soLines = [
  { id: "a1", item_code: "9028-2A(LHF)", ac: "SO-011207" },
  { id: "a2", item_code: "9028-L(RHF)", ac: "SO-011207" },
  { id: "b1", item_code: "AK-ARMOUR (K)", ac: "SO-009654" },
  { id: "b2", item_code: "AK-ARMOUR (K)", ac: "SO-009654" },
];

test("a sales-order line is claimed exactly once, even by two PO lines of the same code", () => {
  const t = makeSoLineTaker(soLines);
  assert.equal(t.take("SO-009654", "AK-ARMOUR (K)"), "b1");
  assert.equal(t.take("SO-009654", "AK-ARMOUR (K)"), "b2");
  assert.equal(t.take("SO-009654", "AK-ARMOUR (K)"), null);
  assert.match(t.explain("SO-009654", "AK-ARMOUR (K)"), /already dedicated/);
});

test("a line some other purchase order already dedicated is never handed out again", () => {
  const taken = new Set(["b1"]);
  const t = makeSoLineTaker(soLines, taken);
  assert.equal(t.take("SO-009654", "AK-ARMOUR (K)"), "b2");
  assert.ok(taken.has("b2"), "the shared set must grow, so a second taker cannot re-claim");
});

test("the taker never crosses orders and never guesses a code", () => {
  const t = makeSoLineTaker(soLines);
  assert.equal(t.take("SO-011207", "AK-ARMOUR (K)"), null);
  assert.equal(t.take("SO-000000", "9028-2A(LHF)"), null);
  assert.equal(t.take("SO-011207", "9028"), null);
  assert.equal(t.take(null, "9028-2A(LHF)"), null);
  assert.equal(t.take("SO-011207", "  9028-2a(lhf) "), "a1", "codes fold on case and space");
});

// ── which ERP row descends from which AutoCount line ────────────────────────

const erp = (id, sku, code, over = {}) => ({
  id, supplier_sku: sku, material_code: code, qty: 1, description2: "", ...over,
});

test("one AutoCount sofa line owns every compartment row it fanned out into", () => {
  const ac = [{ key: 871212, itemCode: "HOK-5530 SOFA", qty: 1, desc2: "2A+L", erpCodes: ["9028-1S"] }];
  const rows = [
    erp("r1", "HOK-5530 SOFA 2A(LHF)", "9028-2A(LHF)"),
    erp("r2", "HOK-5530 SOFA L(RHF)", "9028-L(RHF)"),
  ];
  const m = matchAcLinesToErpRows(ac, rows);
  assert.equal(m.pairs.length, 2);
  assert.deepEqual([...new Set(m.pairs.map((p) => p.ac.key))], [871212]);
  assert.deepEqual([...new Set(m.pairs.map((p) => p.how))], ["sole"]);
  assert.equal(m.unmatchedErp.length, 0);
  assert.equal(m.refused.length, 0);
});

test("a longer ItemCode wins the sku, so one code never swallows another", () => {
  const ac = [
    { key: 1, itemCode: "AK-ARMOUR MATT (K)", qty: 1, desc2: "" },
    { key: 2, itemCode: "AK-ARMOUR MATT (K) XL", qty: 1, desc2: "" },
  ];
  const m = matchAcLinesToErpRows(ac, [erp("r1", "AK-ARMOUR MATT (K) XL", "ARM-XL")]);
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0].ac.key, 2);
});

test("two AutoCount lines sharing a code split on Desc2, which is what the ERP copied", () => {
  const ac = [
    { key: 10, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "GREY" },
    { key: 11, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "BEIGE" },
  ];
  const rows = [
    erp("r1", "NB-KHJ57(K)", "KHJ57-K", { description2: "BEIGE" }),
    erp("r2", "NB-KHJ57(K)", "KHJ57-K", { description2: "GREY" }),
  ];
  const m = matchAcLinesToErpRows(ac, rows);
  assert.equal(m.pairs.length, 2);
  assert.equal(m.refused.length, 0);
  const byRow = new Map(m.pairs.map((p) => [p.row.id, p.ac.key]));
  assert.equal(byRow.get("r1"), 11);
  assert.equal(byRow.get("r2"), 10);
  assert.deepEqual([...new Set(m.pairs.map((p) => p.how))], ["split"]);
});

test("rows identical in every stored field are zipped in DtlKey order and FLAGGED, not presented as resolved", () => {
  const ac = [
    { key: 60702, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "" },
    { key: 60700, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "" },
  ];
  const rows = [erp("r2", "NB-KHJ57(K)", "KHJ57-K"), erp("r1", "NB-KHJ57(K)", "KHJ57-K")];
  const m = matchAcLinesToErpRows(ac, rows);
  assert.equal(m.pairs.length, 2);
  assert.deepEqual([...new Set(m.pairs.map((p) => p.how))], ["indistinguishable"]);
  // deterministic: lowest DtlKey to lowest row id, so a re-run repeats itself
  const byRow = new Map(m.pairs.map((p) => [p.row.id, p.ac.key]));
  assert.equal(byRow.get("r1"), 60700);
  assert.equal(byRow.get("r2"), 60702);
});

test("a group whose two sides do not split the same way is refused whole, never guessed", () => {
  const ac = [
    { key: 1, itemCode: "AK-BASTION (Q)", qty: 2, desc2: "" },
    { key: 2, itemCode: "AK-BASTION (Q)", qty: 5, desc2: "" },
  ];
  const rows = [
    erp("r1", "AK-BASTION (Q)", "BAS-Q", { qty: 2 }),
    erp("r2", "AK-BASTION (Q)", "BAS-Q", { qty: 9 }),
  ];
  const m = matchAcLinesToErpRows(ac, rows);
  assert.equal(m.pairs.length, 0);
  assert.equal(m.refused.length, 1);
  assert.equal(m.refused[0].code, "AK-BASTION (Q)");
});

test("an ERP row no AutoCount line owns is reported, not attached to the nearest thing", () => {
  const ac = [{ key: 1, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "" }];
  const m = matchAcLinesToErpRows(ac, [erp("r9", "SOMETHING-ELSE", "X-1")]);
  assert.equal(m.pairs.length, 0);
  assert.equal(m.unmatchedErp.length, 1);
  assert.equal(m.unmatchedErp[0].id, "r9");
});

test("a row whose supplier_sku was never written still matches on the mapped ERP code", () => {
  const ac = [{ key: 1, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "", erpCodes: ["KHJ57-K"] }];
  const m = matchAcLinesToErpRows(ac, [erp("r1", null, "KHJ57-K")]);
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0].ac.key, 1);
});

// ── the whole chain, on the real exports ────────────────────────────────────

test("HC-PO-009830 walks back to its sales order, which is what the finding claimed", () => {
  const merged = [...mergeAcPoLines(SO_LINKED, OUTSTANDING).values()];
  const lines = merged.filter((l) => l.DocNo === "PO-009830");
  assert.ok(lines.length > 0, "PO-009830 must be in the committed exports");
  const soByDtl = new Map(gz("ac-outstanding-so.json.gz").map((r) => [String(r.DtlKey), r]));
  for (const l of lines) {
    const from = acFromSoDtlKey(l);
    assert.ok(from, "the line carries a FromSODtlKey");
    const so = soByDtl.get(from);
    assert.ok(so, `FromSODtlKey ${from} resolves to a snapshot sales-order line`);
    assert.equal(so.DocNo, "SO-011207");
    assert.ok(acDeliveryDate(l), "and it carries a delivery date");
  }
});
