import { describe, expect, it } from "vitest";
import {
  caseNo,
  cap,
  customer,
  get,
  prettyStage,
  priorityOf,
  resolutionLabel,
  slaText,
  stageOf,
  statusOf,
} from "./assr-case-fields";


describe("get — the dual-read the Postgres driver forces on us", () => {
  it("prefers the first key that has a value", () => {
    expect(get({ assrNo: "A", assr_no: "B" }, "assrNo", "assr_no")).toBe("A");
    expect(get({ assr_no: "B" }, "assrNo", "assr_no")).toBe("B");
  });

  it("treats an EMPTY STRING as absent, not as a value", () => {
    expect(get({ assrNo: "", assr_no: "B" }, "assrNo", "assr_no")).toBe("B");
    expect(get({ a: null, b: undefined, c: "x" }, "a", "b", "c")).toBe("x");
  });

  it("returns undefined when nothing is present, and survives a null row", () => {
    expect(get({}, "a")).toBeUndefined();
    expect(get(null, "a")).toBeUndefined();
    expect(get(undefined, "a")).toBeUndefined();
  });
});

describe("row readers", () => {
  it("falls back through the case-number aliases", () => {
    expect(caseNo({ assr_no: "ASSR-2608-004" })).toBe("ASSR-2608-004");
    expect(caseNo({ docNo: "SO-2608-001" })).toBe("SO-2608-001");
    expect(caseNo({})).toBe("—");
  });

  it("em-dashes a missing customer rather than rendering 'undefined'", () => {
    expect(customer({ customerName: "Acme" })).toBe("Acme");
    expect(customer({})).toBe("—");
  });

  it("normalises stage / status / priority to strings", () => {
    expect(stageOf({})).toBe("");
    expect(statusOf({ status: "open" })).toBe("open");
    expect(priorityOf({})).toBe("normal");
    expect(priorityOf({ priority: "URGENT" })).toBe("urgent");
  });
});

describe("labels", () => {
  it("capitalises without touching an empty string", () => {
    expect(cap("open")).toBe("Open");
    expect(cap("")).toBe("");
  });

  it("names the resolution slugs, and humanises an unknown one", () => {
    expect(resolutionLabel("replace_unit")).toBe("Replace Unit");
    expect(resolutionLabel("some_new_method")).toBe("Some new method");
  });

  it("never renders a raw slug for a stage, and never renders empty", () => {
    expect(prettyStage("")).toBe("—");
    expect(prettyStage("not_a_real_stage")).toBe("Not a real stage");
  });
});

describe("slaText", () => {
  it("says nothing when there is no deadline", () => {
    expect(slaText(null)).toBeNull();
    expect(slaText(Number.NaN)).toBeNull();
    expect(slaText(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("counts down in hours under a day and days beyond it", () => {
    expect(slaText(5)).toEqual({ label: "Due in 5h", overdue: false });
    expect(slaText(50)).toEqual({ label: "Due in 2 days", overdue: false });
  });

  it("flags overdue, and reports the overrun as a positive number", () => {
    expect(slaText(-3)).toEqual({ label: "Overdue 3h", overdue: true });
    expect(slaText(-49)).toEqual({ label: "2 days overdue", overdue: true });
  });
});
