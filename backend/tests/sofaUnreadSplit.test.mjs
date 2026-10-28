// The `unread` sofa-compartment column, by CAUSE. Every case here is one the
// split must keep separating: the two arms need different PEOPLE, and summing
// them is what made 195 read as one backlog.
import { describe, expect, it } from "vitest";

import { classifyUnread, makeUnreadTally, MECHANICAL, UNREAD_LABEL } from "../scripts/lib/sofa-unread-split.mjs";

describe("which bucket an unanswerable compartment falls in", () => {
  it("is MECHANICAL only when the key is missing and the book text decodes", () => {
    expect(classifyUnread({ keyless: true, bookUnreadable: false })).toBe(MECHANICAL);
    expect(MECHANICAL).toBe("keylessBookReadable");
  });

  it("keeps 'missing key AND undecodable' out of the mechanical arm", () => {
    // Folding it in would overstate what stamping keys can buy: the key makes
    // it comparable, and the comparison still needs the owner's drawing.
    expect(classifyUnread({ keyless: true, bookUnreadable: true })).toBe("keylessBookUnreadable");
  });

  it("calls a keyed line whose Desc2 cannot be decoded the OWNER's", () => {
    expect(classifyUnread({ keyless: false, bookUnreadable: true })).toBe("keyedBookUnreadable");
  });

  it("puts anything else in `other` rather than the nearest arm", () => {
    expect(classifyUnread({ keyless: false, bookUnreadable: false })).toBe("other");
  });
});

describe("the report block", () => {
  it("says nothing at all when nothing is unanswerable", () => {
    // A heading over an empty table reads as a finding.
    expect(makeUnreadTally().lines(20)).toEqual([]);
  });

  it("splits proceeded from not, and states what the owner is NOT needed for", () => {
    const t = makeUnreadTally();
    t.record(MECHANICAL, true, "SO-1 a");
    t.record(MECHANICAL, false, "SO-2 b");
    t.record("keyedBookUnreadable", true, "SO-3 c");
    expect(t.total()).toBe(3);
    const out = t.lines(20).join("\n");
    expect(out).toContain("the 3 UNREAD compartment answer(s)");
    expect(out).toContain("2  (1 proceeded, 1 not)");
    expect(out).toContain("=> 2 can be made comparable WITHOUT the owner (stamp the key); 1 cannot");
  });

  it("lists `other` WHOLE and samples the rest — a sampled unknown is not visible", () => {
    const t = makeUnreadTally();
    for (let i = 0; i < 4; i++) t.record("other", true, `SO-other-${i}`);
    for (let i = 0; i < 4; i++) t.record(MECHANICAL, true, `SO-mech-${i}`);
    const out = t.lines(2).join("\n");
    expect(out).toContain("SO-other-3");
    expect(out).not.toContain("SO-mech-3");
    expect(out).toContain("... 2 more");
  });

  it("names every bucket it can count", () => {
    const t = makeUnreadTally();
    for (const k of Object.keys(UNREAD_LABEL)) t.record(k, true, `at ${k}`);
    const out = t.lines(20).join("\n");
    for (const label of Object.values(UNREAD_LABEL)) expect(out).toContain(label);
  });
});
