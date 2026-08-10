import { describe, expect, test } from "vitest";
// @ts-expect-error - plain .mjs, shared by the top-up repair and the completeness check
import {
  RECEIVED_INDETERMINATE,
  RECEIVED_PER_LINE,
  RECEIVED_ZERO_AGGREGATE,
  belongsToFamily,
  buildFamilies,
  buildGrQtyGroups,
  claimErpRows,
  diffExpectedRows,
  familyShortfall,
  mergeAcPoLines,
  normSku,
  planFamilyInserts,
  resolveReceivedQty,
} from "../scripts/lib/po-line-topup-core.mjs";

/* The incident this file pins, held still.
   PO-009435 is one of the 25 MIXED AutoCount purchase orders: one sofa line and
   one non-sofa line. Two APPLY runs of import-ac-outstanding-po.mjs without
   SOFA=1 created the document with the non-sofa line only. The SOFA=1 run then
   read its own idempotency guard - "SELECT po_number ... WHERE po_number =
   ANY(...)" at :205-208 - saw the document, and skipped it WHOLE. Its log:
   "POs to import: 160; already imported: 123; to insert: 37". Re-running can
   never repair it: the next run says "already imported: 160; to insert: 0".

   check-cutover-completeness could not see it either, because it compared
   document-number SETS (:51-58) and reported "PO 407 = 407 MISSING 0". The
   document was there. The line was not.

   The second half of the file pins the OTHER way this can go wrong, found in
   the first prod DRY-RUN: 225 of the 862 migrated PO lines carry no
   supplier_sku at all, and keying only on supplier_sku called 183 of them
   missing. Inserting those would have duplicated real lines. */

type Row = { supplierSku: string | null; materialCode?: string };
const acLine = (docNo: string, itemCode: string, extra: Record<string, unknown> = {}) => ({
  DocNo: docNo, DtlKey: String(Math.random()).slice(2), ItemCode: itemCode, Qty: 1, ...extra,
});
const lines = [{ itemCode: "AMN-SF9028 SOFA" }, { itemCode: "AMN-SQUARE PILLOW" }];
const resolve = (itemCode: string) =>
  (/SOFA/i.test(itemCode) ? { code: "9028-1S", sofaModel: "9028" } : { code: "SQP-01" });
const claim = (ls: { itemCode: string }[], rows: Row[]) => {
  const fams = buildFamilies(ls, resolve);
  const c = claimErpRows(fams, rows);
  return { ...c, ...familyShortfall(fams), fam: (code: string) => fams.find((f: { itemCode: string }) => f.itemCode === code) };
};

describe("the mixed-document shortfall the document-level check could not see", () => {
  test("a document holding only its non-sofa line is SHORT, not complete", () => {
    const r = claim(lines, [{ supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" }]);
    expect(r.short).toBe(1);
    expect(r.fam("AMN-SF9028 SOFA").claimed).toBe(0);
  });

  test("the same document, once the sofa compartments are written, is complete", () => {
    expect(claim(lines, [
      { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
      { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", materialCode: "9028-2A(LHF)" },
      { supplierSku: "AMN-SF9028 SOFA 1A(RHF)", materialCode: "9028-1A(RHF)" },
    ]).short).toBe(0);
  });

  /* The decoder-independence claim, made explicit: ONE compartment already
     clears the ItemCode, because the check never predicts how many pieces a
     build decomposes into. It only knows a line cannot produce zero rows.
     Under-report, never false-alarm. */
  test("one compartment clears the ItemCode - the check never guesses the piece count", () => {
    expect(claim(lines, [
      { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
      { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", materialCode: "9028-2A(LHF)" },
    ]).short).toBe(0);
  });

  test("two AutoCount lines of the same code need two ERP rows, not one", () => {
    // PO-009751 really does carry two AMN-SF9028 SOFA lines with different builds
    const two = [{ itemCode: "AMN-SF9028 SOFA" }, { itemCode: "AMN-SF9028 SOFA" }];
    expect(claim(two, [{ supplierSku: "AMN-SF9028 SOFA 1S", materialCode: "9028-1S" }]).short).toBe(1);
    expect(claim(two, [
      { supplierSku: "AMN-SF9028 SOFA 1S", materialCode: "9028-1S" },
      { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", materialCode: "9028-2A(LHF)" },
    ]).short).toBe(0);
  });

  test("an ERP row belonging to no AutoCount line is surfaced, not silently counted", () => {
    const r = claim(lines, [{ supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" }, { supplierSku: "HAND-ADDED", materialCode: "Z" }]);
    expect(r.unassigned.map((x: Row) => x.supplierSku)).toEqual(["HAND-ADDED"]);
    expect(r.short).toBe(1); // the hand-added row must NOT be allowed to cover the sofa line
  });
});

describe("linked_ac_dtlkey, the strongest claim - migration 0273 (#1819)", () => {
  const keyed = [{ itemCode: "AMN-SF9028 SOFA", dtlKey: "886047" }, { itemCode: "AMN-SQUARE PILLOW", dtlKey: "886051" }];

  test("a row carrying the line key is claimed by it, whatever its supplier_sku says", () => {
    const r = claim(keyed, [
      { supplierSku: "SOMETHING-ELSE-ENTIRELY", materialCode: "9028-CNR", linkedAcDtlKey: 886047 },
      { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
    ]);
    expect(r.short).toBe(0);
    expect(r.fam("AMN-SF9028 SOFA").keyRows).toBe(1);
  });

  /* A key naming a line that is not on this document is a fact that disagrees
     with the export. Falling through to a weaker signal would let it quietly
     cover a different line. */
  test("a key naming a line not on this document claims nothing and is reported", () => {
    const r = claim(keyed, [
      { supplierSku: "AMN-SF9028 SOFA 1S", materialCode: "9028-1S", linkedAcDtlKey: 999999 },
      { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
    ]);
    expect(r.unassigned).toHaveLength(1);
    expect(r.short).toBe(1);
  });

  test("every compartment of one sofa line shares that line's key", () => {
    const r = claim(keyed, [
      { supplierSku: null, materialCode: "9028-2A(LHF)", linkedAcDtlKey: 886047 },
      { supplierSku: null, materialCode: "9028-1A(RHF)", linkedAcDtlKey: 886047 },
      { supplierSku: null, materialCode: "SQP-01", linkedAcDtlKey: 886051 },
    ]);
    expect(r.short).toBe(0);
    expect(r.fam("AMN-SF9028 SOFA").keyRows).toBe(2);
  });
});

describe("rows that carry no supplier_sku - 225 of the 862 live migrated lines", () => {
  /* apply-sofa-compartment-corrections.mjs:212-217 INSERTs a corrected
     compartment by SELECTing from the source row and never carries
     supplier_sku. Those rows are real AutoCount lines. Claiming them by
     material_code is what stops the repair duplicating them. */
  test("a no-supplier_sku bedframe row is claimed by its exact material_code", () => {
    const bed = [{ itemCode: "AMN-SQUARE PILLOW" }];
    expect(claim(bed, [{ supplierSku: null, materialCode: "SQP-01" }]).short).toBe(0);
  });

  test("a no-supplier_sku sofa compartment is claimed by the model prefix", () => {
    expect(claim(lines, [
      { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
      { supplierSku: null, materialCode: "9028-CNR" },
    ]).short).toBe(0);
  });

  test("a row two ItemCodes could both claim is claimed by NEITHER, and is reported", () => {
    const twoModels = [{ itemCode: "DSL-9028 SOFA" }, { itemCode: "AMN-SF9028 SOFA" }];
    const r = claim(twoModels, [{ supplierSku: null, materialCode: "9028-CNR" }]);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.short).toBe(2); // both stay short: guessing which one owns it is how a compartment gets doubled
  });

  test("a no-supplier_sku row whose code belongs to nothing here is unassigned, not a free pass", () => {
    const r = claim(lines, [{ supplierSku: null, materialCode: "SOMETHING-ELSE" }]);
    expect(r.unassigned).toHaveLength(1);
    expect(r.short).toBe(2);
  });
});

describe("supplier_sku family membership", () => {
  test("the ItemCode itself and its compartments belong; a different code does not", () => {
    expect(belongsToFamily("AMN-SF9028 SOFA", "AMN-SF9028 SOFA")).toBe(true);
    expect(belongsToFamily("AMN-SF9028 SOFA 1A(RHF)", "AMN-SF9028 SOFA")).toBe(true);
    expect(belongsToFamily("AMN-SF9058 SOFA 1A(RHF)", "AMN-SF9028 SOFA")).toBe(false);
  });

  test("case and internal spacing are folded, so an export reformat cannot fake a shortfall", () => {
    expect(belongsToFamily("amn-sf9028  sofa   1a(rhf)", "AMN-SF9028 SOFA")).toBe(true);
    expect(normSku("  amn-sf9028   sofa ")).toBe("AMN-SF9028 SOFA");
  });

  test("a prefix code does not steal the longer code's rows", () => {
    const ls = [{ itemCode: "AMN-SF9028 SOFA" }, { itemCode: "AMN-SF9028 SOFA XL" }];
    const fams = buildFamilies(ls, resolve);
    claimErpRows(fams, [{ supplierSku: "AMN-SF9028 SOFA XL 1S", materialCode: "9028-1S" }]);
    expect(fams.find((f: { itemCode: string }) => f.itemCode === "AMN-SF9028 SOFA XL").claimed).toBe(1);
    expect(fams.find((f: { itemCode: string }) => f.itemCode === "AMN-SF9028 SOFA").claimed).toBe(0);
  });
});

describe("the repair is all-or-nothing per ItemCode", () => {
  const expected = [
    { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", materialCode: "9028-2A(LHF)" },
    { supplierSku: "AMN-SF9028 SOFA 1A(RHF)", materialCode: "9028-1A(RHF)" },
  ];

  test("zero rows present -> write them all (the confirmed defect shape)", () => {
    const r = claim(lines, [{ supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" }]);
    const p = planFamilyInserts(r.fam("AMN-SF9028 SOFA"), expected);
    expect(p.verdict).toBe("absent");
    expect(p.insert).toHaveLength(2);
  });

  /* Half a build present is ambiguous: it can equally be a build somebody
     corrected by hand. Writing the "missing" half would double a compartment. */
  test("some rows present but fewer than expected -> write NOTHING, report it", () => {
    const r = claim(lines, [
      { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
      { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", materialCode: "9028-2A(LHF)" },
    ]);
    const p = planFamilyInserts(r.fam("AMN-SF9028 SOFA"), expected);
    expect(p.verdict).toBe("partial");
    expect(p.insert).toHaveLength(0);
  });

  test("everything present -> nothing to do", () => {
    const r = claim(lines, [
      { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
      { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", materialCode: "9028-2A(LHF)" },
      { supplierSku: "AMN-SF9028 SOFA 1A(RHF)", materialCode: "9028-1A(RHF)" },
    ]);
    expect(planFamilyInserts(r.fam("AMN-SF9028 SOFA"), expected).verdict).toBe("present");
  });
});

describe("the last guard before an INSERT", () => {
  const expected = [
    { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", materialCode: "9028-2A(LHF)" },
    { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
  ];

  test("re-running inserts nothing - idempotent", () => {
    expect(diffExpectedRows(expected, expected.map((e) => ({ ...e }))).toInsert).toHaveLength(0);
  });

  /* material_code is NOT part of this key on purpose. A row already present
     under a different code is still PRESENT; keying on the code too would
     insert a duplicate of a line that exists. It is reported instead. */
  test("a row present under a different material_code is not duplicated, it is reported", () => {
    const live = [
      { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", materialCode: "9028-2A" },
      { supplierSku: "AMN-SQUARE PILLOW", materialCode: "SQP-01" },
    ];
    const { toInsert, codeDisagreements } = diffExpectedRows(expected, live);
    expect(toInsert).toHaveLength(0);
    expect(codeDisagreements).toEqual([
      { supplierSku: "AMN-SF9028 SOFA 2A(LHF)", expected: "9028-2A(LHF)", found: "9028-2A" },
    ]);
  });

  test("two identical expected rows both land when neither is there", () => {
    const dup = [{ supplierSku: "X 1S" }, { supplierSku: "X 1S" }];
    expect(diffExpectedRows(dup, [{ supplierSku: "X 1S" }]).toInsert).toHaveLength(1);
    expect(diffExpectedRows(dup, []).toInsert).toHaveLength(2);
  });
});

describe("merging the two AutoCount PO exports", () => {
  test("a line in both exports appears once, and the PER-LINE column is the one that survives", () => {
    const outstanding = [acLine("PO-1", "A", { DtlKey: 99, TransferedQty: 2, UnitPrice: 100 })];
    const soLinked = [acLine("PO-1", "A", { DtlKey: 99, GrQty: 2, FromSODtlKey: 555 })];
    const merged = mergeAcPoLines(outstanding, soLinked);
    expect(merged).toHaveLength(1);
    expect(merged[0].receivedQty).toBe(2);
    expect(merged[0].receivedSource).toBe(RECEIVED_PER_LINE);
    expect(merged[0].fromSoDtlKey).toBe("555"); // filled from the export that has it
    expect(merged[0].sources).toEqual(["outstanding", "so-linked"]);
  });

  test("a line only the SO-linked export knows is still carried, but without a received quantity", () => {
    const merged = mergeAcPoLines([], [acLine("PO-2", "B", { DtlKey: 7, GrQty: 1 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].docNo).toBe("PO-2");
    expect(merged[0].receivedQty).toBeNull();
  });

  /* THE INCIDENT, held still. ac-so-linked-pos.json.gz reports GrQty aggregated
     on (DocNo + ItemCode), so every line of a repeated ItemCode carries the
     DOCUMENT's total. PO-008944 really does hold two DSL-8050 SOFA lines, Qty 2
     and Qty 1, and the export puts GrQty 3 on BOTH - their sum. Live
     PODTL.TransferedQty is 2 and 1. Reading that column per line is what wrote
     65 production rows with received_qty > qty, a permanent negative
     outstanding that no report surfaces.

     Every test in this block fails against `receivedQty: acNum(r.TransferedQty
     ?? r.GrQty)` except the zero-aggregate one, which is a regression guard
     rather than a proof - see the PR for the measured pass/fail either way. */
  const po8944 = [
    { DocNo: "PO-008944", DtlKey: 819426, ItemCode: "DSL-8050 SOFA", Qty: 2, GrQty: 3 },
    { DocNo: "PO-008944", DtlKey: 819428, ItemCode: "DSL-8050 SOFA", Qty: 1, GrQty: 3 },
  ];

  test("an aggregated GrQty yields NO received quantity, on every line of the group", () => {
    const merged = mergeAcPoLines([], po8944);
    expect(merged.map((l: { receivedQty: number | null }) => l.receivedQty)).toEqual([null, null]);
    expect(merged.map((l: { receivedSource: string }) => l.receivedSource))
      .toEqual([RECEIVED_INDETERMINATE, RECEIVED_INDETERMINATE]);
  });

  /* The invariant the 65 damaged rows violate, stated directly. */
  test("no line is ever handed a received quantity greater than its own ordered quantity", () => {
    for (const l of mergeAcPoLines([], po8944) as { receivedQty: number | null; qty: number }[]) {
      expect(l.receivedQty === null || l.receivedQty <= l.qty).toBe(true);
    }
  });

  /* The tempting rule this deliberately does NOT implement: "the group holds one
     line, so the aggregate must be that line". It rests on the export holding
     every line of that ItemCode on that document, which nothing available can
     establish - the two exports never overlap on a received line. Refused. */
  test("a single-line group is refused too - group size is diagnosis, never permission", () => {
    const one = [{ DocNo: "PO-000254", DtlKey: 111, ItemCode: "RDS-5526 SOFA", Qty: 1, GrQty: 1 }];
    const merged = mergeAcPoLines([], one);
    expect(merged[0].receivedQty).toBeNull();
    expect(merged[0].receivedSource).toBe(RECEIVED_INDETERMINATE);
    expect(merged[0].aggregateSpans).toBe(1); // reported, so the operator can see why
  });

  /* Arithmetic, not trust: a sum of non-negative receipts that comes to zero
     forces every member to zero. The export carries no negative GrQty. */
  test("an aggregate of exactly zero does prove every line of the group is zero", () => {
    const merged = mergeAcPoLines([], [
      { DocNo: "PO-9", DtlKey: 1, ItemCode: "X", Qty: 1, GrQty: 0 },
      { DocNo: "PO-9", DtlKey: 2, ItemCode: "X", Qty: 1, GrQty: 0 },
    ]);
    expect(merged.map((l: { receivedQty: number | null }) => l.receivedQty)).toEqual([0, 0]);
    expect(merged[0].receivedSource).toBe(RECEIVED_ZERO_AGGREGATE);
  });

  test("a per-line figure beats an aggregate for the same line, and never the reverse", () => {
    const merged = mergeAcPoLines(
      [{ DocNo: "PO-008944", DtlKey: 819426, ItemCode: "DSL-8050 SOFA", Qty: 2, TransferedQty: 2 }],
      po8944,
    );
    expect(merged).toHaveLength(2);
    const keyed = merged.find((l: { dtlKey: string }) => l.dtlKey === "819426");
    expect(keyed.receivedQty).toBe(2); // the truth, not the aggregate 3
    expect(keyed.receivedSource).toBe(RECEIVED_PER_LINE);
  });

  test("the resolver is one shared rule - the importer and the top-up call the same function", () => {
    const groups = buildGrQtyGroups(po8944);
    expect(resolveReceivedQty(po8944[0], groups).receivedSource).toBe(RECEIVED_INDETERMINATE);
    expect(resolveReceivedQty({ DocNo: "d", ItemCode: "i", TransferedQty: 4 }, groups))
      .toMatchObject({ receivedQty: 4, receivedSource: RECEIVED_PER_LINE });
    // neither column present is also "unknown", never a confident zero
    expect(resolveReceivedQty({ DocNo: "d", ItemCode: "i" }, groups).receivedSource).toBe(RECEIVED_INDETERMINATE);
  });

  /* import-ac-outstanding-po.mjs:179 reads l.DelivDate, a column that exists in
     NEITHER export - both spell it DeliveryDate - so every line it wrote carries
     a NULL delivery_date. Both spellings are read here so the top-up does not
     inherit the typo. */
  test("the delivery date is read under the spelling the exports actually use", () => {
    const merged = mergeAcPoLines([acLine("PO-3", "C", { DtlKey: 8, DeliveryDate: "2026-09-01 00:00:00" })], []);
    expect(merged[0].deliveryDate).toBe("2026-09-01 00:00:00");
  });
});
