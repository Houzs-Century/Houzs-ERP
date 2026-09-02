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
import { test } from 'vitest';
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
import { dedicationCandidates, makeSoLineTaker } from "../scripts/lib/so-line-dedication.mjs";
import { matchAcLinesToErpRows } from "../scripts/lib/ac-po-line-match.mjs";
import { codeMatchGapReason, compareStoredKey, isCompartmentSku } from "../scripts/lib/ac-line-key-audit.mjs";

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
  // Pinned to the COMMITTED snapshots, so these move when the snapshots are
  // re-cut. 2026-08-29 quiet-book tail cut (whole-document lanes): 941 merged
  // lines (938 on the 08-28 cut; the book grew overnight),
  // 696 carrying an SO origin on the 08-29 quiet-book cut (685 on 08-28; 738/595 on 08-10).
  const merged = [...mergeAcPoLines(SO_LINKED, OUTSTANDING).values()];
  const withOrigin = merged.filter((l) => acFromSoDtlKey(l));
  assert.equal(merged.length, 941);
  assert.equal(withOrigin.length, 696);
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

// ── the cross-product refusal ───────────────────────────────────────────────
// Restore `base` as a blanket attempt in dedicationCandidates — i.e. drop the
// sameProduct gate — and the next two tests fail: the cross-product case offers
// "MYLATEX-LUMBARIA-K" as a candidate and reports crossProduct false, which is
// exactly how a PO line for product A gets bound to an SO line for product B.

test("the sales-order line's own code is offered ONLY when it names this PO line's product", () => {
  // same product: the SO line and the PO line agree, so base is a real candidate
  const same = dedicationCandidates("KHJ57-K", "KHJ57-K", null);
  assert.deepEqual(same.attempts, ["KHJ57-K"]);
  assert.equal(same.crossProduct, false);

  // same product by sofa placeholder: the PO row is a compartment, the SO line
  // is the model's placeholder, and that placeholder is derived from the PO
  // line's OWN AutoCount item — so it cannot name someone else's product
  const sofa = dedicationCandidates("9028-2A(LHF)", "9028-1S", "9028-1S");
  assert.deepEqual(sofa.attempts, ["9028-2A(LHF)", "9028-1S"]);
  assert.equal(sofa.crossProduct, false);

  // unmapped SO code: nothing to cross, and nothing extra to try
  const unmapped = dedicationCandidates("KHJ57-K", "", null);
  assert.deepEqual(unmapped.attempts, ["KHJ57-K"]);
  assert.equal(unmapped.crossProduct, false);
});

test("a sales-order line naming a DIFFERENT product is refused, not tried", () => {
  // PO-000290's real shape: FromSODtlKey 60700 resolves to SO-000870
  // "MYLATEX LUMBARIA (K)" while the PO line is "NB-KHJ57(K)". Offering the SO
  // line's code here would dedicate a mattress PO line to a lumbar-support SO
  // line and the ERP would show a link that never existed in AutoCount.
  const cross = dedicationCandidates("KHJ57-K", "MYLATEX-LUMBARIA-K", null);
  assert.deepEqual(cross.attempts, ["KHJ57-K"], "the other product's code must NOT be a candidate");
  assert.ok(!cross.attempts.includes("MYLATEX-LUMBARIA-K"));
  assert.equal(cross.crossProduct, true, "and the caller must be told, so the row is reported not silently blank");

  // the placeholder still rides along — it is this PO line's own product
  const withSofa = dedicationCandidates("9028-2A(LHF)", "MYLATEX-LUMBARIA-K", "9028-1S");
  assert.deepEqual(withSofa.attempts, ["9028-2A(LHF)", "9028-1S"]);
  assert.equal(withSofa.crossProduct, true);
});

test("codes fold on case and space before being called a different product", () => {
  assert.equal(dedicationCandidates("khj57-k", "KHJ57-K", null).crossProduct, false);
  assert.equal(dedicationCandidates("KHJ57-K", "  khj57-k ", null).crossProduct, false);
  // and a candidate list never repeats a code
  assert.deepEqual(dedicationCandidates("9028-1S", "9028-1S", "9028-1S").attempts, ["9028-1S"]);
});

// ── which ERP row descends from which AutoCount line ────────────────────────

const erp = (id, sku, code, over = {}) => ({
  id, supplier_sku: sku, item_code: code, qty: 1, description2: "", ...over,
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

test("rows identical in every stored field are zipped ONLY when the AutoCount lines agree on every written value", () => {
  const ac = [
    { key: 60702, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "", fromSoKey: "60700", deliveryDate: "2024-05-21" },
    { key: 60700, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "", fromSoKey: "60700", deliveryDate: "2024-05-21" },
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

// ── the zip's premise, which the real data refutes ───────────────────────────
// Delete the `distinct.length > 1` refusal in ac-po-line-match.mjs and the next
// three tests fail: the first two zip 2 pairs instead of refusing, and the
// snapshot test reports 5 zipped buckets instead of 5 refusals.

test("two AutoCount lines that disagree on FromSODtlKey are REFUSED, never zipped", () => {
  // PO-000290's real shape: same code, same qty, same Desc2, same date — and
  // two different origin SO lines, which on that document are two different
  // PRODUCTS. A zip here is a coin flip on so_item_id and on the write-back's
  // edit handle, and a wrong DtlKey makes AcSyncService APPEND instead of edit.
  const ac = [
    { key: 61216, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "COL:PC151-02", fromSoKey: "60700", deliveryDate: "2024-05-21" },
    { key: 61217, itemCode: "NB-KHJ57(K)", qty: 1, desc2: "COL:PC151-02", fromSoKey: "60702", deliveryDate: "2024-05-21" },
  ];
  const rows = [erp("r1", "NB-KHJ57(K)", "KHJ57-K", { description2: "COL:PC151-02" }),
                erp("r2", "NB-KHJ57(K)", "KHJ57-K", { description2: "COL:PC151-02" })];
  const m = matchAcLinesToErpRows(ac, rows);
  assert.equal(m.pairs.length, 0, "nothing may be paired out of a coin-flip bucket");
  assert.equal(m.refused.length, 1);
  assert.match(m.refused[0].reason, /FromSODtlKey/);
  // the report must carry BOTH candidates, or the owner cannot adjudicate it
  assert.deepEqual(m.refused[0].candidates.map((c) => c.key), [61216, 61217]);
  assert.deepEqual(m.refused[0].candidates.map((c) => c.fromSoKey), ["60700", "60702"]);
  assert.deepEqual(m.refused[0].rowIds, ["r1", "r2"]);
});

test("two AutoCount lines that disagree on DeliveryDate are REFUSED, never zipped", () => {
  const ac = [
    { key: 10, itemCode: "AK-X (K)", qty: 1, desc2: "", fromSoKey: "5", deliveryDate: "2026-01-01" },
    { key: 11, itemCode: "AK-X (K)", qty: 1, desc2: "", fromSoKey: "5", deliveryDate: "2026-09-09" },
  ];
  const m = matchAcLinesToErpRows(ac, [erp("r1", "AK-X (K)", "X-K"), erp("r2", "AK-X (K)", "X-K")]);
  assert.equal(m.pairs.length, 0);
  assert.equal(m.refused.length, 1);
  assert.match(m.refused[0].reason, /DeliveryDate/);
});

test("NO indistinguishable bucket in the committed exports supports a zip", () => {
  // This is the fact that refutes the zip's original premise, pinned against
  // the real snapshots rather than a fixture. On the 2026-08-10 cut: 5 buckets,
  // 10 lines, all 5 disagreeing on FromSODtlKey. The 2026-08-28 re-import cut
  // adds 2 buckets (4 lines) where NO line carries an origin key at all — new
  // POs raised since, two same-code same-spec mattress lines each. Either way
  // the zip has nothing to stand on: a keyed bucket disagrees, a keyless bucket
  // has no key to zip by — so the correct repair count is still ZERO.
  const merged = [...mergeAcPoLines(SO_LINKED, OUTSTANDING).values()];
  const nrm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
  const buckets = new Map();
  for (const l of merged) {
    if (acDtlKey(l) === null) continue;
    const k = `${l.DocNo}|${nrm(l.ItemCode)}|${Number(l.Qty) || 0}|${nrm(l.Desc2)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(l);
  }
  const ambiguous = [...buckets.values()].filter((v) => v.length > 1);
  assert.equal(ambiguous.length, 9, "9 buckets survive the (qty, Desc2) split (7 on the 08-28 cut; two more same-item same-qty pairs arrived with the 08-29 quiet-book cut)");
  assert.equal(ambiguous.reduce((n, v) => n + v.length, 0), 18);
  const keyed = ambiguous.filter((acs) => acs.some((a) => acFromSoDtlKey(a)));
  assert.equal(keyed.length, 7, "7 buckets carry at least one origin key (5 on the 08-28 cut)");
  for (const acs of keyed) {
    assert.ok(
      new Set(acs.map((a) => acFromSoDtlKey(a) ?? "-")).size > 1,
      `${acs[0].DocNo} "${acs[0].ItemCode}" must disagree on FromSODtlKey — the zip's premise was that it would not`,
    );
  }
  // and the matcher answers each bucket by its own contract: zip ONLY when the
  // lines agree on everything the repair writes (FromSODtlKey + DeliveryDate)
  // — the 2 keyless twin buckets, where either bijection records the same
  // facts — and refuse whole where they disagree — the 5 keyed ones.
  for (const acs of ambiguous) {
    const shaped = acs.map((l) => ({
      key: acDtlKey(l), itemCode: l.ItemCode, qty: Number(l.Qty) || 0, desc2: l.Desc2,
      fromSoKey: acFromSoDtlKey(l), deliveryDate: acDeliveryDate(l),
    }));
    const rows = shaped.map((s, i) => erp(`row${i}`, s.itemCode, "ANY", { qty: s.qty, description2: s.desc2 }));
    const m = matchAcLinesToErpRows(shaped, rows);
    const agrees = new Set(shaped.map((s) => `${s.fromSoKey ?? "-"}|${s.deliveryDate ?? "-"}`)).size === 1;
    if (agrees) {
      assert.equal(m.pairs.length, acs.length, `${acs[0].DocNo} identical twins zip — same facts either way`);
      assert.equal(m.refused.length, 0);
    } else {
      assert.equal(m.pairs.length, 0, `${acs[0].DocNo} must repair 0 rows`);
      assert.equal(m.refused.length, 1);
    }
  }
});

// ── the tie-break sort ───────────────────────────────────────────────────────
// Restore `String(a.id).localeCompare(String(b.id))` in ac-po-line-match.mjs and
// this fails: [9,10,11,12] sorts as [10,11,12,9], so the sofa's two compartment
// rows land under different AutoCount lines.

test("row ids are ordered numerically, so a sofa's compartment rows are not split by text sort", () => {
  const ac = [
    { key: 100, itemCode: "HOK-5530 SOFA", qty: 1, desc2: "", fromSoKey: "7", deliveryDate: "2026-08-15" },
    { key: 101, itemCode: "HOK-5530 SOFA", qty: 1, desc2: "", fromSoKey: "7", deliveryDate: "2026-08-15" },
  ];
  // two PO lines, each fanned out into two compartment rows: ids 9,10 and 11,12
  const rows = [
    erp(11, "HOK-5530 SOFA 2A(LHF)", "9028-2A(LHF)"), erp(9, "HOK-5530 SOFA 2A(LHF)", "9028-2A(LHF)"),
    erp(12, "HOK-5530 SOFA L(RHF)", "9028-L(RHF)"), erp(10, "HOK-5530 SOFA L(RHF)", "9028-L(RHF)"),
  ];
  const m = matchAcLinesToErpRows(ac, rows);
  assert.equal(m.pairs.length, 4);
  const byRow = new Map(m.pairs.map((p) => [p.row.id, p.ac.key]));
  assert.equal(byRow.get(9), 100);
  assert.equal(byRow.get(10), 100, "9 and 10 are one PO line's compartments — they must share an AutoCount line");
  assert.equal(byRow.get(11), 101);
  assert.equal(byRow.get(12), 101);
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
  /* The caller builds the per-line reason list from rowIds, so a refusal that
     omits them leaves its rows explained only at group level. Every unrepaired
     line gets a reason — HC-PO-009620 was the production row that fell through
     this exact gap. */
  assert.deepEqual(m.refused[0].rowIds, ["r1", "r2"]);
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

/* RE-PINNED 2026-08-29: the original worked example PO-009830 completed and
   left the outstanding exports with the quiet-book cut. PO-010093 has the same
   shape on the fresh cut: three lines, every one carrying FromSODtlKey, all
   resolving to one sales order, all dated. */
test("HC-PO-010093 walks back to its sales order, which is what the finding claimed", () => {
  const merged = [...mergeAcPoLines(SO_LINKED, OUTSTANDING).values()];
  const lines = merged.filter((l) => l.DocNo === "PO-010093");
  assert.ok(lines.length > 0, "PO-010093 must be in the committed exports");
  const soByDtl = new Map(gz("ac-outstanding-so.json.gz").map((r) => [String(r.DtlKey), r]));
  for (const l of lines) {
    const from = acFromSoDtlKey(l);
    assert.ok(from, "the line carries a FromSODtlKey");
    const so = soByDtl.get(from);
    assert.ok(so, `FromSODtlKey ${from} resolves to a snapshot sales-order line`);
    assert.equal(so.DocNo, "SO-013373");
    assert.ok(acDeliveryDate(l), "and it carries a delivery date");
  }
});

// ── the audits that exist because backfill-ac-line-keys.mjs ran on prod ──────
//
// 275 purchase-order lines were keyed by the other rule on 2026-08-10. This
// repair may not overwrite them, so its only remaining duty toward them is to
// CHECK them — and a check that cannot report a disagreement is worse than no
// check, because it reads as an all-clear.

test("a stored key that names a different AutoCount line is a DISAGREEMENT", () => {
  assert.equal(compareStoredKey(61216, 61217), "disagree");
  assert.equal(compareStoredKey(61216, 61216), "agree");
});

test("bigint comes back as a string on some driver paths, and that is NOT a disagreement", () => {
  /* The whole audit is worthless if it cries wolf: 275 false disagreements
     would bury a real one. `===` on "829688" vs 829688 is false. */
  assert.equal(compareStoredKey("829688", 829688), "agree");
  assert.equal(compareStoredKey(829688, "829688"), "agree");
  assert.equal(compareStoredKey("829688", "829690"), "disagree");
});

test("a row with no stored key, and a stored key this repair cannot check, are distinct outcomes", () => {
  assert.equal(compareStoredKey(null, 123), "absent");
  assert.equal(compareStoredKey(undefined, 123), "absent");
  // keyed by the other rule on a document this repair finds no AutoCount line
  // for: reporting that as "agree" would be a lie, and as "disagree" a false alarm.
  assert.equal(compareStoredKey(123, null), "underived");
});

test("a compartment sku is the ItemCode plus a compartment, not merely a prefix collision", () => {
  assert.equal(isCompartmentSku("DSL-8030 SOFA 1A(LHF)", "DSL-8030 SOFA"), true);
  assert.equal(isCompartmentSku("DSL-8030 SOFA", "DSL-8030 SOFA"), false, "the bare ItemCode is not a compartment");
  assert.equal(isCompartmentSku("DSL-8030 SOFAX", "DSL-8030 SOFA"), false, "no space at the boundary is a different item");
  assert.equal(isCompartmentSku("", "DSL-8030 SOFA"), false);
});

test("the compartment is reported as the CAUSE, ahead of the missing mapping row it causes", () => {
  /* A decomposed sofa line fails both tests at once. Naming the missing CSV row
     would send the reader to add one, which cannot work — there is no AutoCount
     item for a compartment to map to. */
  const r = codeMatchGapReason({
    codeMatched: false, docInOutstandingPo: true, docInSoLinkedPos: true,
    skuBeyondItemCode: true, acItemMapped: false,
  });
  assert.match(r, /COMPARTMENT/);
});

test("a document the code match never opens is named as such, not blamed on the item", () => {
  const r = codeMatchGapReason({
    codeMatched: false, docInOutstandingPo: false, docInSoLinkedPos: true,
    skuBeyondItemCode: true, acItemMapped: true,
  });
  assert.match(r, /only in ac-so-linked-pos/);
  assert.equal(codeMatchGapReason({
    codeMatched: false, docInOutstandingPo: false, docInSoLinkedPos: false,
    skuBeyondItemCode: false, acItemMapped: false,
  }), "the AutoCount document is in NEITHER committed PO export");
});

test("the reason list UNDERCOUNTS compartments, which is why the census counts them separately", () => {
  /* This is the fact that decides whether "the 589 are decomposed sofa
     compartments" can be answered from the reason tally. It cannot.
     codeMatchGapReason() returns the FIRST cause that applies and the
     document-level ones are tested first — correctly, because a line on a
     document the script never opens fails whatever its item code is. So a row
     that IS a compartment is reported under the document reason and never
     counted as one.

     Measured on production 2026-08-11: the reason list said 65 compartments
     while 464 rows were claimed by the document cause ahead of it. The census
     therefore asks `isCompartmentSku` of EVERY row independently. Delete that
     independent tally and the report goes back to answering the question with a
     number that is only a lower bound. */
  const bothApply = {
    codeMatched: false, docInOutstandingPo: false, docInSoLinkedPos: true,
    skuBeyondItemCode: true, acItemMapped: true,
  };
  assert.doesNotMatch(codeMatchGapReason(bothApply), /COMPARTMENT/);
  // ...though the row plainly is one, asked directly.
  assert.equal(isCompartmentSku("DSL-8030 SOFA 1A(LHF)", "DSL-8030 SOFA"), true);
});

test("a line the code match DID reach has no gap to explain", () => {
  assert.equal(codeMatchGapReason({
    codeMatched: true, docInOutstandingPo: true, docInSoLinkedPos: true,
    skuBeyondItemCode: true, acItemMapped: false,
  }), null);
});

test("the two PO exports really do differ, which is why the single-file rule under-reaches", () => {
  /* Not a fixture: the code match reads ac-outstanding-po.json.gz alone, so
     every document only in the other export is unreachable to it by
     construction. If this ever became 0 the census's second reason would be
     dead code and should be removed rather than left to reassure. */
  const outstandingDocs = new Set(OUTSTANDING.map((r) => r.DocNo));
  const onlyInSoLinked = new Set(
    SO_LINKED.map((r) => r.DocNo).filter((d) => !outstandingDocs.has(d)),
  );
  assert.ok(onlyInSoLinked.size > 0, `documents only in ac-so-linked-pos.json.gz: ${onlyInSoLinked.size}`);
});
