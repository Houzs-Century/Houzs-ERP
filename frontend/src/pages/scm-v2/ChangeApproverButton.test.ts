import { describe, expect, it } from "vitest";
import { changeApproverTargets } from "./ChangeApproverButton";

describe("changeApproverTargets", () => {
  const open = (lane: string | null) => ({ id: "a1", status: "REQUESTED", lane });

  it("offers a super admin the two other desks", () => {
    expect(changeApproverTargets(open("LINES"), true)).toEqual(["DELIVERY", "PRICE"]);
    expect(changeApproverTargets(open("PRICE"), true)).toEqual(["LINES", "DELIVERY"]);
  });

  it("offers nothing to anyone else, on a closed row, or on a legacy row", () => {
    expect(changeApproverTargets(open("LINES"), false)).toEqual([]);
    expect(changeApproverTargets({ id: "a1", status: "SO_APPROVED", lane: "LINES" }, true)).toEqual([]);
    expect(changeApproverTargets(open(null), true)).toEqual([]);
    expect(changeApproverTargets(null, true)).toEqual([]);
  });
});
