/* The population the AutoCount reconcile compares.
 *
 * The owner defined the target on 2026-09-08: 「差异 0」= 搬进来的资料全部对上账本.
 * The checker was measuring something else — within an hour of delivery orders
 * being opened to staff at 17:41 it reported `HC-DO-2609-003` and
 * `HC-DO-2609-011` as documents the account book does not have, which is true
 * and is not a difference: the book snapshot it compares against was cut at
 * 00:03Z that morning, before either delivery order existed.
 *
 * The three production documents below are pinned BY NAME, because the whole
 * change is a claim about them: `docs/bugs/0714-*`.
 */
import { describe, it, expect } from "vitest";

import {
  MIGRATED, NATIVE, UNPROVEN,
  classifyClaimedDoc, isErpNativeShape, splitErpNative,
} from "../scripts/lib/ac-erp-native.mjs";

/* The snapshot the run of 2026-09-08 compared against, and the minutes the
   three documents were created — MYT is UTC+8, so 14:06 MYT is 06:06Z. */
const CUT = "2026-09-08T00:03:44.762Z";
const SO_2609_001 = "2026-09-08T06:06:51.000Z";
const DO_2609_003 = "2026-09-08T09:41:00.000Z";
const DO_2609_011 = "2026-09-08T09:52:00.000Z";

describe("the three documents staff made on go-live day", () => {
  it("HC-SO-2609-001 is the ERP's own order, written back under its own number", () => {
    expect(
      classifyClaimedDoc({
        erpNo: "HC-SO-2609-001", acNo: "HC-SO-2609-001",
        createdAt: SO_2609_001, snapshotCut: CUT,
      }),
    ).toBe(NATIVE);
  });

  it("HC-DO-2609-003 and HC-DO-2609-011 are new since the cutover, not phantoms", () => {
    const { phantom, native, unproven } = splitErpNative({
      candidates: [
        { ac: "HC-DO-2609-003", erpNo: "HC-DO-2609-003" },
        { ac: "HC-DO-2609-011", erpNo: "HC-DO-2609-011" },
      ],
      bornAt: new Map([
        ["HC-DO-2609-003", DO_2609_003],
        ["HC-DO-2609-011", DO_2609_011],
      ]),
      snapshotCut: CUT,
    });
    expect(native.map((r) => r.ac)).toEqual(["HC-DO-2609-003", "HC-DO-2609-011"]);
    expect(phantom).toEqual([]);
    expect(unproven).toEqual([]);
  });
});

describe("the cutover set itself is untouched — this narrows the population, not the standard", () => {
  it("HC-SO-013361 is a carried-over order and stays in the comparison", () => {
    expect(
      classifyClaimedDoc({
        erpNo: "HC-SO-013361", acNo: "SO-013361",
        createdAt: "2026-08-28T02:00:00.000Z", snapshotCut: CUT,
      }),
    ).toBe(MIGRATED);
  });

  it("a migrated document created before the cut is not reclassified by its age", () => {
    /* Every migrated document predates the snapshot. If the date test could
       reach them, the whole corpus would leave the difference column. */
    const { native } = splitErpNative({
      candidates: [{ ac: "SO-013361", erpNo: "HC-SO-013361" }],
      bornAt: new Map([["HC-SO-013361", "2026-08-28T02:00:00.000Z"]]),
      snapshotCut: CUT,
    });
    expect(native).toEqual([]);
  });
});

describe("the third case the sales-order probe never needed", () => {
  it("a document with no linked_ac_docno has never been to the book", () => {
    expect(isErpNativeShape("HC-DO-2609-020", null)).toBe(true);
    expect(isErpNativeShape("HC-DO-2609-020", "")).toBe(true);
    expect(isErpNativeShape("HC-DO-2609-020", "   ")).toBe(true);
  });
});

describe("it fails closed, which is the only safe direction here", () => {
  it("a pair fitting NEITHER shape stays counted", () => {
    /* `soIsMigratedShape` answers TRUE for an unclassifiable pair, and this
       module inherits that: an unexplainable document belongs in the column
       somebody reads, not in the benign one. */
    expect(
      classifyClaimedDoc({
        erpNo: "HC-PO-2609-004", acNo: "PI-000123",
        createdAt: "2026-09-08T10:00:00.000Z", snapshotCut: CUT,
      }),
    ).toBe(MIGRATED);
  });

  it("ERP-native by shape but created BEFORE the cut is a real finding, not an age artefact", () => {
    /* The write-back says AutoCount took our number; the book, photographed
       AFTERWARDS, does not state it. That is exactly what `phantom` is for. */
    expect(
      classifyClaimedDoc({
        erpNo: "HC-SO-2608-009", acNo: "HC-SO-2608-009",
        createdAt: "2026-09-07T22:00:00.000Z", snapshotCut: CUT,
      }),
    ).toBe(UNPROVEN);
  });

  it("no readable creation date reclassifies nothing", () => {
    const args = { erpNo: "HC-DO-2609-003", acNo: "HC-DO-2609-003", snapshotCut: CUT };
    expect(classifyClaimedDoc({ ...args, createdAt: null })).toBe(UNPROVEN);
    expect(classifyClaimedDoc({ ...args, createdAt: "not a date" })).toBe(UNPROVEN);
    expect(classifyClaimedDoc({ ...args, createdAt: DO_2609_003, snapshotCut: null })).toBe(UNPROVEN);
  });

  it("a whole type whose creation dates could not be read reclassifies nothing", () => {
    const { native, unproven } = splitErpNative({
      candidates: [{ ac: "HC-DO-2609-003", erpNo: "HC-DO-2609-003" }],
      bornAt: null,
      snapshotCut: CUT,
    });
    expect(native).toEqual([]);
    expect(unproven.map((r) => r.ac)).toEqual(["HC-DO-2609-003"]);
  });

  it("a Date object and an ISO string are the same instant", () => {
    expect(
      classifyClaimedDoc({
        erpNo: "HC-DO-2609-003", acNo: "HC-DO-2609-003",
        createdAt: new Date(DO_2609_003), snapshotCut: new Date(CUT),
      }),
    ).toBe(NATIVE);
  });

  it("created in the same millisecond as the cut counts as newer", () => {
    /* The boundary is stated once, here, rather than left to whichever
       comparison operator somebody types next. */
    expect(
      classifyClaimedDoc({ erpNo: "X-1", acNo: "X-1", createdAt: CUT, snapshotCut: CUT }),
    ).toBe(NATIVE);
    expect(
      classifyClaimedDoc({
        erpNo: "X-1", acNo: "X-1",
        createdAt: "2026-09-08T00:03:44.761Z", snapshotCut: CUT,
      }),
    ).toBe(UNPROVEN);
  });
});
